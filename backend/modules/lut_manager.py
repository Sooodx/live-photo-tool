"""LUT 管理：内置 LUT 列表 + 会话级自定义 .cube 文件。"""
from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Optional

from config import LUTS_DIR
from modules.session_manager import Session

# 内置 LUT 元数据（id 对应 luts/{id}.cube）
BUILTIN_LUTS = [
    {
        "id": "VLog_to_V709",
        "name": "V-Log → V-709",
        "description": "Panasonic V-Log 转 Rec.709，标准还原",
        "source": "builtin",
    },
    {
        "id": "VLog_to_V709_Warm",
        "name": "V-Log → V-709 Warm",
        "description": "暖调版本，色温偏橙",
        "source": "builtin",
    },
    {
        "id": "VLog_to_V709_Cool",
        "name": "V-Log → V-709 Cool",
        "description": "冷调版本，色温偏蓝",
        "source": "builtin",
    },
    {
        "id": "SLog3_to_S709",
        "name": "S-Log3 → S-709",
        "description": "Sony S-Log3 转 Rec.709",
        "source": "builtin",
    },
    {
        "id": "SLog2_to_S709",
        "name": "S-Log2 → S-709",
        "description": "Sony S-Log2 转 Rec.709",
        "source": "builtin",
    },
    {
        "id": "LogC_to_Rec709",
        "name": "Log-C → Rec.709",
        "description": "ARRI Log-C 转 Rec.709",
        "source": "builtin",
    },
]

_CUBE_SIZE_RE = re.compile(r"^\s*LUT_3D_SIZE\s+(\d+)", re.IGNORECASE | re.MULTILINE)


def _read_cube_size(path: Path) -> Optional[int]:
    """读取 .cube 文件声明的 LUT_3D_SIZE，无法解析返回 None。"""
    try:
        text = path.read_text(errors="ignore")
    except OSError:
        return None
    m = _CUBE_SIZE_RE.search(text)
    return int(m.group(1)) if m else None


def validate_cube(path: Path) -> tuple[bool, Optional[int]]:
    """校验 .cube 文件是否合法，返回 (是否有效, size)。"""
    size = _read_cube_size(path)
    if size is None:
        return False, None
    # 仅支持 33 点或 65 点
    if size not in (33, 65):
        return False, size
    return True, size


def list_luts(session: Optional[Session] = None) -> list[dict]:
    """返回所有可用 LUT（内置 + 会话自定义）。"""
    result: list[dict] = []
    for meta in BUILTIN_LUTS:
        path = LUTS_DIR / f"{meta['id']}.cube"
        result.append({**meta, "size": _read_cube_size(path) or 33})

    if session is not None:
        for lut_id, info in session.custom_luts.items():
            result.append(
                {
                    "id": lut_id,
                    "name": info["name"],
                    "description": "用户上传",
                    "source": "custom",
                    "size": info.get("size", 0),
                }
            )
    return result


def resolve_lut_path(lut_id: str, session: Optional[Session] = None) -> Optional[Path]:
    """根据 lut_id 返回 .cube 文件路径，找不到返回 None。"""
    if session is not None and lut_id in session.custom_luts:
        return Path(session.custom_luts[lut_id]["path"])

    if any(b["id"] == lut_id for b in BUILTIN_LUTS):
        path = LUTS_DIR / f"{lut_id}.cube"
        return path if path.exists() else None

    return None


def register_custom_lut(session: Session, filename: str, src_path: Path) -> dict:
    """把上传的 .cube 文件登记到会话，返回 {lut_id, name, size}。"""
    valid, size = validate_cube(src_path)
    if not valid:
        raise ValueError("不是有效的 .cube 文件，或 LUT size 不支持（仅 33 / 65 点）")

    lut_id = f"custom_{uuid.uuid4().hex[:8]}"
    dst = session.custom_luts_dir / f"{lut_id}.cube"
    dst.write_bytes(src_path.read_bytes())

    session.custom_luts[lut_id] = {
        "name": filename,
        "path": str(dst),
        "size": size,
    }
    return {"lut_id": lut_id, "name": filename, "size": size}
