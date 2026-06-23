# API 接口规范

Base URL: `http://localhost:8080/api`

所有请求/响应使用 JSON，文件上传使用 `multipart/form-data`，文件下载返回二进制流。

---

## 1. 上传视频

### `POST /upload`

上传原始 MOV 文件，服务器保存后异步生成代理文件。

**请求：** `multipart/form-data`

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | .mov / .mp4 文件 |

**响应：** `200 OK`

```json
{
  "session_id": "a1b2c3d4-...",
  "filename": "A001C001.mov",
  "duration": 47.3,
  "width": 3840,
  "height": 2160,
  "fps": 25.0,
  "status": "processing"
}
```

**错误：**

| 状态码 | 原因 |
|--------|------|
| 400 | 文件格式不支持或文件损坏 |
| 413 | 文件超过 4GB 限制 |

---

## 2. 查询会话状态

### `GET /session/{session_id}/status`

轮询代理生成进度。前端每 2 秒调用一次，直到 status 为 `ready`。

**响应：** `200 OK`

```json
{
  "session_id": "a1b2c3d4-...",
  "status": "processing",   // "processing" | "ready" | "error"
  "proxy_progress": 65,     // 0-100，仅 processing 时有效
  "error": null             // status=error 时填写错误信息
}
```

---

## 3. 代理视频流

### `GET /session/{session_id}/proxy`

返回代理 MP4 文件，支持 Range 请求（供 `<video>` 标签 seek 使用）。

**响应：**
- Content-Type: `video/mp4`
- 支持 `Range` 请求头，返回 `206 Partial Content`

---

## 4. 时间轴缩略图

### `GET /session/{session_id}/thumbnails`

返回缩略图元数据列表，图片文件通过独立路径访问。

**响应：** `200 OK`

```json
{
  "count": 47,
  "fps_sample": 1,
  "width": 160,
  "height": 90,
  "items": [
    { "index": 1, "time": 0.0, "url": "/api/session/a1b2c3d4-.../thumbnails/0001.jpg" },
    { "index": 2, "time": 1.0, "url": "/api/session/a1b2c3d4-.../thumbnails/0002.jpg" }
  ]
}
```

### `GET /session/{session_id}/thumbnails/{filename}`

返回单张缩略图 JPEG。

---

## 5. LUT 列表

### `GET /luts`

返回所有可用 LUT（内置 + 当前会话已上传的自定义 LUT）。

**请求参数（Query）：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | string | 可选，传入后也返回该会话的自定义 LUT |

**响应：** `200 OK`

```json
{
  "luts": [
    {
      "id": "VLog_to_V709",
      "name": "V-Log → V-709",
      "description": "Panasonic V-Log 转 Rec.709，标准还原",
      "source": "builtin",
      "size": 33
    },
    {
      "id": "VLog_to_V709_Warm",
      "name": "V-Log → V-709 Warm",
      "description": "暖调版本，色温偏橙",
      "source": "builtin",
      "size": 33
    },
    {
      "id": "VLog_to_V709_Cool",
      "name": "V-Log → V-709 Cool",
      "description": "冷调版本，色温偏蓝",
      "source": "builtin",
      "size": 33
    },
    {
      "id": "SLog3_to_S709",
      "name": "S-Log3 → S-709",
      "description": "Sony S-Log3 转 Rec.709",
      "source": "builtin",
      "size": 33
    },
    {
      "id": "SLog2_to_S709",
      "name": "S-Log2 → S-709",
      "description": "Sony S-Log2 转 Rec.709",
      "source": "builtin",
      "size": 33
    },
    {
      "id": "LogC_to_Rec709",
      "name": "Log-C → Rec.709",
      "description": "ARRI Log-C 转 Rec.709",
      "source": "builtin",
      "size": 33
    },
    {
      "id": "custom_abc123",
      "name": "MyCustomLUT.cube",
      "description": "用户上传",
      "source": "custom",
      "size": 65
    }
  ]
}
```

---

## 6. 上传自定义 LUT

### `POST /session/{session_id}/lut/upload`

**请求：** `multipart/form-data`

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | .cube 文件 |

**响应：** `200 OK`

```json
{
  "lut_id": "custom_abc123",
  "name": "MyCustomLUT.cube",
  "size": 65,
  "valid": true
}
```

**错误：**

| 状态码 | 原因 |
|--------|------|
| 400 | 不是有效的 .cube 文件，或 LUT size 不支持 |

---

## 7. 预览帧

### `POST /session/{session_id}/preview-frame`

渲染指定时间点的单帧，套用 LUT 后返回 JPEG。

**请求体：**

```json
{
  "time": 13.5,
  "lut_id": "VLog_to_V709",
  "lut_intensity": 0.8,
  "adjustments": {
    "exposure": 20,
    "contrast": 10,
    "highlights": -30,
    "shadows": 25,
    "whites": 5,
    "blacks": -10
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | float | 时间点，单位秒 |
| `lut_id` | string | LUT 标识符 |
| `lut_intensity` | float | 0.0–1.0，LUT 混合强度（1.0 完全套用，0.0 为原始 Log） |
| `adjustments` | object | 可选，色调调整，见下表；缺省字段按 0（中性）处理 |

**`adjustments` 字段（均为 -100..100 整数，0 中性）：**

| 字段 | 说明 | 后端实现 |
|------|------|----------|
| `exposure` | 曝光 | `exposure` 滤镜，±100 → ±2 EV |
| `contrast` | 对比度 | `eq=contrast`，±100 → 0..2 |
| `highlights` | 高光 | `curves` 分区曲线（亮部） |
| `shadows` | 阴影 | `curves` 分区曲线（暗部） |
| `whites` | 白色色阶 | `curves` 最亮端 |
| `blacks` | 黑色色阶 | `curves` 最暗端 |

> 滤镜顺序：`lut3d`（按 `lut_intensity` 用 split+blend 混合） → `exposure` → `eq` → `curves` → `scale`。

**响应：** JPEG 图片流
- Content-Type: `image/jpeg`
- 分辨率：960×540（代理分辨率，用于快速预览）

---

## 8. 导出动态照片

### `POST /session/{session_id}/export`

执行完整导出流程。可选导出为 **Apple Live Photo** 或 **三星/谷歌 Motion Photo**。

**请求体：**

```json
{
  "in_point": 12.4,
  "out_point": 15.0,
  "cover_time": 13.1,
  "lut_id": "VLog_to_V709",
  "lut_intensity": 0.8,
  "adjustments": {
    "exposure": 20,
    "contrast": 10,
    "highlights": -30,
    "shadows": 25,
    "whites": 5,
    "blacks": -10
  },
  "format": "apple",
  "output_name": "IMG_0001"
}
```

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `in_point` | float | ≥ 0 | 视频片段入点，秒 |
| `out_point` | float | ≤ duration | 视频片段出点，秒 |
| `cover_time` | float | in ≤ t ≤ out | 封面帧时间点 |
| `lut_id` | string | 必填 | LUT 标识符 |
| `lut_intensity` | float | 0.0–1.0 | LUT 混合强度 |
| `adjustments` | object | 可选 | 色调调整，字段同预览帧接口（见第 7 节） |
| `format` | string | `apple` \| `samsung` | 导出格式，默认 `apple` |
| `output_name` | string | 可选 | 输出文件名前缀，默认 "IMG_0001" |

**约束验证：**
- `out_point - in_point` 必须 ≤ 3.0 秒
- `cover_time` 必须在 `[in_point, out_point]` 范围内
- `format` 仅允许 `apple` 或 `samsung`

**响应（`format=apple`）：** ZIP 文件流
- Content-Type: `application/zip`
- Content-Disposition: `attachment; filename="IMG_0001.zip"`
- ZIP 内容：`IMG_0001.heic` + `IMG_0001.mov`（共享 ContentIdentifier UUID）

**响应（`format=samsung`）：** 单个 JPEG 文件流
- Content-Type: `image/jpeg`
- Content-Disposition: `attachment; filename="MVIMG_0001.jpg"`（文件名自动补 `MV` 前缀，Google Gallery 要求）
- 文件结构（对齐 Galaxy 真机样本）：`[JPEG 封面（含 Container XMP）] + [Samsung SEF footer（内嵌 MP4）]`
  - **三星 Gallery 靠文件尾部的 Samsung SEF footer 识别**，含三个字段（marker / 顺序对照真机）：`Image_UTC_Data`（`0x0A01`，UTC 毫秒）、`MotionPhoto_Info`（`0x0A32`，`{"auto-mode":{"types":"[motion]"}}`）、`MotionPhoto_Data`（`0x0A30`，视频），以 `SEFH`(version **107**)…`SEFT` 索引收尾
  - JPEG 内 XMP：`GCamera:MotionPhoto` + `Container:Directory`（Primary `image/jpeg` 带 `Item:Padding`，MotionPhoto `video/mp4` 带 `Item:Length`）
  - SEF 字节算法经真机样本反向验证：用真机字段可逐字节重建其原始 footer，故构造算法与三星固件一致

**错误：**

| 状态码 | 原因 |
|--------|------|
| 400 | 参数不合法（时长超限、cover_time 越界、format 非法等） |
| 500 | FFmpeg 处理失败，响应体包含错误日志 |

---

## 9. 删除会话

### `DELETE /session/{session_id}`

手动清理会话临时文件。正常情况下服务器会自动清理超时会话，此接口供前端主动触发。

**响应：** `200 OK`

```json
{
  "deleted": true
}
```
