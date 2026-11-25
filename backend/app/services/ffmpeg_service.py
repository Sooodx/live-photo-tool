"""FFmpeg processing and shared color grading for previews and exports."""

import json
import logging
import math
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Callable

from app.config import PROXY_MAX_EDGE, THUMBNAIL_FPS, THUMBNAIL_HEIGHT
from app.schemas import VideoMetadata
from app.services.session_manager import Session

logger = logging.getLogger(__name__)
_FFMPEG = ["ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-y"]
_MAP_VIDEO = ["-map", "0:v:0"]
_MAP_MEDIA = [*_MAP_VIDEO, "-map", "0:a:0?"]


class FFmpegError(RuntimeError):
    """A media tool failed or returned invalid output."""


def _run(command: list[str]) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as exc:
        raise FFmpegError(f"{command[0]}: {exc.stderr.strip()[-4000:]}") from exc
    except OSError as exc:
        raise FFmpegError(f"Cannot run {command[0]}") from exc
    return result.stdout


def probe(path: Path) -> VideoMetadata:
    output = _run([
        "ffprobe", "-v", "error",
        "-show_entries",
        "stream=codec_type,width,height,avg_frame_rate,duration:stream_side_data=rotation:format=duration",
        "-of", "json", str(path),
    ])
    try:
        data = json.loads(output)
        streams = data["streams"]
        video = next(stream for stream in streams if stream["codec_type"] == "video")
        width, height = video["width"], video["height"]
        for side_data in video.get("side_data_list", ()):
            if abs(side_data.get("rotation", 0)) % 180 == 90:
                width, height = height, width
                break
        duration_value = video.get("duration")
        if duration_value in (None, "N/A"):
            duration_value = data["format"]["duration"]
        duration = float(duration_value)
        if width < 1 or height < 1 or not math.isfinite(duration) or duration <= 0:
            raise ValueError("Invalid video dimensions or duration")
        rate = video.get("avg_frame_rate", "0/0")
        return VideoMetadata(
            width=width,
            height=height,
            fps=round(float(Fraction(rate)), 3) if rate != "0/0" else 0,
            duration=duration,
            has_audio=any(stream["codec_type"] == "audio" for stream in streams),
        )
    except (KeyError, StopIteration, TypeError, ValueError, ZeroDivisionError) as exc:
        raise FFmpegError("Invalid video metadata") from exc


def video_dimensions(video: VideoMetadata, max_edge: int | None = None) -> tuple[int, int]:
    long_edge = max(video.width, video.height)
    scale = min(1.0, max_edge / long_edge) if max_edge is not None else 1.0
    width, height = round(video.width * scale), round(video.height * scale)
    return max(2, width - width % 2), max(2, height - height % 2)


def thumbnail_width(video: VideoMetadata) -> int:
    return max(2, 2 * round(video.width * THUMBNAIL_HEIGHT / (2 * video.height)))


def _run_with_progress(
    command: list[str], duration: float, on_progress: Callable[[int], None]
) -> None:
    # A file lets FFmpeg write stderr without blocking while we read stdout.
    with tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(
                [*_FFMPEG, "-progress", "pipe:1", "-nostats", "-stats_period", "0.05", *command],
                stdout=subprocess.PIPE, stderr=errors, text=True,
            )
        except OSError as exc:
            raise FFmpegError("Cannot run ffmpeg") from exc

        progress = 0
        with process, process.stdout as output:
            for line in output:
                key, _, value = line.strip().partition("=")
                # Both fields report microseconds, including the legacy out_time_ms.
                if key in {"out_time_us", "out_time_ms"} and value.lstrip("-").isdigit():
                    percent = min(100, int(int(value) / (duration * 1_000_000) * 100))
                    if percent > progress:
                        progress = percent
                        on_progress(progress)
            if process.wait():
                errors.seek(0, 2)
                errors.seek(max(0, errors.tell() - 4000))
                raise FFmpegError(errors.read().decode(errors="replace").strip())


def generate_proxy(
    src: Path, dst: Path, video: VideoMetadata, on_progress: Callable[[int], None]
) -> None:
    width, height = video_dimensions(video, PROXY_MAX_EDGE)
    _run_with_progress([
        "-i", str(src), *_MAP_MEDIA, "-vf", f"scale={width}:{height}",
        "-c:v", "libx264", "-crf", "23", "-preset", "fast", "-tune", "fastdecode",
        "-pix_fmt", "yuv420p", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0",
        "-bf", "0", "-c:a", "aac", "-b:a", "96k", "-write_tmcd", "0",
        "-movflags", "+faststart", str(dst),
    ], video.duration, on_progress)


def generate_thumbnails(
    src: Path, dst_dir: Path, video: VideoMetadata, on_progress: Callable[[int], None]
) -> None:
    dst_dir.mkdir()
    width = thumbnail_width(video)
    _run_with_progress([
        "-i", str(src), *_MAP_VIDEO,
        "-vf", f"fps={THUMBNAIL_FPS}:start_time=0:round=up,scale={width}:{THUMBNAIL_HEIGHT}",
        "-q:v", "5", str(dst_dir / "%04d.jpg"),
    ], video.duration, on_progress)


def process_session(session: Session) -> None:
    try:
        with tempfile.TemporaryDirectory(prefix="processing-", dir=session.work_dir) as temporary:
            work_dir = Path(temporary)
            proxy = work_dir / session.proxy_path.name
            thumbnails = work_dir / session.thumbnails_dir.name
            generate_proxy(
                session.original_path, proxy, session.video,
                lambda percent: session.update_status(proxy_progress=percent * 80 // 100),
            )
            proxy.replace(session.proxy_path)
            session.update_status(stage="thumbnails", proxy_progress=80)
            generate_thumbnails(
                session.original_path, thumbnails, session.video,
                lambda percent: session.update_status(proxy_progress=80 + percent * 20 // 100),
            )
            thumbnails.replace(session.thumbnails_dir)
        session.update_status(status="ready", stage="ready", proxy_progress=100)
    except Exception:
        logger.exception("Proxy or thumbnail generation failed for session %s", session.session_id)
        session.update_status(status="error", stage="error", error="代理视频或缩略图生成失败")


def render_image(
    src: Path,
    timestamp: float,
    lut_path: Path | None,
    dst: Path,
    *,
    intensity: float,
    adjustments: dict | None,
    video_duration: float,
    dimensions: tuple[int | None, int | None] = (None, None),
) -> None:
    vf = build_video_filter(lut_path, intensity, adjustments, *dimensions)
    options = ["-pix_fmt", "yuvj420p", "-q:v", "2"] if dst.suffix == ".jpg" else []
    tail_start = max(0, video_duration - 1)

    def write_frame(seek: float, filters: str) -> None:
        _run([
            *_FFMPEG, "-ss", f"{seek:.6f}", "-i", str(src), *_MAP_VIDEO,
            "-vf", filters, "-frames:v", "1", *options, "-update", "1", str(dst),
        ])

    if timestamp < video_duration:
        try:
            write_frame(timestamp, vf)
        except FFmpegError:
            if timestamp < tail_start:
                raise
        else:
            if dst.is_file():
                return

    # An accurate seek after the last frame timestamp yields no frame.
    window = 1
    while True:
        write_frame(tail_start, f"reverse,{vf}")
        if dst.is_file():
            return
        if tail_start == 0:
            raise FFmpegError("No video frame at the requested time")
        window *= 2
        tail_start = max(0, video_duration - window)


def render_clip(
    src: Path,
    in_point: float,
    duration: float,
    lut_path: Path | None,
    dst: Path,
    *,
    dimensions: tuple[int, int],
    video_duration: float,
    intensity: float,
    adjustments: dict | None,
    preview: bool = False,
    brand: str | None = None,
) -> None:
    vf = build_video_filter(lut_path, intensity, adjustments, *dimensions)
    encoding = (
        ["-crf", "23", "-preset", "fast", "-b:a", "96k"] if preview else
        ["-profile:v", "high", "-crf", "18", "-preset", "slow", "-b:a", "128k"]
    )
    seek = ["-ss", f"{in_point:.6f}", "-i", str(src)]
    output = [
        "-t", f"{max(duration, 0.000001):.6f}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        *encoding, "-write_tmcd", "0",
    ]
    if brand:
        output.extend(["-brand", brand])
    output.extend(["-movflags", "+faststart", str(dst)])
    _run([*_FFMPEG, *seek, *_MAP_MEDIA, "-vf", vf, *output])

    if _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=index", "-of", "csv=p=0", str(dst),
    ]).strip():
        return

    # A cut between frame timestamps can leave a file with only audio or no streams.
    with tempfile.TemporaryDirectory(dir=dst.parent) as directory:
        still = Path(directory) / "frame.png"
        render_image(
            src, in_point, lut_path, still, intensity=intensity, adjustments=adjustments,
            video_duration=video_duration, dimensions=dimensions,
        )
        _run([*_FFMPEG, "-loop", "1", "-i", str(still), *seek, *_MAP_VIDEO, "-map", "1:a:0?", *output])


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _lut3d_filter(lut_path: Path) -> str:
    """Escape the LUT path for both the filter options and the graph parser."""

    def escape(value: str, special: str) -> str:
        return "".join("\\" + char if char in special else char for char in value)

    option = escape(str(lut_path.resolve()), "\\':")
    return "lut3d=file=" + escape(option, "\\'[],;")


def _build_tone_curve(adj: dict) -> str | None:
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


def _tone_filters(adj: dict | None) -> list[str]:
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
    lut_path: Path | None,
    intensity: float,
    adjustments: dict | None,
    scale_w: int | None,
    scale_h: int | None,
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
