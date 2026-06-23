"""会话与临时文件管理。

每次上传生成一个 UUID 作为 session_id，对应 workspace 下的一个工作目录。
会话元数据保存在内存字典中（单用户工具，无需持久化）。
后台线程定期清理超时会话。
"""
from __future__ import annotations

import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from config import WORKSPACE_DIR, SESSION_TIMEOUT_HOURS


@dataclass
class Session:
    """单个会话的状态与元数据。"""

    session_id: str
    work_dir: Path
    filename: str = ""
    source_ext: str = ".mov"  # 原始文件扩展名（小写，含点）
    # 视频元数据
    duration: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    # 代理生成状态："processing" | "ready" | "error"
    status: str = "processing"
    proxy_progress: int = 0
    error: Optional[str] = None
    # 自定义 LUT：lut_id -> {name, path, size}
    custom_luts: dict = field(default_factory=dict)
    created_at: float = field(default_factory=lambda: 0.0)
    last_active: float = field(default_factory=lambda: 0.0)

    # --- 常用路径 ---
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

    def to_status_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "status": self.status,
            "proxy_progress": self.proxy_progress,
            "error": self.error,
        }


class SessionManager:
    """线程安全的会话注册表。"""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self) -> Session:
        sid = str(uuid.uuid4())
        work_dir = WORKSPACE_DIR / sid
        now = time.time()
        session = Session(
            session_id=sid,
            work_dir=work_dir,
            created_at=now,
            last_active=now,
        )
        # 建立工作目录结构
        for d in (work_dir, session.thumbnails_dir, session.custom_luts_dir, session.output_dir):
            d.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._sessions[sid] = session
        return session

    def get(self, session_id: str) -> Optional[Session]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None:
                session.last_active = time.time()
            return session

    def delete(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        shutil.rmtree(session.work_dir, ignore_errors=True)
        return True

    def cleanup_expired(self) -> int:
        """删除超时会话，返回清理数量。"""
        timeout = SESSION_TIMEOUT_HOURS * 3600
        now = time.time()
        expired: list[str] = []
        with self._lock:
            for sid, s in self._sessions.items():
                if now - s.last_active > timeout:
                    expired.append(sid)
        for sid in expired:
            self.delete(sid)
        return len(expired)

    def start_cleanup_thread(self, interval_seconds: int = 600) -> None:
        """启动后台清理线程（守护线程）。"""

        def _loop() -> None:
            while True:
                time.sleep(interval_seconds)
                try:
                    self.cleanup_expired()
                except Exception:  # noqa: BLE001 - 后台线程不应崩溃
                    pass

        t = threading.Thread(target=_loop, daemon=True, name="session-cleanup")
        t.start()


# 全局单例
session_manager = SessionManager()
