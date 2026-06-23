# Live Photo Tool

LOG 视频套 LUT + 导出 Apple Live Photo / 三星 Motion Photo 的本地 Web 工具。

在浏览器中上传 Panasonic V-Log（及其他 Log 格式）`.mov` / `.mp4` 文件，选择 LUT 还原色彩，
裁剪片段（≤ 3 秒），导出为 **Apple Live Photo**（HEIC + MOV）或 **三星/谷歌 Motion Photo**
（单个 JPEG 内嵌 MP4）。全程本地 Docker 运行，无数据外传。

## 功能一览

- **上传与代理**：拖拽上传 `.mov` / `.mp4`，后端异步生成低分辨率代理 + 时间轴缩略图，随时可「重新选择视频」。
- **时间轴选区**：canvas 时间轴，拖动入点 / 出点 / 封面三手柄选取 ≤3s 片段与封面帧；支持时间轴拖拽。
- **LUT 还原**：内置占位 LUT，可上传自定义 `.cube`；LUT 强度滑块 0–100%（split+blend 实时混合）。
- **色调调整**：曝光 / 对比度 / 高光 / 阴影 / 白色色阶 / 黑色色阶（FFmpeg `exposure` + `eq` + `curves`），滑块调整后自动重新预览。
- **封面选取**：播放/拖动视频到目标画面，一键「把当前帧设为封面」。
- **选区预览**：弹框预览套了 LUT + 色调调整后的选区片段（低分辨率代理）。
- **导出格式可选**：
  - **Apple Live Photo** —— ZIP 内含同名 HEIC + MOV，靠共享 UUID（ContentIdentifier）配对，经 AirDrop / iCloud 导入 iOS 相册。
  - **三星 / 谷歌 Motion Photo** —— 单个 JPEG（文件名自动加 `MV` 前缀），尾部附加 **Samsung SEF footer**（字段 `Image_UTC_Data` + `MotionPhoto_Info` + `MotionPhoto_Data` 内嵌 MP4，`SEFH` version 107 索引），并写入 `GCamera:MotionPhoto` + `Container:Directory` XMP。
    - 字段集与 SEF 字节算法对照 Galaxy 真机样本反向工程：用真机字段可逐字节重建其 footer。
    - 内嵌视频降采样到长边 ≤ 1920 + `mp42` 容器（贴近真机：视频降采样、静态封面保持全分辨率），以确保三星 Gallery 内联播放器能播放。
    - ⚠️ **传输务必保留原始字节**：用 USB / 微信「文件」/ 网盘传，**不要当「图片」发**——微信等会重新压缩并剥离 footer，导致动态信息丢失。

## 技术栈

- 前端：HTML + Vanilla JS（无框架）
- 后端：Python 3.11 + Flask，依赖用 [uv](https://docs.astral.sh/uv/) 管理
- 视频处理：FFmpeg
- 部署：Docker + docker-compose

## 目录结构

```
live-photo-tool/
├── docker-compose.yml
├── Dockerfile                 # 基于 uv 官方镜像
├── backend/
│   ├── pyproject.toml         # uv 依赖声明
│   ├── uv.lock                # 锁定文件
│   ├── .python-version        # 固定 Python 3.11
│   ├── app.py                 # Flask 主应用
│   ├── config.py              # 配置（环境变量）
│   ├── luts/                  # 内置 LUT（当前为占位恒等 LUT）
│   └── modules/
│       ├── ffmpeg_utils.py    # FFmpeg 调用封装
│       ├── lut_manager.py     # LUT 管理
│       ├── live_photo.py      # Live Photo 封装
│       └── session_manager.py # 会话与临时文件管理
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js
```

## 本地开发（uv）

需要本机已安装 `ffmpeg`、`ffprobe`。

```bash
cd backend
uv sync                 # 创建 .venv 并安装依赖
uv run python app.py    # 启动，访问 http://localhost:8080
```

## Docker 运行

```bash
docker compose up --build       # 构建并启动
# 浏览器打开 http://localhost:8080
```

## 说明

- `backend/luts/*.cube` 目前是**占位恒等 LUT**，请替换为真实的转换 LUT。
- 也可把自己的 `.cube` 放进 `./my-luts`（compose 已挂载到容器），或在前端上传自定义 LUT。
