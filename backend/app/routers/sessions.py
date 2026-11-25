"""Upload, progress and media access for editing sessions."""

import asyncio
import re
from pathlib import Path
from typing import Annotated, Iterator

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.config import THUMBNAIL_FPS, Settings
from app.schemas import DeleteResponse, SessionStatus, ThumbnailItem, ThumbnailsResponse, UploadResponse
from app.services import ffmpeg_service
from app.services.session_manager import Session, SessionManager, UploadTooLarge, copy_upload

router = APIRouter(prefix="/api")
_THUMBNAIL_NAME = re.compile(r"[0-9]{4,}\.jpg")


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_manager(request: Request) -> SessionManager:
    return request.app.state.sessions


def require_session(
    session_id: str, manager: Annotated[SessionManager, Depends(get_manager)]
) -> Iterator[Session]:
    with manager.borrow(session_id) as session:
        if session is None:
            raise HTTPException(404, "会话不存在")
        yield session


SettingsDep = Annotated[Settings, Depends(get_settings)]
ManagerDep = Annotated[SessionManager, Depends(get_manager)]
SessionDep = Annotated[Session, Depends(require_session)]
Upload = Annotated[UploadFile, File()]


def upload_filename(file: UploadFile) -> str:
    return (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]


def _prepare_upload(
    manager: SessionManager, settings: Settings, file: UploadFile, name: str, extension: str
) -> Session:
    with manager.new_workspace(name, extension) as session:
        copy_upload(file.file, session.original_path, settings.max_upload_size_bytes)
        session.video = ffmpeg_service.probe(session.original_path)
    return session


def _process_upload(manager: SessionManager, session_id: str) -> None:
    with manager.borrow(session_id) as session:
        if session is not None:
            ffmpeg_service.process_session(session)


@router.post("/upload")
async def upload(
    request: Request, file: Upload, manager: ManagerDep, settings: SettingsDep
) -> UploadResponse:
    name = upload_filename(file)
    extension = Path(name).suffix.lower()
    if extension not in {".mp4", ".mov"}:
        raise HTTPException(400, "仅支持 .mp4 和 .mov 文件")
    try:
        session = await run_in_threadpool(_prepare_upload, manager, settings, file, name, extension)
    except UploadTooLarge as exc:
        raise HTTPException(413, f"文件超过 {settings.max_upload_size_gb:g}GB 限制") from exc
    except ffmpeg_service.FFmpegError as exc:
        raise HTTPException(400, "文件损坏或无法解析") from exc
    manager.register(session)
    jobs: set[asyncio.Task] = request.app.state.processing_jobs
    task = asyncio.create_task(run_in_threadpool(_process_upload, manager, session.session_id))
    jobs.add(task)
    task.add_done_callback(jobs.discard)
    return UploadResponse(
        session_id=session.session_id, filename=session.filename, **session.video.model_dump()
    )


@router.get("/session/{session_id}/status")
def session_status(session: SessionDep) -> SessionStatus:
    return session.status


@router.get("/session/{session_id}/events", response_class=StreamingResponse,
            responses={200: {"content": {"text/event-stream": {}}}})
def session_events(session: SessionDep, manager: ManagerDep) -> StreamingResponse:
    async def events():
        index = session.latest_status_index()
        while True:
            if manager.is_deleted(session):
                return
            for status in session.statuses_since(index):
                yield f"data: {status.model_dump_json()}\n\n"
                if status.status in {"ready", "error"}:
                    return
                index += 1
            await asyncio.sleep(0.25)

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/session/{session_id}/proxy", response_class=FileResponse,
            responses={200: {"content": {"video/mp4": {}}}})
def proxy(session: SessionDep) -> FileResponse:
    if not session.proxy_path.is_file():
        raise HTTPException(404, "代理视频尚未生成")
    return FileResponse(session.proxy_path, media_type="video/mp4")


@router.get("/session/{session_id}/thumbnails")
def thumbnails(session: SessionDep) -> ThumbnailsResponse:
    files = sorted(
        (file for file in session.thumbnails_dir.glob("*.jpg") if _THUMBNAIL_NAME.fullmatch(file.name)),
        key=lambda file: int(file.stem),
    )
    items = [
        ThumbnailItem(
            index=int(file.stem), time=(int(file.stem) - 1) / THUMBNAIL_FPS,
            url=f"/api/session/{session.session_id}/thumbnails/{file.name}",
        )
        for file in files
    ]
    return ThumbnailsResponse(count=len(items), width=ffmpeg_service.thumbnail_width(session.video), items=items)


@router.get("/session/{session_id}/thumbnails/{filename}", response_class=FileResponse,
            responses={200: {"content": {"image/jpeg": {}}}})
def thumbnail(session: SessionDep, filename: str) -> FileResponse:
    if not _THUMBNAIL_NAME.fullmatch(filename):
        raise HTTPException(404, "缩略图不存在")
    path = session.thumbnails_dir / filename
    if not path.is_file():
        raise HTTPException(404, "缩略图不存在")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})


@router.delete("/session/{session_id}")
def delete_session(session_id: str, manager: ManagerDep) -> DeleteResponse:
    return DeleteResponse(deleted=manager.delete(session_id))
