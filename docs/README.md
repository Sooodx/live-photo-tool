# Live Photo Tool — 项目文档总览

LOG 视频套 LUT + 导出 Apple Live Photo 的本地 Web 工具。

## 文档目录

| 文件 | 内容 |
|------|------|
| `01-product-requirements.md` | 产品需求文档（PRD） |
| `02-technical-architecture.md` | 技术架构与实现方案 |
| `03-api-spec.md` | 前后端 API 接口规范 |
| `04-docker-deployment.md` | Docker 部署方案 |

## 一句话描述

用户在浏览器中上传 Panasonic V-Log MOV 文件，选择 LUT，预览色彩还原效果，裁剪片段，导出为 Apple Live Photo（HEIC + MOV）格式。整个工具通过 Docker 在本地运行，无需网络，保护隐私。

## 技术栈概览

- **前端**：HTML + Vanilla JS（无框架）
- **后端**：Python 3.11 + Flask
- **视频处理**：FFmpeg（容器内置）
- **部署**：Docker + docker-compose
- **输出格式**：HEIC（静态封面帧）+ MOV（视频片段），符合 Apple Live Photo 规范
