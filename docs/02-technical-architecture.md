# 技术架构与实现方案

## 1. 整体架构

```
浏览器（localhost:8080）
    │
    │  HTTP / multipart upload / SSE
    ▼
Flask 应用（Python 3.11）
    │
    ├── 文件管理（临时目录，UUID 隔离）
    ├── FFmpeg 调用层（subprocess）
    ├── LUT 管理（内置 .cube 文件）
    └── Live Photo 封装（HEIC XMP + MOV udta）

容器内文件系统：
    /app/
    ├── luts/          # 内置 LUT 文件
    ├── uploads/       # 用户上传的原始文件（临时）
    └── workspace/     # 每个会话的工作目录
        └── {session_id}/
            ├── original.mov
            ├── proxy.mp4       # 代理文件
            ├── thumbnails/     # 时间轴缩略图
            ├── custom_luts/    # 用户上传的 LUT
            └── output/         # 导出文件
```

---

## 2. 项目目录结构

```
live-photo-tool/
├── docker-compose.yml
├── Dockerfile
├── backend/
│   ├── app.py               # Flask 主应用
│   ├── requirements.txt
│   ├── luts/                # 内置 LUT 文件
│   │   ├── VLog_to_V709.cube
│   │   ├── VLog_to_V709_Warm.cube
│   │   ├── VLog_to_V709_Cool.cube
│   │   ├── SLog3_to_S709.cube
│   │   ├── SLog2_to_S709.cube
│   │   └── LogC_to_Rec709.cube
│   └── modules/
│       ├── ffmpeg_utils.py  # FFmpeg 调用封装
│       ├── lut_manager.py   # LUT 管理
│       ├── live_photo.py    # Live Photo 封装逻辑
│       └── session_manager.py  # 会话与临时文件管理
└── frontend/
    ├── index.html           # 单页应用
    ├── style.css
    └── app.js
```

---

## 3. 后端模块设计

### 3.1 app.py — 路由总览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload` | 上传 MOV，返回 session_id，后台开始生成 proxy |
| GET | `/api/session/{id}/status` | 查询 proxy 生成进度 |
| GET | `/api/session/{id}/proxy` | 返回代理视频流 |
| GET | `/api/session/{id}/thumbnails` | 返回时间轴缩略图列表 |
| GET | `/api/luts` | 返回所有可用 LUT 列表（内置 + 自定义） |
| POST | `/api/session/{id}/lut/upload` | 上传自定义 .cube 文件 |
| POST | `/api/session/{id}/preview-frame` | 渲染指定时间点的帧（套 LUT 后），返回 JPEG |
| POST | `/api/session/{id}/export` | 执行导出，返回 ZIP 文件流 |
| DELETE | `/api/session/{id}` | 清理会话文件 |

### 3.2 ffmpeg_utils.py — 关键 FFmpeg 命令

**生成代理：**
```
ffmpeg -i original.mov
  -vf scale=960:540
  -c:v libx264 -crf 23 -preset fast
  -an
  proxy.mp4
```

**生成时间轴缩略图（每秒1帧）：**
```
ffmpeg -i original.mov
  -vf fps=1,scale=160:90
  -q:v 5
  thumbnails/%04d.jpg
```

**渲染预览帧（套 LUT）：**
```
ffmpeg -ss {timestamp} -i original.mov
  -vf lut3d={lut_path}[,blend=...如有强度调节]
  -vframes 1
  -q:v 2
  preview.jpg
```

**导出视频片段（套 LUT）：**
```
ffmpeg -ss {in_point} -i original.mov
  -t {duration}
  -vf lut3d={lut_path},scale={orig_w}:{orig_h}
  -c:v libx264 -crf 18 -preset slow
  -c:a aac -b:a 128k
  -movflags +faststart
  output_clip.mov
```

**提取封面帧为 PNG（后续转 HEIC）：**
```
ffmpeg -ss {frame_time} -i original.mov
  -vf lut3d={lut_path}
  -vframes 1
  cover.png
```

### 3.3 live_photo.py — Live Photo 封装

**HEIC 生成（cover.png → cover.heic）：**
- 使用 `pillow-heif` 库将 PNG 转为 HEIC
- 写入 XMP sidecar 元数据：
  ```xml
  <x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="...">
      <rdf:Description rdf:about=""
        xmlns:apple_desktop="http://ns.apple.com/namespace/1.0/">
        <apple_desktop:APHDv>
          <rdf:Bag>
            <rdf:li apple_desktop:LivePhotoVideoIndex="1"
                    apple_desktop:ContentIdentifier="{uuid}"/>
          </rdf:Bag>
        </apple_desktop:APHDv>
      </rdf:Description>
    </rdf:RDF>
  </x:xmpmeta>
  ```

**MOV 元数据注入（udta box）：**
- 使用 `mutagen` 或直接二进制写入 `moov.udta.HMMT` / `com.apple.quicktime.content.identifier`
- 写入与 HEIC 相同的 UUID

**具体苹果规范参考：**
- HEIC XMP 字段：`com.apple.photos.LivePhoto.ContentIdentifier`
- MOV 需要在 `moov/udta` 下写入 `com.apple.quicktime.content.identifier` atom
- 两者 UUID 必须完全一致，iOS 相册据此配对

### 3.4 session_manager.py — 会话管理

- 每次上传生成 UUID 作为 session_id
- 工作目录：`/app/workspace/{session_id}/`
- 后台线程每小时扫描，删除超时会话目录
- 会话元数据（文件路径、视频时长、分辨率等）存储在内存字典中（单用户工具，无需持久化）

---

## 4. 前端设计

### 4.1 技术选型

- 纯 Vanilla JS，无框架依赖
- 视频播放：原生 `<video>` 元素，src 指向代理流
- 时间轴：`<canvas>` 绘制缩略图 + 拖拽手柄
- 样式：纯 CSS，无外部 UI 库

### 4.2 关键交互状态机

```
[初始] → 上传文件 → [代理生成中（进度条）]
  → 生成完成 → [就绪：可选 LUT、操作时间轴]
  → 点击预览帧 → [等待后端渲染] → [显示预览图]
  → 点击导出 → [导出进度] → [下载 ZIP]
```

### 4.3 时间轴实现要点

- Canvas 宽度 = 容器宽度，高度 = 90px
- 背景：横向平铺缩略图（每秒1帧，160×90）
- 选区：半透明遮罩 + 左右拖拽手柄（竖线 + 三角形拖把）
- 封面帧指示器：细竖线，在选区内拖拽
- 时长超出 3 秒：选区背景变红，底部提示文字

### 4.4 LUT 强度混合

前端 UI 有滑块（0–100%），参数传给后端，后端通过 FFmpeg `lut3d` + `blend` 滤镜组合实现：

```
-vf "lut3d={path},blend=all_expr='A*{intensity}+B*(1-{intensity})':shortest=1:repeatlast=0"
```

其中 B 来自原始帧（需要两输入，用 overlay 技巧实现，或直接前端仅在 100% 时调用，其余强度为后续迭代）。

MVP 阶段：强度固定 100%，滑块留 UI 占位。

---

## 5. 数据流图

```
用户上传 MOV
      │
      ▼
  Flask 接收文件
  保存到 /workspace/{sid}/original.mov
  返回 session_id
      │
      ├──► 后台线程：FFmpeg 生成 proxy.mp4 + thumbnails/
      │
      ▼
  前端轮询 /status，显示进度
      │
      ▼
  就绪，前端加载 proxy 视频 + 缩略图时间轴
      │
  用户选择 LUT + 拖拽选区 + 选封面帧
      │
      ▼
  POST /preview-frame（可选）
  → FFmpeg 渲染单帧 JPEG 返回前端
      │
      ▼
  POST /export
  {
    in_point: 12.4,    // 秒
    out_point: 15.0,   // 秒
    cover_time: 13.1,  // 封面帧时间点
    lut_id: "VLog_to_V709",
    lut_intensity: 1.0
  }
      │
      ▼
  后端执行：
  1. FFmpeg 导出 output_clip.mov（套 LUT）
  2. FFmpeg 提取封面帧 cover.png
  3. pillow-heif 转 HEIC + 写 XMP UUID
  4. mutagen 注入 MOV udta UUID
  5. zipfile 打包
      │
      ▼
  返回 ZIP 文件流（Content-Disposition: attachment）
      │
      ▼
  浏览器下载，用户导入 iOS 相册
```
