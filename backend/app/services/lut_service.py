"""Catalog, validation and persistent storage for LUTs."""

import errno
import os
import re
import stat
import tempfile
import uuid
from functools import lru_cache
from pathlib import Path, PureWindowsPath
from typing import BinaryIO, Iterator
from urllib.parse import quote

from app.config import BACKEND_DIR
from app.schemas import BuiltinLutDetails, LutItem, LutUploadResponse
from app.services.session_manager import copy_upload

_UPLOAD_ID = re.compile(r"custom_[0-9a-f]{32}")
_TITLE = re.compile(r'TITLE\s+"[^"]*"\s*(?:#.*)?', re.IGNORECASE)
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_MAX_FLOAT32 = float.fromhex("0x1.fffffep+127")

_BUILTIN_DIR = BACKEND_DIR / "luts" / "builtin"
_CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/"
_DAEDAL_CINEMATIC = BuiltinLutDetails(
    input_color_space="Rec.709 SDR",
    upstream="DAEDAL Cinematic Looks",
    version="v1",
    source_url="https://daedal.art/resources/cinematic-pack/",
    license="CC0 1.0",
    license_url=_CC0_URL,
)
_DAEDAL_FILM_AND_MONO = BuiltinLutDetails(
    input_color_space="Rec.709 SDR",
    upstream="DAEDAL Film & Mono",
    version="v1",
    source_url="https://daedal.art/resources/film-and-mono-pack/",
    license="CC0 1.0",
    license_url=_CC0_URL,
)
_BUILTIN_LUTS = {
    "DAEDAL_01_Teal_Orange.cube": (
        "builtin_daedal_teal_orange", "青橙电影 · Teal & Orange",
        "青色阴影与暖橙高光，适合旅行和剧情片段。", _DAEDAL_CINEMATIC,
    ),
    "DAEDAL_03_Portrait_400.cube": (
        "builtin_daedal_portrait_400", "柔和人像 · Portrait 400",
        "柔和对比与偏暖的肤色，适合人像和日常记录。", _DAEDAL_FILM_AND_MONO,
    ),
    "DAEDAL_06_Home_Movie.cube": (
        "builtin_daedal_home_movie", "暖调复古 · Home Movie",
        "暖色调与抬高的黑位，适合复古风格的家庭影像。", _DAEDAL_FILM_AND_MONO,
    ),
    "DAEDAL_08_Mono_Contrast.cube": (
        "builtin_daedal_mono_contrast", "高反差黑白 · Mono Contrast",
        "深阴影与明亮高光，适合强调光影和轮廓。", _DAEDAL_FILM_AND_MONO,
    ),
}


def _cube_value(token: str) -> float:
    if not _DECIMAL.fullmatch(token):
        raise ValueError("Invalid cube value")
    value = float(token)
    if abs(value) > _MAX_FLOAT32:
        raise ValueError("Cube value out of range")
    return value


def read_cube_size(path: Path) -> int | None:
    """Read the declared 3D size and verify the entire table."""
    size = None
    rows = 0
    title_seen = False
    domains: dict[str, tuple[float, ...]] = {}
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
                elif command == "TITLE":
                    if rows or title_seen or not _TITLE.fullmatch(line.strip()):
                        return None
                    title_seen = True
                elif command in {"DOMAIN_MIN", "DOMAIN_MAX", "LUT_3D_INPUT_RANGE"}:
                    expected = 2 if command == "LUT_3D_INPUT_RANGE" else 3
                    if rows or command in domains or len(values) != expected:
                        return None
                    domains[command] = tuple(_cube_value(value) for value in values)
                else:
                    if size is None or len(tokens) != 3 or rows >= size**3:
                        return None
                    for token in tokens:
                        _cube_value(token)
                    rows += 1
    except (OSError, ValueError):
        return None
    domain_min = domains.get("DOMAIN_MIN", (0, 0, 0))
    domain_max = domains.get("DOMAIN_MAX", (1, 1, 1))
    if any(low >= high for low, high in zip(domain_min, domain_max)):
        return None
    input_range = domains.get("LUT_3D_INPUT_RANGE")
    if input_range is not None and input_range[0] >= input_range[1]:
        return None
    return size if size is not None and rows == size**3 else None


@lru_cache(maxsize=128)
def _cached_cube_size(path: Path, modified: int, changed: int, size: int) -> int | None:
    # File metadata invalidates validation when a library LUT is edited or replaced.
    return read_cube_size(path)


def _cube_files(directory: Path) -> Iterator[tuple[Path, Path, int]]:
    directory = directory.resolve()
    try:
        files = sorted(directory.iterdir())
    except (FileNotFoundError, NotADirectoryError):
        return
    for file in files:
        if file.suffix.lower() != ".cube":
            continue
        try:
            file.name.encode("utf-8")
            path = file.resolve(strict=True)
            if not path.is_relative_to(directory):
                continue
            metadata = path.stat()
        except (OSError, RuntimeError, UnicodeError):
            continue
        if stat.S_ISREG(metadata.st_mode):
            size = _cached_cube_size(path, metadata.st_mtime_ns, metadata.st_ctime_ns, metadata.st_size)
            if size is not None:
                yield file, path, size


def raw_url(lut_id: str) -> str:
    return f"/api/luts/{quote(lut_id, safe='')}/raw"


def _builtin_luts() -> Iterator[tuple[LutItem, Path]]:
    for file, path, size in _cube_files(_BUILTIN_DIR):
        entry = _BUILTIN_LUTS.get(file.name)
        if entry is not None:
            lut_id, name, description, details = entry
            yield LutItem(
                id=lut_id, name=name, description=description, source="builtin",
                size=size, raw_url=raw_url(lut_id), builtin=details,
            ), path


class LutService:
    def __init__(self, luts_dir: Path) -> None:
        self.user_dir = luts_dir / "user"
        self.uploads_dir = self.user_dir / "uploads"

    def _mounted_luts(self) -> Iterator[tuple[LutItem, Path]]:
        ids: set[str] = set()
        for file, path, size in _cube_files(self.user_dir):
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

    def _uploaded_lut(self, entry: Path) -> tuple[LutItem, Path] | None:
        lut_id = entry.name
        if not _UPLOAD_ID.fullmatch(lut_id) or entry.is_symlink():
            return None
        for file, path, size in _cube_files(entry):
            return LutItem(
                id=lut_id, name=file.name, description="用户上传",
                source="custom", size=size, raw_url=raw_url(lut_id),
            ), path
        return None

    def list(self) -> list[LutItem]:
        items = [item for item, _ in _builtin_luts()]
        items.extend(item for item, _ in self._mounted_luts())
        if not self.uploads_dir.is_symlink() and self.uploads_dir.is_dir():
            for entry in sorted(self.uploads_dir.iterdir()):
                uploaded = self._uploaded_lut(entry)
                if uploaded is not None:
                    items.append(uploaded[0])
        return items

    def resolve(self, lut_id: str | None) -> Path | None:
        if not lut_id:
            return None
        if lut_id.startswith("builtin_"):
            return next((path for item, path in _builtin_luts() if item.id == lut_id), None)
        if lut_id.startswith("user_"):
            return next((path for item, path in self._mounted_luts() if item.id == lut_id), None)
        if _UPLOAD_ID.fullmatch(lut_id) and not self.uploads_dir.is_symlink():
            uploaded = self._uploaded_lut(self.uploads_dir / lut_id)
            if uploaded is not None:
                return uploaded[1]
        return None

    def upload(self, filename: str, source: BinaryIO, max_bytes: int) -> LutUploadResponse:
        if Path(filename).suffix.lower() != ".cube":
            raise ValueError("仅支持 .cube 文件")
        if PureWindowsPath(filename).is_reserved() or any(
            char in '/\\:*?"<>|' or ord(char) < 32 for char in filename
        ):
            raise ValueError("LUT 文件名无效")
        if self.uploads_dir.is_symlink():
            raise OSError("LUT uploads directory must not be a symlink")
        self.uploads_dir.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix=".upload-", dir=self.uploads_dir) as temporary:
            entry = Path(temporary) / "lut"
            entry.mkdir()
            path = entry / filename
            try:
                copy_upload(source, path, max_bytes)
            except OSError as exc:
                if exc.errno in (errno.ENAMETOOLONG, errno.EINVAL):
                    raise ValueError("LUT 文件名无效或过长") from exc
                raise
            size = read_cube_size(path)
            if size is None:
                raise ValueError("不是有效的 .cube 文件，或 LUT size 不支持（仅 33 / 65 点）")

            # Rename the complete entry on the same filesystem. An existing LUT's
            # directory is nonempty, so a concurrent rename cannot replace it.
            while True:
                lut_id = f"custom_{uuid.uuid4().hex}"
                destination = self.uploads_dir / lut_id
                if os.path.lexists(destination):
                    continue
                try:
                    entry.rename(destination)
                except OSError as exc:
                    if exc.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                        raise
                else:
                    break
        return LutUploadResponse(lut_id=lut_id, name=filename, size=size, raw_url=raw_url(lut_id))
