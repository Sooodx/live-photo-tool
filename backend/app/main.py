"""FastAPI entry point and application lifecycle."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from app.config import Settings
from app.routers import luts, media, sessions
from app.schemas import HealthResponse
from app.services.lut_service import LutService
from app.services.session_manager import SessionManager

logger = logging.getLogger(__name__)


async def _cleanup_sessions(manager: SessionManager) -> None:
    while True:
        await asyncio.sleep(60)
        try:
            await run_in_threadpool(manager.cleanup_expired)
        except OSError:
            logger.exception("Session cleanup failed")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()
    manager = SessionManager(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await run_in_threadpool(settings.ensure_dirs)
        cleanup = asyncio.create_task(_cleanup_sessions(manager))
        try:
            yield
        finally:
            cleanup.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup
            await asyncio.gather(*api.state.processing_jobs, return_exceptions=True)

    api = FastAPI(title="Live Photo Tool", lifespan=lifespan)
    api.state.settings = settings
    api.state.sessions = manager
    api.state.luts = LutService(settings.luts_dir)
    api.state.processing_jobs = set()
    api.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
        expose_headers=["Accept-Ranges", "Content-Disposition", "Content-Range"],
    )

    @api.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        issue = exc.errors()[0]
        field = ".".join(str(part) for part in issue["loc"])
        return JSONResponse({"detail": f"{field}: {issue['msg']}"}, status_code=400)

    @api.get("/api/health")
    async def health() -> HealthResponse:
        return HealthResponse()

    api.include_router(sessions.router)
    api.include_router(luts.router)
    api.include_router(media.router)

    root = settings.static_dir.resolve()
    assets = root / "assets"
    if assets.is_dir():
        api.mount("/assets", StaticFiles(directory=assets), name="assets")

    @api.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def static_or_spa(path: str) -> FileResponse:
        if path.split("/", 1)[0] in {"api", "assets", "docs", "redoc", "openapi.json"}:
            raise HTTPException(404)
        target = (root / path).resolve()
        if not target.is_relative_to(root):
            raise HTTPException(404)
        if target.is_file():
            return FileResponse(target)
        index = (root / "index.html").resolve()
        if not index.is_relative_to(root) or not index.is_file():
            raise HTTPException(404)
        return FileResponse(index, media_type="text/html")

    return api


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=app.state.settings.host, port=app.state.settings.port)
