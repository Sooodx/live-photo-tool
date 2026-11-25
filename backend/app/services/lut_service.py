"""Catalog, validation and storage for built-in, mounted and uploaded LUTs."""

import math
import re
import uuid
from functools import lru_cache
from pathlib import Path
from typing import BinaryIO, Iterator
from urllib.parse import quote

from app.schemas import LutItem, LutUploadResponse
from app.services.session_manager import Session, copy_upload

BUILTIN_LUTS = [
    {
        "id": "VLog_to_V709",
        "name": "V-Log → V-709",
        "description": "Panasonic V-Log 转 Rec.709，标准还原",
    },
    {
        "id": "VLog_to_V709_Warm",
        "name": "V-Log → V-709 Warm",
        "description": "暖调版本，色温偏橙",
    },
    {
        "id": "VLog_to_V709_Cool",
        "name": "V-Log → V-709 Cool",
        "description": "冷调版本，色温偏蓝",
    },
    {
        "id": "SLog3_to_S709",
        "name": "S-Log3 → S-709",
        "description": "Sony S-Log3 转 Rec.709",
    },
    {
        "id": "SLog2_to_S709",
        "name": "S-Log2 → S-709",
        "description": "Sony S-Log2 转 Rec.709",
    },
    {
        "id": "LogC_to_Rec709",
        "name": "Log-C → Rec.709",
        "description": "ARRI Log-C 转 Rec.709",
    },
]
_BUILTIN_IDS = {item["id"] for item in BUILTIN_LUTS}


def read_cube_size(path: Path, *, validate: bool = True) -> int | None:
    """Read the declared 3D size and, for user files, verify the entire table."""
    size = None
    rows = 0
    try:
        with path.open(encoding="utf-8-sig") as source:
            for line in source:
                tokens = line.partition("#")[0].split()
                if not tokens:
                    continue
                command, *values = tokens
                command = command.upper()
                if command == "LUT_3D_SIZE":
                    if size is not None or values not in (["33"], ["65"]):
                        return None
                    size = int(values[0])
                    if not validate:
                        return size
                elif command == "TITLE" and not rows:
                    continue
                elif command in {"DOMAIN_MIN", "DOMAIN_MAX", "LUT_3D_INPUT_RANGE"} and not rows:
                    expected = 2 if command == "LUT_3D_INPUT_RANGE" else 3
                    if len(values) != expected or not all(math.isfinite(float(v)) for v in values):
                        return None
                else:
                    if size is None or len(tokens) != 3 or rows >= size**3:
                        return None
                    if not all(math.isfinite(float(value)) for value in tokens):
                        return None
                    rows += 1
    except (OSError, ValueError):
        return None
    return size if size is not None and rows == size**3 else None


@lru_cache(maxsize=128)
def _mounted_size(path: Path, modified: int, changed: int, size: int) -> int | None:
    # File metadata invalidates validation when a mounted LUT is edited or replaced.
    return read_cube_size(path)


def raw_url(lut_id: str, session_id: str | None = None) -> str:
    path = f"/api/luts/{quote(lut_id, safe='')}/raw"
    return f"{path}?session_id={quote(session_id, safe='')}" if session_id else path


class LutService:
    def __init__(self, luts_dir: Path) -> None:
        self.luts_dir = luts_dir

    def user_luts(self) -> Iterator[tuple[LutItem, Path]]:
        directory = (self.luts_dir / "user").resolve()
        if not directory.is_dir():
            return
        ids: set[str] = set()
        for file in sorted(directory.iterdir()):
            if file.suffix.lower() != ".cube" or not file.is_file():
                continue
            path = file.resolve()
            if not path.is_relative_to(directory):
                continue
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            size = _mounted_size(path, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
            if size is None:
                continue
            stem = re.sub(r"[^\w-]+", "_", file.stem).strip("_") or "lut"
            base_id = f"user_{stem}"
            lut_id = base_id
            suffix = 2
            while lut_id in ids:
                lut_id = f"{base_id}_{suffix}"
                suffix += 1
            ids.add(lut_id)
            yield LutItem(
                id=lut_id, name=file.stem, description="挂载目录 LUT",
                source="user", size=size, raw_url=raw_url(lut_id),
            ), path

    def list(self, session: Session | None) -> list[LutItem]:
        items = []
        for meta in BUILTIN_LUTS:
            lut_id = meta["id"]
            size = read_cube_size(self.luts_dir / f"{lut_id}.cube", validate=False)
            if size is not None:
                items.append(LutItem(**meta, source="builtin", size=size, raw_url=raw_url(lut_id)))
        items.extend(item for item, _ in self.user_luts())
        if session is not None:
            items.extend(session.custom_luts())
        return items

    def resolve(self, lut_id: str | None, session: Session | None) -> Path | None:
        if not lut_id:
            return None
        if lut_id in _BUILTIN_IDS:
            path = self.luts_dir / f"{lut_id}.cube"
            return path if path.is_file() else None
        if lut_id.startswith("user_"):
            return next((path for item, path in self.user_luts() if item.id == lut_id), None)
        if session is not None:
            path = session.custom_lut_path(lut_id)
            if path is not None and path.is_file():
                return path
        return None

    def upload(
        self, session: Session, filename: str, source: BinaryIO, max_bytes: int
    ) -> LutUploadResponse:
        lut_id = f"custom_{uuid.uuid4().hex}"
        path = session.custom_luts_dir / f"{lut_id}.cube"
        try:
            copy_upload(source, path, max_bytes)
            size = read_cube_size(path)
            if size is None:
                raise ValueError("不是有效的 .cube 文件，或 LUT size 不支持（仅 33 / 65 点）")
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        url = raw_url(lut_id, session.session_id)
        session.add_lut(LutItem(
            id=lut_id, name=filename, description="用户上传", source="custom",
            size=size, raw_url=url,
        ))
        return LutUploadResponse(lut_id=lut_id, name=filename, size=size, raw_url=url)
