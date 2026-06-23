"""Live Photo Tool —— Flask 主应用。

提供前端静态页面与 docs/03-api-spec.md 定义的全部 API。
"""
from __future__ import annotations

import threading
from pathlib import Path

from flask import (
    Flask,
    jsonify,
    request,
    send_file,
    send_from_directory,
    abort,
)
from flask_cors import CORS
from werkzeug.utils import secure_filename

import config
from modules import ffmpeg_utils, lut_manager, live_photo
from modules.session_manager import session_manager, Session

config.ensure_dirs()

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = config.MAX_UPLOAD_SIZE_BYTES
CORS(app)


# 支持的色调调整字段，统一范围 -100..100（0 为中性）
_ADJUST_KEYS = ("exposure", "contrast", "highlights", "shadows", "whites", "blacks")


def _samsung_video_dims(w: int, h: int, max_edge: int = 1920) -> tuple[int, int]:
    """三星动态照片内嵌视频的目标分辨率：长边降到 max_edge 以内，保持宽高比且为偶数。"""
    long_edge = max(w, h)
    if long_edge <= 0 or long_edge <= max_edge:
        return (w - w % 2, h - h % 2)
    scale = max_edge / long_edge
    nw = int(round(w * scale))
    nh = int(round(h * scale))
    return (max(2, nw - nw % 2), max(2, nh - nh % 2))


def _parse_adjustments(raw) -> dict:
    """从请求体解析色调调整字典，过滤非法字段并夹紧到 [-100, 100]。"""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key in _ADJUST_KEYS:
        if key in raw:
            try:
                out[key] = max(-100.0, min(100.0, float(raw[key])))
            except (TypeError, ValueError):
                continue
    return out


# ---------------------------------------------------------------------------
# 后台任务：生成代理 + 缩略图
# ---------------------------------------------------------------------------
def _build_proxy_async(session: Session) -> None:
    """后台线程：生成代理文件与时间轴缩略图，更新会话状态。"""
    try:
        session.proxy_progress = 10
        ffmpeg_utils.generate_proxy(session.original_path, session.proxy_path)
        session.proxy_progress = 70
        ffmpeg_utils.generate_thumbnails(session.original_path, session.thumbnails_dir)
        session.proxy_progress = 100
        session.status = "ready"
    except Exception as exc:  # noqa: BLE001
        session.status = "error"
        session.error = str(exc)


# ---------------------------------------------------------------------------
# 前端静态文件
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(config.STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename: str):
    target = config.STATIC_DIR / filename
    if not target.exists() or not target.is_file():
        abort(404)
    return send_from_directory(config.STATIC_DIR, filename)


# ---------------------------------------------------------------------------
# 1. 上传视频
# ---------------------------------------------------------------------------
@app.post("/api/upload")
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "缺少文件"}), 400

    ext = Path(file.filename).suffix.lower()
    if ext not in config.ALLOWED_VIDEO_EXT:
        return jsonify({"error": f"不支持的格式: {ext}"}), 400

    session = session_manager.create()
    session.filename = secure_filename(file.filename)
    session.source_ext = ext  # 决定 original_path 的扩展名
    file.save(session.original_path)

    # 读取元数据
    try:
        meta = ffmpeg_utils.probe(session.original_path)
    except ffmpeg_utils.FFmpegError as exc:
        session_manager.delete(session.session_id)
        return jsonify({"error": f"文件损坏或无法解析: {exc}"}), 400

    session.duration = meta["duration"]
    session.width = meta["width"]
    session.height = meta["height"]
    session.fps = meta["fps"]

    # 后台生成代理
    threading.Thread(
        target=_build_proxy_async, args=(session,), daemon=True
    ).start()

    return jsonify(
        {
            "session_id": session.session_id,
            "filename": session.filename,
            "duration": session.duration,
            "width": session.width,
            "height": session.height,
            "fps": session.fps,
            "status": session.status,
        }
    )


# ---------------------------------------------------------------------------
# 2. 查询会话状态
# ---------------------------------------------------------------------------
@app.get("/api/session/<session_id>/status")
def session_status(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        return jsonify({"error": "会话不存在"}), 404
    return jsonify(session.to_status_dict())


# ---------------------------------------------------------------------------
# 3. 代理视频流（支持 Range，由 send_file 处理）
# ---------------------------------------------------------------------------
@app.get("/api/session/<session_id>/proxy")
def proxy_stream(session_id: str):
    session = session_manager.get(session_id)
    if session is None or not session.proxy_path.exists():
        abort(404)
    return send_file(
        session.proxy_path, mimetype="video/mp4", conditional=True
    )


# ---------------------------------------------------------------------------
# 4. 时间轴缩略图
# ---------------------------------------------------------------------------
@app.get("/api/session/<session_id>/thumbnails")
def thumbnails_list(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        return jsonify({"error": "会话不存在"}), 404

    files = sorted(session.thumbnails_dir.glob("*.jpg"))
    items = []
    for i, f in enumerate(files, start=1):
        items.append(
            {
                "index": i,
                "time": float(i - 1) / config.THUMBNAIL_FPS,
                "url": f"/api/session/{session_id}/thumbnails/{f.name}",
            }
        )
    return jsonify(
        {
            "count": len(items),
            "fps_sample": config.THUMBNAIL_FPS,
            "width": config.THUMBNAIL_WIDTH,
            "height": config.THUMBNAIL_HEIGHT,
            "items": items,
        }
    )


@app.get("/api/session/<session_id>/thumbnails/<filename>")
def thumbnail_file(session_id: str, filename: str):
    session = session_manager.get(session_id)
    if session is None:
        abort(404)
    safe = secure_filename(filename)
    target = session.thumbnails_dir / safe
    if not target.exists():
        abort(404)
    return send_file(target, mimetype="image/jpeg", conditional=True)


# ---------------------------------------------------------------------------
# 5. LUT 列表
# ---------------------------------------------------------------------------
@app.get("/api/luts")
def luts_list():
    session_id = request.args.get("session_id")
    session = session_manager.get(session_id) if session_id else None
    return jsonify({"luts": lut_manager.list_luts(session)})


# ---------------------------------------------------------------------------
# 6. 上传自定义 LUT
# ---------------------------------------------------------------------------
@app.post("/api/session/<session_id>/lut/upload")
def upload_lut(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        return jsonify({"error": "会话不存在"}), 404

    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "缺少文件"}), 400
    if Path(file.filename).suffix.lower() not in config.ALLOWED_LUT_EXT:
        return jsonify({"error": "仅支持 .cube 文件"}), 400

    tmp = session.custom_luts_dir / ("_upload_" + secure_filename(file.filename))
    file.save(tmp)
    try:
        info = lut_manager.register_custom_lut(session, file.filename, tmp)
    except ValueError as exc:
        return jsonify({"error": str(exc), "valid": False}), 400
    finally:
        tmp.unlink(missing_ok=True)

    return jsonify({**info, "valid": True})


# ---------------------------------------------------------------------------
# 7. 预览帧
# ---------------------------------------------------------------------------
@app.post("/api/session/<session_id>/preview-frame")
def preview_frame(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        return jsonify({"error": "会话不存在"}), 404

    body = request.get_json(silent=True) or {}
    time_point = float(body.get("time", 0.0))
    lut_id = body.get("lut_id")
    intensity = float(body.get("lut_intensity", 1.0))
    adjustments = _parse_adjustments(body.get("adjustments"))

    lut_path = lut_manager.resolve_lut_path(lut_id, session) if lut_id else None
    out = session.work_dir / "preview.jpg"
    try:
        ffmpeg_utils.render_preview_frame(
            session.original_path, time_point, lut_path, out,
            intensity=intensity, adjustments=adjustments,
        )
    except ffmpeg_utils.FFmpegError as exc:
        return jsonify({"error": str(exc)}), 500

    return send_file(out, mimetype="image/jpeg")


# ---------------------------------------------------------------------------
# 7b. 预览选区片段（弹框用）
# ---------------------------------------------------------------------------
@app.post("/api/session/<session_id>/preview-clip")
def preview_clip(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        return jsonify({"error": "会话不存在"}), 404

    body = request.get_json(silent=True) or {}
    try:
        in_point = float(body["in_point"])
        out_point = float(body["out_point"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "参数缺失或类型错误"}), 400

    duration = out_point - in_point
    if duration <= 0:
        return jsonify({"error": "out_point 必须大于 in_point"}), 400
    if duration > config.MAX_CLIP_DURATION:
        return jsonify({"error": f"片段时长不能超过 {config.MAX_CLIP_DURATION} 秒"}), 400

    lut_id = body.get("lut_id")
    intensity = float(body.get("lut_intensity", 1.0))
    adjustments = _parse_adjustments(body.get("adjustments"))

    lut_path = lut_manager.resolve_lut_path(lut_id, session) if lut_id else None
    out = session.work_dir / "preview_clip.mp4"
    try:
        ffmpeg_utils.render_preview_clip(
            session.original_path, in_point, duration, lut_path, out,
            intensity=intensity, adjustments=adjustments,
        )
    except ffmpeg_utils.FFmpegError as exc:
        return jsonify({"error": str(exc)}), 500

    return send_file(out, mimetype="video/mp4")


# ---------------------------------------------------------------------------
# 8. 导出 Live Photo
# ---------------------------------------------------------------------------
@app.post("/api/session/<session_id>/export")
def export(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        return jsonify({"error": "会话不存在"}), 404

    body = request.get_json(silent=True) or {}
    try:
        in_point = float(body["in_point"])
        out_point = float(body["out_point"])
        cover_time = float(body["cover_time"])
        lut_id = body["lut_id"]
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "参数缺失或类型错误"}), 400

    intensity = float(body.get("lut_intensity", 1.0))
    adjustments = _parse_adjustments(body.get("adjustments"))
    output_name = secure_filename(body.get("output_name") or "IMG_0001")
    fmt = (body.get("format") or "apple").lower()
    if fmt not in ("apple", "samsung"):
        return jsonify({"error": "format 必须为 apple 或 samsung"}), 400

    # 约束验证
    duration = out_point - in_point
    if duration <= 0:
        return jsonify({"error": "out_point 必须大于 in_point"}), 400
    if duration > config.MAX_CLIP_DURATION:
        return jsonify({"error": f"片段时长不能超过 {config.MAX_CLIP_DURATION} 秒"}), 400
    if not (in_point <= cover_time <= out_point):
        return jsonify({"error": "cover_time 必须在 [in_point, out_point] 范围内"}), 400

    lut_path = lut_manager.resolve_lut_path(lut_id, session) if lut_id else None
    out_dir = session.output_dir
    cover_png = out_dir / "cover.png"

    try:
        if fmt == "samsung":
            # 三星/谷歌 Motion Photo：单个 JPEG（封面 + 末尾 SEF trailer 内嵌 MP4）
            # 文件名以 "MV" 开头才能在 Google Gallery 正常播放（三星 Gallery 靠 SEF 识别）
            mv_name = output_name if output_name.startswith("MV") else "MV" + output_name
            mp4_path = out_dir / f"{mv_name}.mp4"
            jpg_path = out_dir / f"{mv_name}.jpg"
            # 三星 Gallery 内联播放器对内嵌视频较挑：降采样（长边 ≤ 1920）+ mp42 容器，
            # 贴近真机动态照片（视频降采样、静态封面保持全分辨率）。
            vw, vh = _samsung_video_dims(session.width, session.height)
            ffmpeg_utils.export_clip(
                session.original_path, in_point, duration, lut_path,
                mp4_path, vw, vh,
                intensity=intensity, adjustments=adjustments, brand="mp42",
            )
            ffmpeg_utils.extract_cover(
                session.original_path, cover_time, lut_path, cover_png,
                intensity=intensity, adjustments=adjustments,
            )
            ts_us = int(max(0.0, cover_time - in_point) * 1_000_000)
            live_photo.create_motion_photo(cover_png, mp4_path, jpg_path, ts_us)
            return send_file(
                jpg_path,
                mimetype="image/jpeg",
                as_attachment=True,
                download_name=f"{mv_name}.jpg",
            )

        # Apple Live Photo：HEIC + MOV，共享 ContentIdentifier，打包 ZIP
        mov_path = out_dir / f"{output_name}.mov"
        heic_path = out_dir / f"{output_name}.heic"
        zip_path = out_dir / f"{output_name}.zip"

        content_id = live_photo.new_content_identifier()
        ffmpeg_utils.export_clip(
            session.original_path, in_point, duration, lut_path,
            mov_path, session.width, session.height,
            intensity=intensity, adjustments=adjustments,
        )
        ffmpeg_utils.extract_cover(
            session.original_path, cover_time, lut_path, cover_png,
            intensity=intensity, adjustments=adjustments,
        )
        live_photo.inject_mov_content_id(mov_path, content_id)
        cover_out = live_photo.png_to_heic(cover_png, heic_path, content_id)
        live_photo.pack_zip(zip_path, [cover_out, mov_path], output_name)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"导出失败: {exc}"}), 500

    return send_file(
        zip_path,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{output_name}.zip",
    )


# ---------------------------------------------------------------------------
# 9. 删除会话
# ---------------------------------------------------------------------------
@app.delete("/api/session/<session_id>")
def delete_session(session_id: str):
    deleted = session_manager.delete(session_id)
    return jsonify({"deleted": deleted})


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": f"文件超过 {config.MAX_UPLOAD_SIZE_GB}GB 限制"}), 413


if __name__ == "__main__":
    session_manager.start_cleanup_thread()
    app.run(host=config.HOST, port=config.PORT, threaded=True)
