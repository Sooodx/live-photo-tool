"""Grade source media for frame previews, clip previews and downloads."""

import logging
import re
import shutil
import tempfile
from decimal import Decimal
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from app.config import PROXY_MAX_EDGE
from app.routers.luts import LutServiceDep
from app.routers.sessions import SessionDep
from app.schemas import ExportRequest, GradeRequest, PreviewClipRequest, PreviewFrameRequest
from app.services import ffmpeg_service, live_photo_service
from app.services.lut_service import LutService
from app.services.session_manager import Session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/session/{session_id}")


def _clip_duration(body: PreviewClipRequest, video_duration: float) -> float:
    if not 0 <= body.in_point < body.out_point <= video_duration:
        raise HTTPException(400, "片段范围必须满足 0 <= in_point < out_point <= 视频时长")
    return float(Decimal(str(body.out_point)) - Decimal(str(body.in_point)))


def _grade(body: GradeRequest, service: LutService, session: Session) -> dict:
    return {
        "lut_path": service.resolve(body.lut_id, session),
        "intensity": body.lut_intensity,
        "adjustments": body.adjustments.model_dump() if body.adjustments is not None else None,
    }


@router.post("/preview-frame", response_class=Response,
             responses={200: {"content": {"image/jpeg": {}}}})
def preview_frame(
    session: SessionDep, service: LutServiceDep,
    body: PreviewFrameRequest = Body(default_factory=PreviewFrameRequest),
) -> Response:
    grade = _grade(body, service, session)
    with tempfile.TemporaryDirectory(prefix="frame-", dir=session.output_dir) as directory:
        path = Path(directory) / "preview.jpg"
        try:
            ffmpeg_service.render_image(
                session.original_path, body.time, dst=path, video_duration=session.video.duration,
                dimensions=ffmpeg_service.video_dimensions(session.video, PROXY_MAX_EDGE),
                **grade,
            )
        except ffmpeg_service.FFmpegError as exc:
            logger.exception("Frame preview failed for session %s", session.session_id)
            raise HTTPException(500, "预览帧生成失败") from exc
        return Response(path.read_bytes(), media_type="image/jpeg")


@router.post("/preview-clip", response_class=FileResponse,
             responses={200: {"content": {"video/mp4": {}}}})
def preview_clip(
    session: SessionDep, service: LutServiceDep, body: PreviewClipRequest
) -> FileResponse:
    duration = _clip_duration(body, session.video.duration)
    grade = _grade(body, service, session)
    directory = Path(tempfile.mkdtemp(prefix="clip-", dir=session.output_dir))
    path = directory / "preview.mp4"
    try:
        ffmpeg_service.render_clip(
            session.original_path, body.in_point, duration, dst=path, preview=True,
            dimensions=ffmpeg_service.video_dimensions(session.video, PROXY_MAX_EDGE),
            video_duration=session.video.duration,
            **grade,
        )
    except BaseException as exc:
        shutil.rmtree(directory)
        if isinstance(exc, ffmpeg_service.FFmpegError):
            logger.exception("Clip preview failed for session %s", session.session_id)
            raise HTTPException(500, "预览片段生成失败") from exc
        raise
    return FileResponse(
        path, media_type="video/mp4", background=BackgroundTask(shutil.rmtree, directory)
    )


def _render_export(
    session: Session, service: LutService, body: ExportRequest, duration: float, directory: Path
) -> tuple[Path, str]:
    grade = _grade(body, service, session)
    name = re.sub(r"[^a-zA-Z0-9_-]", "", body.output_name)[:120] or "IMG_0001"
    samsung = body.format == "samsung"
    if samsung and not name.startswith("MV"):
        name = "MV" + name
    clip = directory / (name + (".mp4" if samsung else ".mov"))
    cover = directory / "cover.png"
    dimensions = ffmpeg_service.video_dimensions(session.video, 1920 if samsung else None)

    ffmpeg_service.render_clip(
        session.original_path, body.in_point, duration, dst=clip,
        dimensions=dimensions, video_duration=session.video.duration,
        brand="mp42" if samsung else None, **grade,
    )
    ffmpeg_service.render_image(
        session.original_path, body.cover_time, dst=cover, video_duration=session.video.duration,
        **grade,
    )

    if samsung:
        path = directory / f"{name}.jpg"
        presentation_ts_us = int((Decimal(str(body.cover_time)) - Decimal(str(body.in_point))) * 1_000_000)
        live_photo_service.create_motion_photo(cover, clip, path, presentation_ts_us)
        return path, "image/jpeg"

    content_id = live_photo_service.new_content_identifier()
    live_photo_service.inject_mov_content_id(clip, content_id)
    image = live_photo_service.png_to_heic(cover, directory / f"{name}.heic", content_id)
    path = live_photo_service.pack_zip(directory / f"{name}.zip", [image, clip], name)
    return path, "application/zip"


@router.post("/export", response_class=FileResponse,
             responses={200: {"content": {"application/zip": {}, "image/jpeg": {}}}})
def export(session: SessionDep, service: LutServiceDep, body: ExportRequest) -> FileResponse:
    duration = _clip_duration(body, session.video.duration)
    if not body.in_point <= body.cover_time <= body.out_point:
        raise HTTPException(400, "cover_time 必须在 [in_point, out_point] 范围内")

    directory = Path(tempfile.mkdtemp(prefix="export-", dir=session.output_dir))
    try:
        path, media_type = _render_export(session, service, body, duration, directory)
    except Exception as exc:
        shutil.rmtree(directory)
        logger.exception("Export failed for session %s", session.session_id)
        raise HTTPException(500, "导出失败") from exc
    return FileResponse(
        path, media_type=media_type, filename=path.name,
        background=BackgroundTask(shutil.rmtree, directory),
    )
