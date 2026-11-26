"""Request and response models for the media API."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_validator


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class VideoMetadata(BaseModel):
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool


class UploadResponse(VideoMetadata):
    session_id: str
    filename: str
    status: Literal["processing"] = "processing"


class SessionStatus(BaseModel):
    model_config = ConfigDict(frozen=True)

    session_id: str
    status: Literal["processing", "ready", "error"] = "processing"
    proxy_progress: int = Field(default=0, ge=0, le=100)
    stage: Literal["proxy", "thumbnails", "ready", "error"] = "proxy"
    error: str | None = None


class ThumbnailItem(BaseModel):
    index: int
    time: float
    url: str


class ThumbnailsResponse(BaseModel):
    count: int
    fps_sample: Literal[1] = 1
    width: int
    height: Literal[90] = 90
    items: list[ThumbnailItem]


class BuiltinLutDetails(BaseModel):
    input_color_space: str
    upstream: str
    version: str
    source_url: str
    license: str
    license_url: str


class LutItem(BaseModel):
    id: str
    name: str
    description: str
    source: Literal["builtin", "user", "custom"]
    size: int
    raw_url: str
    builtin: BuiltinLutDetails | None = None


class LutsResponse(BaseModel):
    luts: list[LutItem]


class LutUploadResponse(BaseModel):
    lut_id: str
    name: str
    size: int
    valid: Literal[True] = True
    raw_url: str


class Adjustments(BaseModel):
    exposure: FiniteFloat = 0
    contrast: FiniteFloat = 0
    highlights: FiniteFloat = 0
    shadows: FiniteFloat = 0
    whites: FiniteFloat = 0
    blacks: FiniteFloat = 0

    @field_validator("*")
    @classmethod
    def clamp(cls, value: float) -> float:
        return max(-100.0, min(100.0, value))


class GradeRequest(BaseModel):
    lut_id: str | None = None
    lut_intensity: FiniteFloat = 1.0
    adjustments: Adjustments | None = None


class PreviewFrameRequest(GradeRequest):
    time: FiniteFloat = 0.0


class PreviewClipRequest(GradeRequest):
    in_point: FiniteFloat
    out_point: FiniteFloat


class ExportRequest(PreviewClipRequest):
    cover_time: FiniteFloat
    format: Literal["apple", "samsung"] = "apple"
    output_name: str = "IMG_0001"


class DeleteResponse(BaseModel):
    deleted: bool
