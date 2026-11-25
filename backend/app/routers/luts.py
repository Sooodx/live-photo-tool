"""LUT catalog, downloads and session-scoped uploads."""

from typing import Annotated, Iterator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from app.routers.sessions import ManagerDep, SessionDep, SettingsDep, Upload, upload_filename
from app.schemas import LutsResponse, LutUploadResponse
from app.services.lut_service import LutService
from app.services.session_manager import Session, UploadTooLarge

router = APIRouter(prefix="/api")
_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}


def get_lut_service(request: Request) -> LutService:
    return request.app.state.luts


def optional_session(manager: ManagerDep, session_id: str | None = None) -> Iterator[Session | None]:
    if session_id is None:
        yield None
    else:
        with manager.borrow(session_id) as session:
            yield session


LutServiceDep = Annotated[LutService, Depends(get_lut_service)]
OptionalSessionDep = Annotated[Session | None, Depends(optional_session)]


@router.get("/luts")
def list_luts(service: LutServiceDep, session: OptionalSessionDep) -> LutsResponse:
    return LutsResponse(luts=service.list(session))


@router.get("/luts/{lut_id}/raw", response_class=FileResponse,
            responses={200: {"content": {"text/plain": {}}}})
def raw_lut(lut_id: str, service: LutServiceDep, session: OptionalSessionDep) -> FileResponse:
    path = service.resolve(lut_id, session)
    if path is None:
        raise HTTPException(404, "LUT 不存在")
    return FileResponse(path, media_type="text/plain; charset=utf-8", headers=_CACHE_HEADERS)


@router.post("/session/{session_id}/lut/upload")
def upload_lut(
    file: Upload, session: SessionDep, service: LutServiceDep, settings: SettingsDep
) -> LutUploadResponse:
    name = upload_filename(file)
    if not name.lower().endswith(".cube"):
        raise HTTPException(400, "仅支持 .cube 文件")
    try:
        return service.upload(session, name, file.file, settings.max_upload_size_bytes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except UploadTooLarge as exc:
        raise HTTPException(400, "LUT 文件过大") from exc
