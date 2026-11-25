"""Environment settings for the API and its runtime directories."""

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
UPLOAD_CHUNK_SIZE = 1024 * 1024
PROXY_MAX_EDGE = 1280
THUMBNAIL_HEIGHT = 90
THUMBNAIL_FPS = 1
MAX_CLIP_DURATION = 3.0


@dataclass(frozen=True, slots=True)
class Settings:
    workspace_dir: Path = field(
        default_factory=lambda: Path(os.getenv("WORKSPACE_DIR", BACKEND_DIR / "workspace"))
    )
    uploads_dir: Path = field(
        default_factory=lambda: Path(os.getenv("UPLOADS_DIR", BACKEND_DIR / "uploads"))
    )
    static_dir: Path = field(
        default_factory=lambda: Path(os.getenv("STATIC_DIR", BACKEND_DIR.parent / "frontend" / "dist"))
    )
    luts_dir: Path = field(
        default_factory=lambda: Path(os.getenv("LUTS_DIR", BACKEND_DIR / "luts"))
    )
    host: str = field(default_factory=lambda: os.getenv("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8080")))
    max_upload_size_gb: float = field(
        default_factory=lambda: float(os.getenv("MAX_UPLOAD_SIZE_GB", "4"))
    )
    session_timeout_hours: float = field(
        default_factory=lambda: float(os.getenv("SESSION_TIMEOUT_HOURS", "1"))
    )

    @property
    def max_upload_size_bytes(self) -> int:
        return int(self.max_upload_size_gb * 1024**3)

    def ensure_dirs(self) -> None:
        for directory in (self.workspace_dir, self.uploads_dir, self.luts_dir):
            directory.mkdir(parents=True, exist_ok=True)
