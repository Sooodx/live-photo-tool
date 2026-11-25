"""Persistent user LUT catalog, downloads and uploads."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from app.routers.sessions import SettingsDep, Upload, require_session, upload_filename
from app.schemas import LutsResponse, LutUploadResponse
from app.services.lut_service import LutService
from app.services.session_manager import UploadTooLarge

router = APIRouter(prefix="/api")
_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}


def get_lut_service(request: Request) -> LutService:
    return request.app.state.luts


LutServiceDep = Annotated[LutService, Depends(get_lut_service)]


@router.get("/luts")
def list_luts(service: LutServiceDep) -> LutsResponse:
    return LutsResponse(luts=service.list())


@router.get("/luts/{lut_id}/raw", response_class=FileResponse,
            responses={200: {"content": {"text/plain": {}}}})
def raw_lut(lut_id: str, service: LutServiceDep) -> FileResponse:
    path = service.resolve(lut_id)
    if path is None:
        raise HTTPException(404, "LUT 不存在")
    return FileResponse(path, media_type="text/plain; charset=utf-8", headers=_CACHE_HEADERS)


@router.post("/session/{session_id}/lut/upload", dependencies=[Depends(require_session)])
@router.post("/luts/upload")
def upload_lut(file: Upload, service: LutServiceDep, settings: SettingsDep) -> LutUploadResponse:
    name = upload_filename(file)
    try:
        return service.upload(name, file.file, settings.max_upload_size_bytes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except UploadTooLarge as exc:
        raise HTTPException(400, "LUT 文件过大") from exc
    except OSError as exc:
        raise HTTPException(500, "无法写入 LUT 目录") from exc
