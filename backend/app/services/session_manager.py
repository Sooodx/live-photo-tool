"""Session registry and workspace lifetime management."""

import shutil
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import BinaryIO, Iterator

from app.config import UPLOAD_CHUNK_SIZE, Settings
from app.schemas import LutItem, SessionStatus, VideoMetadata


class UploadTooLarge(Exception):
    pass


def copy_upload(source: BinaryIO, destination: Path, max_bytes: int) -> None:
    size = 0
    with destination.open("wb") as output:
        while chunk := source.read(UPLOAD_CHUNK_SIZE):
            size += len(chunk)
            if size > max_bytes:
                raise UploadTooLarge
            output.write(chunk)


@dataclass(slots=True)
class Session:
    session_id: str
    work_dir: Path
    filename: str
    source_ext: str
    video: VideoMetadata = field(init=False)
    last_active: float = field(default_factory=time.monotonic)
    leases: int = 0
    deleted: bool = False
    _statuses: list[SessionStatus] = field(init=False)
    _custom_luts: dict[str, LutItem] = field(default_factory=dict)
    _lock: Lock = field(default_factory=Lock)

    def __post_init__(self) -> None:
        self._statuses = [SessionStatus(session_id=self.session_id)]

    @property
    def original_path(self) -> Path:
        return self.work_dir / f"original{self.source_ext}"

    @property
    def proxy_path(self) -> Path:
        return self.work_dir / "proxy.mp4"

    @property
    def thumbnails_dir(self) -> Path:
        return self.work_dir / "thumbnails"

    @property
    def custom_luts_dir(self) -> Path:
        return self.work_dir / "custom_luts"

    @property
    def output_dir(self) -> Path:
        return self.work_dir / "output"

    @property
    def status(self) -> SessionStatus:
        with self._lock:
            return self._statuses[-1]

    def latest_status_index(self) -> int:
        with self._lock:
            return len(self._statuses) - 1

    def statuses_since(self, index: int) -> list[SessionStatus]:
        with self._lock:
            return self._statuses[index:]

    def update_status(self, **changes: object) -> None:
        with self._lock:
            previous = self._statuses[-1]
            status = previous.model_copy(update=changes)
            if status != previous:
                self._statuses.append(status)

    def add_lut(self, item: LutItem) -> None:
        with self._lock:
            self._custom_luts[item.id] = item

    def custom_luts(self) -> list[LutItem]:
        with self._lock:
            return list(self._custom_luts.values())

    def custom_lut_path(self, lut_id: str) -> Path | None:
        with self._lock:
            if lut_id in self._custom_luts:
                return self.custom_luts_dir / f"{lut_id}.cube"
        return None


class SessionManager:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._sessions: dict[str, Session] = {}
        self._lock = Lock()

    @contextmanager
    def new_workspace(self, filename: str, source_ext: str) -> Iterator[Session]:
        session_id = str(uuid.uuid4())
        session = Session(session_id, self._settings.workspace_dir / session_id, filename, source_ext)
        session.work_dir.mkdir()
        try:
            session.custom_luts_dir.mkdir()
            session.output_dir.mkdir()
            yield session
        except BaseException:
            shutil.rmtree(session.work_dir)
            raise

    def register(self, session: Session) -> None:
        with self._lock:
            session.last_active = time.monotonic()
            self._sessions[session.session_id] = session

    @contextmanager
    def borrow(self, session_id: str) -> Iterator[Session | None]:
        # Retain files until active renders and streaming responses have finished.
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None:
                session.leases += 1
        try:
            yield session
        finally:
            if session is not None:
                with self._lock:
                    session.leases -= 1
                    session.last_active = time.monotonic()
                    remove = session.deleted and session.leases == 0
                if remove:
                    shutil.rmtree(session.work_dir)

    def is_deleted(self, session: Session) -> bool:
        with self._lock:
            return session.deleted

    def delete(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
            if session is None:
                return False
            session.deleted = True
            remove = session.leases == 0
        if remove:
            shutil.rmtree(session.work_dir)
        return True

    def cleanup_expired(self) -> None:
        deadline = time.monotonic() - self._settings.session_timeout_hours * 3600
        with self._lock:
            expired = [
                session for session in self._sessions.values()
                if not session.leases and session.last_active < deadline
            ]
            for session in expired:
                del self._sessions[session.session_id]
        for session in expired:
            shutil.rmtree(session.work_dir)
