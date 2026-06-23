# Live Photo Tool —— 基于 uv 的镜像构建
# uv 官方镜像已内置 uv，并附带 Python 3.11
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim

# 安装 FFmpeg 及 HEIC 依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 让 uv 把虚拟环境创建在固定位置，并使用系统已有的 Python
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

# 先只拷贝依赖描述，利用 Docker 层缓存
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN uv sync --frozen --no-install-project

# 拷贝后端代码与内置 LUT
COPY backend/ .

# 拷贝前端静态资源到容器内 static 目录
COPY frontend/ /app/static/

# 创建运行所需目录
RUN mkdir -p /app/workspace /app/uploads

ENV STATIC_DIR=/app/static \
    WORKSPACE_DIR=/app/workspace \
    UPLOADS_DIR=/app/uploads \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

CMD ["uv", "run", "--frozen", "python", "app.py"]
