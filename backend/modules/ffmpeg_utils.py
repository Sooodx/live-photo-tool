"""FFmpeg / ffprobe 调用封装。

所有视频处理通过 subprocess 调用系统的 ffmpeg / ffprobe 完成。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Optional

from config import (
    PROXY_WIDTH,
    PROXY_HEIGHT,
    PROXY_CRF,
    THUMBNAIL_WIDTH,
    THUMBNAIL_HEIGHT,
    THUMBNAIL_FPS,
)


class FFmpegError(RuntimeError):
    """FFmpeg 执行失败。"""


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    """运行命令，失败时抛出 FFmpegError（附带 stderr）。"""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(
            f"命令失败 (exit {proc.returncode}): {' '.join(cmd)}\n{proc.stderr[-4000:]}"
        )
    return proc


def probe(video_path: Path) -> dict:
    """读取视频元数据：duration / width / height / fps。"""
    cmd = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate:format=duration",
        "-of", "json",
        str(video_path),
    ]
    proc = _run(cmd)
    data = json.loads(proc.stdout)

    stream = (data.get("streams") or [{}])[0]
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)

    # avg_frame_rate 形如 "25/1"
    fps = 0.0
    rate = stream.get("avg_frame_rate", "0/0")
    try:
        num, den = rate.split("/")
        fps = round(float(num) / float(den), 3) if float(den) else 0.0
    except (ValueError, ZeroDivisionError):
        fps = 0.0

    duration = float((data.get("format") or {}).get("duration") or 0.0)

    return {"width": width, "height": height, "fps": fps, "duration": round(duration, 3)}


def generate_proxy(src: Path, dst: Path) -> None:
    """生成低分辨率代理文件（960x540, H.264 CRF 23, 无音频）。"""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src),
        "-vf", f"scale={PROXY_WIDTH}:{PROXY_HEIGHT}",
        "-c:v", "libx264", "-crf", str(PROXY_CRF), "-preset", "fast",
        "-movflags", "+faststart",
        "-an",
        str(dst),
    ]
    _run(cmd)


def generate_thumbnails(src: Path, dst_dir: Path) -> int:
    """生成时间轴缩略图（每秒 1 帧, 160x90）。返回生成的图片数量。"""
    dst_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src),
        "-vf", f"fps={THUMBNAIL_FPS},scale={THUMBNAIL_WIDTH}:{THUMBNAIL_HEIGHT}",
        "-q:v", "5",
        str(dst_dir / "%04d.jpg"),
    ]
    _run(cmd)
    return len(list(dst_dir.glob("*.jpg")))


def render_preview_frame(
    src: Path,
    timestamp: float,
    lut_path: Optional[Path],
    dst: Path,
    intensity: float = 1.0,
    adjustments: Optional[dict] = None,
    width: int = PROXY_WIDTH,
    height: int = PROXY_HEIGHT,
) -> None:
    """渲染指定时间点的单帧，套 LUT + 色调调整后输出 JPEG（默认代理分辨率，快速预览）。"""
    vf = build_video_filter(lut_path, intensity, adjustments, width, height)
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{timestamp}",
        "-i", str(src),
        "-vf", vf,
        "-vframes", "1",
        "-q:v", "2",
        str(dst),
    ]
    _run(cmd)


def export_clip(
    src: Path,
    in_point: float,
    duration: float,
    lut_path: Optional[Path],
    dst: Path,
    out_width: int,
    out_height: int,
    intensity: float = 1.0,
    adjustments: Optional[dict] = None,
    brand: Optional[str] = None,
) -> None:
    """导出选中片段（套 LUT + 色调调整），H.264 + AAC。

    brand：指定 MP4 major brand（如 "mp42"），用于贴近三星动态照片视频容器。
    """
    vf = build_video_filter(lut_path, intensity, adjustments, out_width, out_height)
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{in_point}",
        "-i", str(src),
        "-t", f"{duration}",
        "-vf", vf,
        "-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-preset", "slow",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
    ]
    if brand:
        cmd += ["-brand", brand]
    cmd += ["-movflags", "+faststart", str(dst)]
    _run(cmd)


def render_preview_clip(
    src: Path,
    in_point: float,
    duration: float,
    lut_path: Optional[Path],
    dst: Path,
    intensity: float = 1.0,
    adjustments: Optional[dict] = None,
    width: int = PROXY_WIDTH,
    height: int = PROXY_HEIGHT,
) -> None:
    """渲染选区片段为轻量代理 MP4（套 LUT + 色调调整），用于弹框预览。

    与导出保持相同的色彩管线（build_video_filter），但用代理分辨率 + 较高 CRF +
    快 preset + 无音频，以求快速生成（片段 ≤3s）。
    """
    vf = build_video_filter(lut_path, intensity, adjustments, width, height)
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{in_point}",
        "-i", str(src),
        "-t", f"{duration}",
        "-vf", vf,
        "-c:v", "libx264", "-crf", str(PROXY_CRF), "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-an",
        "-movflags", "+faststart",
        str(dst),
    ]
    _run(cmd)


def extract_cover(
    src: Path,
    frame_time: float,
    lut_path: Optional[Path],
    dst: Path,
    intensity: float = 1.0,
    adjustments: Optional[dict] = None,
) -> None:
    """提取封面帧为 PNG（套 LUT + 色调调整，全分辨率），后续转 HEIC。"""
    vf = build_video_filter(lut_path, intensity, adjustments, None, None)
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{frame_time}",
        "-i", str(src),
    ]
    if vf and vf != "null":
        cmd += ["-vf", vf]
    cmd += ["-vframes", "1", str(dst)]
    _run(cmd)


# ---------------------------------------------------------------------------
# 滤镜链构造：LUT（可调强度） + 色调调整 + 缩放
# ---------------------------------------------------------------------------
def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _lut3d_filter(lut_path: Path) -> str:
    """构造 lut3d 滤镜片段（POSIX 路径，单引号包裹）。"""
    posix = str(lut_path).replace("\\", "/")
    return f"lut3d=file='{posix}'"


def _build_tone_curve(adj: dict) -> Optional[str]:
    """根据高光/阴影/白色/黑色四个分区参数构造 curves 滤镜。

    每个参数为 -100..100（0 为中性）。通过 5 个控制点近似 Lightroom 风格的分区色调：
      黑色 → 影响最暗端，阴影 → 暗部，高光 → 亮部，白色 → 最亮端。
    最终强制单调不减，避免色调反转。
    """
    h = _clamp(adj.get("highlights", 0) / 100.0, -1.0, 1.0)
    s = _clamp(adj.get("shadows", 0) / 100.0, -1.0, 1.0)
    w = _clamp(adj.get("whites", 0) / 100.0, -1.0, 1.0)
    b = _clamp(adj.get("blacks", 0) / 100.0, -1.0, 1.0)
    if all(abs(v) < 1e-3 for v in (h, s, w, b)):
        return None

    xs = [0.0, 0.25, 0.5, 0.75, 1.0]
    ys = [
        0.00 + b * 0.10,
        0.25 + s * 0.15 + b * 0.10,
        0.50 + s * 0.05 + h * 0.05,
        0.75 + h * 0.15 + w * 0.10,
        1.00 + w * 0.10,
    ]

    pts = []
    prev = -1.0
    for x, y in zip(xs, ys):
        y = _clamp(y, 0.0, 1.0)
        if y < prev:  # 保证曲线单调不减
            y = prev
        prev = y
        pts.append(f"{x:g}/{y:.4f}")
    return "curves=all='" + " ".join(pts) + "'"


def _tone_filters(adj: Optional[dict]) -> list[str]:
    """把色调调整字典转为 FFmpeg 滤镜片段列表（顺序：曝光 → 对比度 → 分区曲线）。"""
    if not adj:
        return []
    parts: list[str] = []

    # 曝光：滑块 ±100 映射到 ±2 EV（exposure 滤镜以光圈级 stops 为单位）
    ev = _clamp(adj.get("exposure", 0) / 100.0 * 2.0, -3.0, 3.0)
    if abs(ev) > 1e-3:
        parts.append(f"exposure=exposure={ev:.4f}")

    # 对比度：滑块 ±100 映射到 eq contrast 0..2（1.0 为中性）
    contrast = _clamp(1.0 + adj.get("contrast", 0) / 100.0, 0.0, 2.0)
    if abs(contrast - 1.0) > 1e-3:
        parts.append(f"eq=contrast={contrast:.4f}")

    curve = _build_tone_curve(adj)
    if curve:
        parts.append(curve)

    return parts


def build_video_filter(
    lut_path: Optional[Path],
    intensity: float,
    adjustments: Optional[dict],
    scale_w: Optional[int],
    scale_h: Optional[int],
) -> str:
    """构造完整 -vf 字符串：LUT（按强度混合） → 色调调整 → 可选缩放。

    强度 1.0 直接套 LUT；0 < 强度 < 1 用 split+blend 与原图混合；强度 0 或无 LUT 时跳过 LUT。
    """
    intensity = _clamp(float(intensity), 0.0, 1.0)

    post = _tone_filters(adjustments)
    if scale_w and scale_h:
        post.append(f"scale={scale_w}:{scale_h}")
    post_str = ("," + ",".join(post)) if post else ""

    # 不套 LUT（无 LUT 或强度为 0）
    if lut_path is None or intensity <= 1e-4:
        return ",".join(post) if post else "null"

    lut = _lut3d_filter(lut_path)

    # 完全套用
    if intensity >= 1.0 - 1e-4:
        return lut + post_str

    # 部分强度：原图与套 LUT 后的画面按 opacity 混合
    #   out = original*(1-i) + luted*i
    graph = (
        "split=2[tn0][tn1];"
        f"[tn1]{lut}[tn1l];"
        f"[tn1l][tn0]blend=all_mode=normal:all_opacity={intensity:.4f}"
    )
    return graph + post_str
