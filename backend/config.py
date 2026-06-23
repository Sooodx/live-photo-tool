"""全局配置，集中读取环境变量。"""
import os
from pathlib import Path

# 应用根目录（backend/）
BASE_DIR = Path(__file__).resolve().parent

# 内置 LUT 目录
LUTS_DIR = BASE_DIR / "luts"

# 工作目录：每个会话一个子目录
WORKSPACE_DIR = Path(os.environ.get("WORKSPACE_DIR", BASE_DIR / "workspace"))

# 原始上传暂存目录
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR", BASE_DIR / "uploads"))

# 前端静态文件目录（Docker 内为 /app/static，本地开发指向 ../frontend）
STATIC_DIR = Path(os.environ.get("STATIC_DIR", BASE_DIR.parent / "frontend"))

# 服务监听
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

# 上传大小上限（GB）
MAX_UPLOAD_SIZE_GB = float(os.environ.get("MAX_UPLOAD_SIZE_GB", "4"))
MAX_UPLOAD_SIZE_BYTES = int(MAX_UPLOAD_SIZE_GB * 1024 ** 3)

# 会话超时（小时）
SESSION_TIMEOUT_HOURS = float(os.environ.get("SESSION_TIMEOUT_HOURS", "1"))

# 代理与缩略图参数
PROXY_WIDTH = 960
PROXY_HEIGHT = 540
PROXY_CRF = 23
THUMBNAIL_WIDTH = 160
THUMBNAIL_HEIGHT = 90
THUMBNAIL_FPS = 1  # 每秒 1 帧

# Live Photo 规范：片段最大时长（秒）
MAX_CLIP_DURATION = 3.0

# 允许的视频扩展名
ALLOWED_VIDEO_EXT = {".mov", ".mp4"}
ALLOWED_LUT_EXT = {".cube"}


def ensure_dirs() -> None:
    """确保运行所需目录存在。"""
    for d in (WORKSPACE_DIR, UPLOADS_DIR, LUTS_DIR):
        d.mkdir(parents=True, exist_ok=True)
