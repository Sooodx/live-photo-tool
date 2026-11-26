FROM node:22-slim AS frontend-builder

WORKDIR /frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
    && pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm run build

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
RUN uv sync --frozen --no-install-project --no-dev

# 拷贝后端代码与前端构建产物
COPY backend/app/ /app/app/
COPY backend/luts/builtin/ /app/luts/builtin/
COPY --from=frontend-builder /frontend/dist /app/static

# 创建运行所需目录
RUN mkdir -p /app/workspace /app/uploads /app/luts/user

ENV STATIC_DIR=/app/static \
    WORKSPACE_DIR=/app/workspace \
    UPLOADS_DIR=/app/uploads \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
