# Live Photo Tool

在浏览器中为 `.mov` 或 `.mp4` 视频套用 LUT、调整色调，选取最长 3 秒的片段和封面，再导出为 Apple Live Photo 或三星 / 谷歌 Motion Photo。视频在本地处理。

## 功能

- **实时调色** · WebGL2 3D LUT 引擎支持最高 60 fps 的实时预览，可调 LUT 强度、曝光、对比度、高光、阴影、白色色阶和黑色色阶。支持导入 33³ 或 65³ 的 `.cube` 文件。
- **快速拖动与裁剪** · FFmpeg 生成带原始音轨（如有）的低分辨率代理和时间轴缩略图。在可缩放的时间轴上选取入点、出点和封面。空格播放或暂停，左右方向键逐帧移动，按住 Shift 时每次移动 0.5 秒，`I` / `O` / `C` 设置入点、出点和封面，按住 `B` 对比原片。
- **动态照片预览** · 按住封面播放选区，松开回到封面。导出前可用「FFmpeg 精确校验」检查渲染结果。
- **Apple Live Photo** · 下载含配对 HEIC 和 MOV 文件的 ZIP。
- **三星 / 谷歌 Motion Photo** · 下载嵌入 MP4 的单个 JPG，包含 Samsung SEF v107 和 Motion Photo XMP 元数据。传输时请按原文件发送，避免图片压缩移除动态数据。

## 技术栈

- 前端使用 React 19、TypeScript、Vite、Tailwind CSS v4 和 WebGL2。
- 后端使用 Python 3.11、FastAPI、Uvicorn 和 Pydantic v2，通过 `uv` 管理依赖，调用 FFmpeg 处理视频。
- Docker 多阶段构建生成 Vite 静态资源，由 FastAPI 在运行时统一提供页面和 API。

## 目录结构

```text
live-photo-tool/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI 入口
│   │   ├── config.py        # 环境变量和运行目录
│   │   ├── schemas.py       # Pydantic 模型
│   │   ├── routers/        # 会话、LUT 和媒体 API
│   │   └── services/       # FFmpeg、导出、LUT 和会话管理
│   ├── luts/               # 内置 LUT
│   ├── tests/              # API 集成测试
│   ├── pyproject.toml
│   └── uv.lock
├── frontend/
│   ├── src/                # React 界面和 WebGL2 引擎
│   ├── dist/               # Vite 构建产物
│   ├── package.json
│   └── pnpm-lock.yaml
├── Dockerfile
└── docker-compose.yml
```

## 本地开发

准备 `uv`、Python 3.11、`ffmpeg`、`ffprobe`、Node.js 22.13 或更新版本，以及 `frontend/package.json` 中指定的 pnpm 版本。

在仓库根目录打开两个终端，分别启动后端和前端。

```bash
cd backend
uv sync && uv run uvicorn app.main:app --reload --port 8080
```

```bash
cd frontend
pnpm install && pnpm dev
```

打开 `http://localhost:5173`。Vite 会将 `/api` 请求转发到 `http://localhost:8080`。

如需本地运行生产构建，请在仓库根目录执行以下命令。FastAPI 默认从 `frontend/dist` 提供页面，打开 `http://localhost:8080` 即可访问。

```bash
(cd frontend && pnpm install --frozen-lockfile && pnpm build)
(cd backend && uv sync && uv run uvicorn app.main:app --port 8080)
```

## Docker Compose

在仓库根目录运行 `docker compose up --build`，然后打开 `http://localhost:8080`。

Compose 会自动挂载 `./workspace` 和 `./my-luts`。将自定义 `.cube` 放入 `./my-luts` 后刷新页面即可使用，也可直接在页面上传 LUT。内置 LUT 为恒等占位文件，转换 Log 色彩时请选用实际的转换 LUT。
