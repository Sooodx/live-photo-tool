# Docker 部署方案

## 1. 环境要求

| 项目 | 最低要求 |
|------|----------|
| Docker Engine | 24.0+ |
| docker-compose | v2.0+ |
| 宿主机内存 | 8GB（处理 4K 视频建议 16GB） |
| 宿主机磁盘 | 20GB 可用（临时文件） |
| 操作系统 | macOS / Linux / Windows（WSL2） |

---

## 2. Dockerfile 设计说明

基础镜像选用 `python:3.11-slim`，在此基础上：

1. 安装 FFmpeg（含 libx264、libfdk-aac、libheif 支持）
2. 安装 Python 依赖
3. 拷贝内置 LUT 文件
4. 设置临时文件目录权限

```dockerfile
# 参考结构（非完整代码）
FROM python:3.11-slim

# 安装 FFmpeg 及依赖
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libheif-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY frontend/ /app/static/

# 创建工作目录
RUN mkdir -p /app/workspace /app/uploads

EXPOSE 8080

CMD ["python", "app.py"]
```

---

## 3. Python 依赖（requirements.txt）

```
flask==3.0.0
flask-cors==4.0.0
pillow==10.2.0
pillow-heif==0.15.0      # PNG → HEIC 转换
mutagen==1.47.0           # MOV udta 元数据注入
werkzeug==3.0.1
gunicorn==21.2.0          # 生产启动器（可选）
```

**关键依赖说明：**

| 库 | 用途 |
|----|------|
| `pillow-heif` | 将 PNG 封面帧编码为 HEIC，需要容器内有 libheif |
| `mutagen` | 读写 MP4/MOV 的 atom 元数据，注入 Apple ContentIdentifier |
| `flask-cors` | 允许前端跨域请求（开发调试时有用） |

---

## 4. docker-compose.yml 设计说明

```yaml
# 参考结构（非完整代码）
services:
  live-photo-tool:
    build: .
    ports:
      - "8080:8080"
    volumes:
      # 挂载宿主机目录用于临时文件（避免容器重启丢失进行中的任务）
      - ./workspace:/app/workspace
      # 可选：挂载自定义 LUT 目录，方便添加新 LUT 无需重建镜像
      - ./my-luts:/app/luts/user
    environment:
      - MAX_UPLOAD_SIZE_GB=4
      - SESSION_TIMEOUT_HOURS=1
      - FLASK_ENV=production
    restart: unless-stopped
```

**volumes 说明：**
- `./workspace` 挂载到宿主机，Docker 重启不丢失进行中任务
- `./my-luts` 可选挂载，用户可把自己的 `.cube` 文件放进去，重启即生效（无需上传）

---

## 5. 启动与使用

### 首次启动

```bash
# 克隆项目
git clone <repo-url>
cd live-photo-tool

# 构建并启动
docker-compose up --build

# 后台运行
docker-compose up -d --build
```

### 日常使用

```bash
# 启动
docker-compose up -d

# 停止
docker-compose down

# 查看日志
docker-compose logs -f

# 手动清理临时文件
docker-compose exec live-photo-tool rm -rf /app/workspace/*
```

### 访问

浏览器打开 `http://localhost:8080`

---

## 6. 性能预估

测试参考机器：Apple M2 MacBook Pro，16GB 内存

| 操作 | 预估耗时 |
|------|----------|
| 代理生成（4K 1分钟视频） | 15–30 秒 |
| 缩略图生成（60帧） | 5–10 秒 |
| 预览帧渲染（单帧） | 0.5–1 秒 |
| 导出 3 秒 4K Live Photo | 20–40 秒 |

> 注：Docker Desktop（macOS）下 FFmpeg 性能约为原生的 60–80%，Linux 宿主机接近原生。

---

## 7. HEIC 编码注意事项

`libheif` 在不同平台支持情况有差异：

| 情况 | 处理方式 |
|------|----------|
| 容器内 FFmpeg 不支持 HEIC 编码 | 使用 `pillow-heif` 库单独处理 |
| `pillow-heif` 无法安装 | 降级为 JPEG 输出，仍可被 iOS 识别为 Live Photo（兼容性略低） |
| ARM 架构（Apple Silicon Docker）| 注意选用 `linux/arm64` 镜像或开启 Rosetta 仿真 |

**Dockerfile 中处理 ARM 兼容性：**
```dockerfile
# 在 docker-compose.yml 中指定平台
platform: linux/amd64   # 或 linux/arm64
```

---

## 8. Live Photo 导入 iOS 说明

导出的 ZIP 包含 `IMG_XXXX.heic` + `IMG_XXXX.mov` 两个文件：

**方法一（推荐）：AirDrop**
1. 解压 ZIP，得到两个同名文件
2. 同时选中两个文件，AirDrop 发送到 iPhone
3. iOS 自动识别 ContentIdentifier，在相册中显示为 Live Photo

**方法二：iCloud Drive**
1. 上传两个文件到 iCloud Drive 同一目录
2. 在 iPhone「文件」App 中长按选择，点击「存储到照片」

**方法三：Mac「照片」App**
1. 解压后拖入「照片」App
2. Mac 版「照片」也能识别并同步到 iPhone

> 关键：两个文件必须同名（仅扩展名不同），且 XMP 和 udta 中的 ContentIdentifier UUID 完全一致，缺一不可。
