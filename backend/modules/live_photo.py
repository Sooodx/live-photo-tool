"""Apple Live Photo 封装逻辑。

将封面帧 PNG 转为 HEIC 并写入 Apple XMP 元数据，
同时向 MOV 的 moov/udta 注入相同的 ContentIdentifier UUID。
两者 UUID 一致，iOS 相册据此把 HEIC + MOV 配对为 Live Photo。
"""
from __future__ import annotations

import struct
import subprocess
import uuid
import zipfile
from io import BytesIO
from pathlib import Path

# Apple 用于标记 Live Photo 静态帧的 XMP（apple_desktop 命名空间）
_XMP_TEMPLATE = """<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:apple_desktop="http://ns.apple.com/namespace/1.0/">
      <apple_desktop:ContentIdentifier>{uuid}</apple_desktop:ContentIdentifier>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>"""


def new_content_identifier() -> str:
    """生成一个大写 UUID 作为 Live Photo 配对标识。"""
    return str(uuid.uuid4()).upper()


def png_to_heic(png_path: Path, heic_path: Path, content_id: str) -> Path:
    """将封面 PNG 转为 HEIC，并写入 Apple Live Photo XMP。

    若 pillow-heif 不可用，降级为 JPEG（iOS 仍可识别，兼容性略低）。
    返回实际生成文件的路径（可能是 .jpg）。
    """
    from PIL import Image

    img = Image.open(png_path).convert("RGB")
    xmp = _XMP_TEMPLATE.format(uuid=content_id).encode("utf-8")

    try:
        import pillow_heif  # noqa: F401

        pillow_heif.register_heif_opener()
        img.save(heic_path, format="HEIF", quality=95)
        _write_xmp(heic_path, xmp)
        return heic_path
    except Exception:  # noqa: BLE001 - 降级到 JPEG
        jpg_path = heic_path.with_suffix(".jpg")
        img.save(jpg_path, format="JPEG", quality=95, xmp=xmp)
        return jpg_path


def _write_xmp(heic_path: Path, xmp: bytes) -> None:
    """尝试用 pillow-heif 写入 XMP；失败则忽略（不影响主流程）。"""
    try:
        import pillow_heif

        heif = pillow_heif.open_heif(str(heic_path))
        heif.info["xmp"] = xmp
        heif.save(str(heic_path))
    except Exception:  # noqa: BLE001
        pass


def inject_mov_content_id(mov_path: Path, content_id: str) -> None:
    """向 MOV 的 moov/udta 注入 com.apple.quicktime.content.identifier。

    使用 ffmpeg 的 metadata 选项写入，避免手工拼接 atom 二进制。
    """
    tmp = mov_path.with_name(mov_path.stem + "_meta" + mov_path.suffix)
    cmd = [
        "ffmpeg", "-y",
        "-i", str(mov_path),
        "-map_metadata", "0",
        "-metadata", f"com.apple.quicktime.content.identifier={content_id}",
        "-c", "copy",
        "-movflags", "use_metadata_tags+faststart",
        str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"注入 MOV 元数据失败:\n{proc.stderr[-2000:]}")
    tmp.replace(mov_path)


def pack_zip(zip_path: Path, files: list[Path], base_name: str) -> Path:
    """把 HEIC/JPEG + MOV 打包为 ZIP（内部文件同名，仅扩展名不同）。"""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            arcname = f"{base_name}{f.suffix}"
            zf.write(f, arcname=arcname)
    return zip_path


# ---------------------------------------------------------------------------
# Samsung / Google Motion Photo
# ---------------------------------------------------------------------------
# 文件布局：[JPEG 封面（含 Container XMP）] + [Samsung SEF footer（内嵌 MP4）]
#
# 字段集与 SEF 字节布局对照真机样本（Galaxy 实拍动态照片，SEFH version 107）反向工程：
# 用真机的字段重建其 footer 可逐字节复现，故此构造算法与三星固件一致。
# 采用核心字段（去掉 HDR GainMap / AutoPlay 预览 / 相机专有元数据）：
#   Image_UTC_Data   (marker 0x0A01) = 拍摄 UTC 毫秒时间戳
#   MotionPhoto_Info (marker 0x0A32) = {"auto-mode":{"types":"[motion]"}}
#   MotionPhoto_Data (marker 0x0A30) = 视频字节（最后一个字段）
# 以 SEFH(version 107)…SEFT 索引收尾。
# JPEG 内 XMP：GCamera:MotionPhoto + Container:Directory（Primary + MotionPhoto）。

_SEF_VERSION = 107
_SEF_MARKERS = {
    "Image_UTC_Data": b"\x00\x00\x01\x0a",
    "MotionPhoto_Info": b"\x00\x00\x32\x0a",
    "MotionPhoto_Data": b"\x00\x00\x30\x0a",
}
# 真机里动态照片的 Info 字段固定 JSON
_MOTION_PHOTO_INFO = b'{"auto-mode":{"types":"[motion]"}}'

# Container 形式：Primary(JPEG, 仅 Padding) + MotionPhoto(MP4, Length)，与真机 XMP 同构
_MOTION_PHOTO_XMP = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:Container="http://ns.google.com/photos/1.0/container/"
        xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
        xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
      GCamera:MotionPhoto="1"
      GCamera:MotionPhotoVersion="1"
      GCamera:MotionPhotoPresentationTimestampUs="{ts}">
      <Container:Directory>
        <rdf:Seq>
          <rdf:li rdf:parseType="Resource">
            <Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg" Item:Padding="{pad}"/>
          </rdf:li>
          <rdf:li rdf:parseType="Resource">
            <Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="{vsize}" Item:Padding="0"/>
          </rdf:li>
        </rdf:Seq>
      </Container:Directory>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""

_XMP_APP1_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"


def _insert_xmp_app1(jpeg_bytes: bytes, xmp: bytes) -> bytes:
    """把 XMP 作为 APP1 段插入到 JPEG 的 SOI 之后（版本无关，手工拼接）。"""
    payload = _XMP_APP1_HEADER + xmp
    seg_len = len(payload) + 2  # 段长包含长度字段自身 2 字节
    if seg_len > 0xFFFF:
        raise ValueError("XMP 过大，无法放入单个 APP1 段")
    app1 = b"\xff\xe1" + seg_len.to_bytes(2, "big") + payload
    # jpeg_bytes[:2] 是 SOI(FFD8)
    return jpeg_bytes[:2] + app1 + jpeg_bytes[2:]


def build_samsung_footer(video_bytes: bytes, utc_ms: int) -> tuple[bytes, int, int]:
    """构造 Samsung SEF footer，返回 (footer_bytes, image_padding, video_size)。

    image_padding：footer 中视频数据之前的字节数（= Primary Item 的 Item:Padding）。
    video_size：视频起点到文件末尾的字节数（= MotionPhoto Item 的 Item:Length）。

    每个字段：[marker(4)][name_len(i32le)][name][data]
    SEFH 索引：["SEFH"][version(i32le)][count(i32le)]
               每字段 [marker(4)][offset_to_footer_end(i32le)][field_len(i32le)]
               [sefh_len(i32le)]["SEFT"]
    其中 offset_to_footer_end 为「该字段起点到所有字段数据末尾（SEFH 之前）」的字节数。
    """
    # 物理顺序：视频字段 MotionPhoto_Data 放最后
    fields = [
        ("Image_UTC_Data", str(utc_ms).encode()),
        ("MotionPhoto_Info", _MOTION_PHOTO_INFO),
        ("MotionPhoto_Data", video_bytes),
    ]
    order = [name for name, _ in fields]

    tag_data = b""
    offsets: dict[str, int] = {}
    lengths: dict[str, int] = {}
    for name, payload in fields:
        block = _SEF_MARKERS[name] + struct.pack("<i", len(name)) + name.encode() + payload
        tag_data += block
        lengths[name] = len(block)
        # 每写入一个字段，把它的长度累加到「该字段及之前所有字段」的偏移上
        for pre in order:
            offsets[pre] = len(block) + offsets.get(pre, 0)
            if pre == name:
                break

    sefh = b"SEFH" + struct.pack("<i", _SEF_VERSION) + struct.pack("<i", len(fields))
    for name, _ in fields:
        sefh += _SEF_MARKERS[name] + struct.pack("<i", offsets[name]) + struct.pack("<i", lengths[name])
    sefh += struct.pack("<i", len(sefh)) + b"SEFT"

    footer = tag_data + sefh
    # 视频数据之前的字节：前置字段全长 + MotionPhoto_Data 字段头(marker4 + name_len4 + name16)
    image_padding = (
        lengths["Image_UTC_Data"]
        + lengths["MotionPhoto_Info"]
        + 4 + 4 + len("MotionPhoto_Data")
    )
    video_size = len(footer) - image_padding
    return footer, image_padding, video_size


def create_motion_photo(
    cover_png: Path,
    clip_mp4: Path,
    dst_jpg: Path,
    presentation_ts_us: int = -1,
) -> Path:
    """生成三星 Motion Photo：JPEG 封面（含 Container XMP）+ 末尾 Samsung SEF footer（内嵌 MP4）。

    presentation_ts_us：静态封面帧在视频中的时间点（微秒），-1 表示不指定。
    """
    import time

    from PIL import Image

    video_bytes = Path(clip_mp4).read_bytes()
    utc_ms = int(time.time() * 1000)
    footer, image_padding, video_size = build_samsung_footer(video_bytes, utc_ms)

    xmp = _MOTION_PHOTO_XMP.format(
        ts=int(presentation_ts_us), pad=image_padding, vsize=video_size
    ).encode("utf-8")

    img = Image.open(cover_png).convert("RGB")
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=95)
    jpeg_with_xmp = _insert_xmp_app1(buf.getvalue(), xmp)

    Path(dst_jpg).write_bytes(jpeg_with_xmp + footer)
    return Path(dst_jpg)
