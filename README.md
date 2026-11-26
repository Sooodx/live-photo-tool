# Live Photo Tool

在浏览器中为 `.mov` 或 `.mp4` 视频套用 LUT、调整色调，选取片段和封面，再导出为 Apple Live Photo 或三星 / 谷歌 Motion Photo。视频在本地处理。

## 功能

- **实时调色** · WebGL2 3D LUT 引擎支持最高 60 fps 的实时预览，可调 LUT 强度、曝光、对比度、高光、阴影、白色色阶和黑色色阶。导入的 33³ 或 65³ `.cube` 文件会保存在 LUT 库中，换片后可再次选用。
- **快速拖动与裁剪** · FFmpeg 生成带原始音轨（如有）的低分辨率代理和时间轴缩略图。在可缩放的时间轴上选取入点、出点和封面。空格播放或暂停，左右方向键逐帧移动，按住 Shift 时每次移动 0.5 秒，`I` / `O` / `C` 设置入点、出点和封面，按住 `B` 对比原片。
- **编辑区大小可调** · 在宽屏布局中，上下拖动预览区与时间轴之间的分隔条，左右拖动主区与调色面板之间的分隔条。
- **动态照片预览** · 按住封面播放选区，松开回到封面。导出前可用「FFmpeg 精确校验」检查渲染结果。
- **Apple Live Photo** · 下载含配对 HEIC 和 MOV 文件的 ZIP。
- **三星 / 谷歌 Motion Photo** · 下载嵌入 MP4 的单个 JPG，包含 Samsung SEF v107 和 Motion Photo XMP 元数据。传输时请按原文件发送，避免图片压缩移除动态数据。

选区可以覆盖整段素材。超过 3 秒的导出文件能否被识别并完整播放，取决于目标设备和相册应用。

## 内置风格 LUT

调色面板的初始选项为「无 LUT（原片）」。内置的青橙电影、柔和人像、暖调复古和高反差黑白适用于 Rec.709 SDR 视频。Log 或 HDR 素材需先转换到 Rec.709 SDR。[内置 LUT 来源、版本和许可证](backend/luts/builtin/README.md)

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
│   ├── luts/builtin/       # 内置风格 LUT 及许可证
│   ├── luts/user/          # 本地用户 LUT 库（运行时创建）
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

Compose 将 `./workspace` 用作视频会话目录，将 `./my-luts` 用作持久化 LUT 库。网页上传的 LUT 会写入 `./my-luts/uploads/`，换视频或重建容器后可继续使用。也可以手动将 `.cube` 放入 `./my-luts`，刷新页面后选用。

内置 LUT 和许可证随镜像打包在 `/app/luts/builtin/`。直接运行后端时，用户 LUT 库的默认路径是 `backend/luts/user/`。
