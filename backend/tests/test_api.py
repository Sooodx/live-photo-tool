"""Exercise the HTTP API with actual FFmpeg and HEIF output."""

import asyncio
import json
import shutil
import struct
import subprocess
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from threading import Event
from uuid import UUID
from xml.etree import ElementTree
from zipfile import ZipFile

import httpx
import pillow_heif
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import BACKEND_DIR, Settings
from app.main import create_app
from app.services import ffmpeg_service


BUILTINS = {
    "VLog_to_V709", "VLog_to_V709_Warm", "VLog_to_V709_Cool",
    "SLog3_to_S709", "SLog2_to_S709", "LogC_to_Rec709",
}
GRADE = {
    "lut_id": "VLog_to_V709",
    "lut_intensity": 0.5,
    "adjustments": {
        "exposure": 10, "contrast": -20, "highlights": 120,
        "shadows": -25, "whites": 12, "blacks": 10,
    },
}
CLIP = {"in_point": 0.25, "out_point": 1.25, **GRADE}


def probe(path: Path) -> dict:
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path),
    ]))


def status_events(response):
    assert response.status_code == 200, response.text
    return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


@pytest.fixture(scope="module")
def source_video(tmp_path_factory):
    path = tmp_path_factory.mktemp("source") / "portrait.MOV"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc=size=1152x2048:rate=12",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "4", "-c:v", "libx264", "-threads:v", "4", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-timecode", "01:00:00:00",
        "-f", "mov", str(path),
    ], check=True)
    assert any(stream.get("codec_tag_string") == "tmcd" for stream in probe(path)["streams"])
    return path


@pytest.fixture(scope="module")
def settings(tmp_path_factory):
    root = tmp_path_factory.mktemp("app")
    luts_dir = root / "luts"
    shutil.copytree(BACKEND_DIR / "luts", luts_dir, ignore=shutil.ignore_patterns("user"))
    user_dir = luts_dir / "user"
    user_dir.mkdir()
    shutil.copyfile(luts_dir / "VLog_to_V709.cube", user_dir / "Film Grade.cube")
    (user_dir / "broken.cube").write_text("LUT_3D_SIZE 33\n0 0 0\n")
    static_dir = root / "static"
    (static_dir / "assets").mkdir(parents=True)
    (static_dir / "index.html").write_text("<title>Live Photo Tool</title>")
    (static_dir / "assets" / "app.js").write_text("export {};")
    return Settings(
        workspace_dir=root / "workspace", uploads_dir=root / "uploads",
        static_dir=static_dir, luts_dir=luts_dir,
    )


@pytest.fixture(scope="module")
def client(settings):
    with TestClient(create_app(settings)) as http:
        yield http


def upload(client, path: Path):
    with path.open("rb") as file:
        response = client.post("/api/upload", files={"file": (path.name, file, "video/quicktime")})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def session(client, source_video):
    info = upload(client, source_video)
    base = f"/api/session/{info['session_id']}"
    response = client.get(base + "/events")
    return info, base, response


def test_health_static_spa_and_cors(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/").text == "<title>Live Photo Tool</title>"
    assert client.get("/editor/deep-link").text == "<title>Live Photo Tool</title>"
    assert client.get("/assets/app.js").text == "export {};"
    assert client.get("/assets/missing.js").status_code == 404
    assert client.get("/api/missing").status_code == 404
    assert client.get("/api").status_code == 404
    assert "Swagger UI" in client.get("/docs").text
    assert "/api/health" in client.get("/openapi.json").json()["paths"]
    preflight = client.options("/api/upload", headers={
        "Origin": "https://frontend.example", "Access-Control-Request-Method": "POST",
    })
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "*"


def test_builtin_and_mounted_luts(client, settings):
    response = client.get("/api/luts")
    assert response.status_code == 200
    items = response.json()["luts"]
    assert {item["id"] for item in items if item["source"] == "builtin"} == BUILTINS
    assert [item for item in items if item["source"] == "user"] == [{
        "id": "user_Film_Grade", "name": "Film Grade", "description": "挂载目录 LUT",
        "source": "user", "size": 33, "raw_url": "/api/luts/user_Film_Grade/raw",
    }]
    for lut_id, path in (
        ("VLog_to_V709", settings.luts_dir / "VLog_to_V709.cube"),
        ("user_Film_Grade", settings.luts_dir / "user" / "Film Grade.cube"),
    ):
        raw = client.get(f"/api/luts/{lut_id}/raw")
        assert raw.status_code == 200
        assert raw.headers["content-type"] == "text/plain; charset=utf-8"
        assert raw.headers["cache-control"] == "public, max-age=3600"
        assert raw.content == path.read_bytes()
    assert client.get("/api/luts/user_broken/raw").status_code == 404


def test_upload_progress_proxy_range_and_thumbnails(client, session, tmp_path):
    info, base, response = session
    assert info == {
        "session_id": info["session_id"], "filename": "portrait.MOV", "duration": 4.0,
        "width": 1152, "height": 2048, "fps": 12.0, "has_audio": True, "status": "processing",
    }
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"

    states = status_events(response)
    assert states[-1] == {
        "session_id": info["session_id"], "status": "ready", "proxy_progress": 100,
        "stage": "ready", "error": None,
    }
    assert any(state["stage"] == "proxy" and 0 < state["proxy_progress"] < 80 for state in states)
    assert any(state["stage"] == "thumbnails" for state in states)
    percentages = [state["proxy_progress"] for state in states]
    assert sorted(percentages) == percentages
    assert client.get(base + "/status").json() == states[-1]
    assert status_events(client.get(base + "/events")) == [states[-1]]

    proxy = client.get(base + "/proxy")
    assert proxy.status_code == 200
    assert proxy.headers["content-type"] == "video/mp4"
    chunk = client.get(base + "/proxy", headers={"Range": "bytes=0-63"})
    assert chunk.status_code == 206
    assert chunk.headers["content-range"] == f"bytes 0-63/{len(proxy.content)}"
    assert chunk.content == proxy.content[:64]
    path = tmp_path / "proxy.mp4"
    path.write_bytes(proxy.content)
    streams = probe(path)["streams"]
    assert [stream["codec_type"] for stream in streams] == ["video", "audio"]
    assert (streams[0]["width"], streams[0]["height"]) == (720, 1280)

    result = client.get(base + "/thumbnails").json()
    assert result == {
        "count": 4, "fps_sample": 1, "width": 50, "height": 90,
        "items": [
            {"index": i, "time": float(i - 1), "url": f"{base}/thumbnails/{i:04d}.jpg"}
            for i in range(1, 5)
        ],
    }
    thumbnail = client.get(result["items"][0]["url"])
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"] == "image/jpeg"
    assert thumbnail.headers["cache-control"] == "public, max-age=3600"
    with Image.open(BytesIO(thumbnail.content)) as image:
        assert image.size == (50, 90)
    assert client.get(base + "/thumbnails/%2e%2e%2fproxy.mp4").status_code == 404
    assert client.get(base + "/thumbnails/9999.jpg").status_code == 404


def test_custom_lut_upload_and_validation(client, session, settings):
    info, base, _ = session
    lut_bytes = (settings.luts_dir / "VLog_to_V709.cube").read_bytes()
    response = client.post(base + "/lut/upload", files={"file": ("Custom.CUBE", lut_bytes)})
    assert response.status_code == 200, response.text
    data = response.json()
    url = f"/api/luts/{data['lut_id']}/raw?session_id={info['session_id']}"
    assert data == {
        "lut_id": data["lut_id"], "name": "Custom.CUBE", "size": 33, "valid": True, "raw_url": url,
    }
    assert data["lut_id"].startswith("custom_")
    assert client.get(url).content == lut_bytes
    assert client.get(url.split("?")[0]).status_code == 404
    luts = client.get("/api/luts", params={"session_id": info["session_id"]}).json()["luts"]
    assert [item for item in luts if item["source"] == "custom"] == [{
        "id": data["lut_id"], "name": "Custom.CUBE", "description": "用户上传",
        "source": "custom", "size": 33, "raw_url": url,
    }]

    for filename, contents in (
        ("wrong.txt", lut_bytes), ("wrong_size.cube", b"LUT_3D_SIZE 17\n"),
        ("incomplete.cube", b"LUT_3D_SIZE 33\n0 0 0\n"),
    ):
        invalid = client.post(base + "/lut/upload", files={"file": (filename, contents)})
        assert invalid.status_code == 400
        assert "detail" in invalid.json()
    assert len(list((settings.workspace_dir / info["session_id"] / "custom_luts").iterdir())) == 1


def test_preview_frames_with_grading_and_unique_outputs(client, session, settings):
    info, base, _ = session

    def render(timestamp):
        return client.post(base + "/preview-frame", json={"time": timestamp, **GRADE})

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.map(render, (0.25, 1.25))
    for response in (first, second):
        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "image/jpeg"
        with Image.open(BytesIO(response.content)) as image:
            assert image.size == (720, 1280)
    assert first.content != second.content
    assert client.post(base + "/preview-frame", json={}).status_code == 200
    assert not list((settings.workspace_dir / info["session_id"] / "output").iterdir())


def test_preview_clip_keeps_audio_and_cleans_up(client, session, settings, tmp_path):
    info, base, _ = session
    response = client.post(base + "/preview-clip", json=CLIP)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "video/mp4"
    assert not list((settings.workspace_dir / info["session_id"] / "output").iterdir())
    path = tmp_path / "preview.mp4"
    path.write_bytes(response.content)
    data = probe(path)
    video, audio = data["streams"]
    assert (video["codec_type"], video["width"], video["height"]) == ("video", 720, 1280)
    assert (audio["codec_type"], audio["codec_name"]) == ("audio", "aac")
    assert float(data["format"]["duration"]) == pytest.approx(1.0, abs=0.1)


def test_apple_export_pairs_heic_xmp_with_mov_uuid(client, session, settings, tmp_path):
    info, base, _ = session
    response = client.post(
        base + "/export", json={**CLIP, "cover_time": 0.5, "output_name": "../Trip ?1"}
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == 'attachment; filename="Trip1.zip"'
    assert not list((settings.workspace_dir / info["session_id"] / "output").iterdir())
    with ZipFile(BytesIO(response.content)) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == {"Trip1.heic", "Trip1.mov"}
        mov = tmp_path / "Trip1.mov"
        mov.write_bytes(archive.read("Trip1.mov"))
        cover = pillow_heif.open_heif(archive.read("Trip1.heic"))
    assert cover.size == (1152, 2048)
    data = probe(mov)
    assert [stream["codec_type"] for stream in data["streams"]] == ["video", "audio"]
    content_id = data["format"]["tags"]["com.apple.quicktime.content.identifier"]
    assert str(UUID(content_id)).upper() == content_id
    metadata = ElementTree.fromstring(cover.info["xmp"])
    assert metadata.findtext(".//{http://ns.apple.com/namespace/1.0/}ContentIdentifier") == content_id


def test_samsung_export_has_valid_samsung_footer_and_embedded_mp4(client, session, settings, tmp_path):
    info, base, _ = session
    response = client.post(base + "/export", json={
        **CLIP, "cover_time": 0.5, "format": "samsung", "output_name": "???",
    })
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["content-disposition"] == 'attachment; filename="MVIMG_0001.jpg"'
    assert not list((settings.workspace_dir / info["session_id"] / "output").iterdir())

    jpeg = response.content
    assert jpeg.startswith(b"\xff\xd8")
    assert b'GCamera:MotionPhoto="1"' in jpeg
    assert b'GCamera:MotionPhotoPresentationTimestampUs="250000"' in jpeg
    with Image.open(BytesIO(jpeg)) as cover:
        assert cover.size == (1152, 2048)
    assert jpeg.endswith(b"SEFT")
    index = len(jpeg) - 8 - struct.unpack_from("<I", jpeg, len(jpeg) - 8)[0]
    assert struct.unpack_from("<4sII", jpeg, index) == (b"SEFH", 107, 3)
    marker, offset, size = struct.unpack_from("<4sII", jpeg, index + 12 + 2 * 12)
    assert marker == b"\x00\x00\x30\x0a"
    block = index - offset
    assert block + size == index
    name_size = struct.unpack_from("<I", jpeg, block + 4)[0]
    name_start = block + 8
    video_start = name_start + name_size
    assert jpeg[name_start:video_start] == b"MotionPhoto_Data"
    video = jpeg[video_start:index]
    assert video[4:12] == b"ftypmp42"
    mp4 = tmp_path / "embedded.mp4"
    mp4.write_bytes(video)
    data = probe(mp4)
    assert data["format"]["tags"]["major_brand"] == "mp42"
    video_stream, audio_stream = data["streams"]
    assert (video_stream["width"], video_stream["height"]) == (1080, 1920)
    assert audio_stream["codec_type"] == "audio"


@pytest.mark.parametrize(("endpoint", "body"), [
    ("preview-clip", {"in_point": 0, "out_point": 3.01}),
    ("preview-clip", {"in_point": 1, "out_point": 1}),
    ("preview-clip", {"in_point": 0, "out_point": "invalid"}),
    ("export", {"in_point": 0, "out_point": 4, "cover_time": 1}),
    ("export", {"in_point": 0, "out_point": 2, "cover_time": 2.1}),
    ("export", {"in_point": 0, "out_point": 1, "cover_time": 0, "format": "invalid"}),
])
def test_media_validation_errors(client, session, endpoint, body):
    _, base, _ = session
    response = client.post(f"{base}/{endpoint}", json=body)
    assert response.status_code == 400
    assert "detail" in response.json()


def test_missing_session_and_lut(client):
    base = "/api/session/missing"
    for endpoint in ("/status", "/events", "/proxy", "/thumbnails", "/thumbnails/0001.jpg"):
        assert client.get(base + endpoint).status_code == 404
    for endpoint in ("/preview-frame", "/preview-clip", "/export"):
        assert client.post(base + endpoint, json={"in_point": 0, "out_point": 1}).status_code == 404
    assert client.post(base + "/lut/upload", files={"file": ("file.cube", b"")}).status_code == 404
    assert client.get("/api/luts/unknown/raw").status_code == 404
    assert client.delete(base).json() == {"deleted": False}


def test_bad_uploads_leave_no_workspace(client, settings):
    before = set(settings.workspace_dir.iterdir())
    assert client.post("/api/upload").status_code == 400
    for filename in ("test.txt", "broken.mp4"):
        response = client.post("/api/upload", files={"file": (filename, b"not video")})
        assert response.status_code == 400
        assert "detail" in response.json()
    assert set(settings.workspace_dir.iterdir()) == before


def test_upload_limit_removes_partial_session(tmp_path):
    settings = Settings(
        workspace_dir=tmp_path / "workspace", uploads_dir=tmp_path / "uploads",
        luts_dir=tmp_path / "luts", static_dir=tmp_path / "static",
        max_upload_size_gb=(1024 * 1024 + 16) / 1024**3,
    )
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/upload", files={"file": ("large.mp4", b"x" * (1024 * 1024 + 17))})
        assert response.status_code == 413
        assert "detail" in response.json()
    assert not list(settings.workspace_dir.iterdir())


def test_processing_is_nonblocking_and_reports_failure(client, source_video, monkeypatch):
    started = Event()
    proceed = Event()

    def fail_proxy(*args):
        started.set()
        assert proceed.wait(5)
        raise ffmpeg_service.FFmpegError("synthetic failure")

    monkeypatch.setattr(ffmpeg_service, "generate_proxy", fail_proxy)
    info = upload(client, source_video)
    base = f"/api/session/{info['session_id']}"
    try:
        assert started.wait(5)
        assert client.get("/api/health").status_code == 200
        assert client.get(base + "/proxy").status_code == 404
        assert client.get(base + "/status").json()["stage"] == "proxy"
    finally:
        proceed.set()
    state = status_events(client.get(base + "/events"))[-1]
    assert state["status"] == state["stage"] == "error"
    assert state["error"]


def test_delete_session_removes_workspace(client, source_video, settings):
    info = upload(client, source_video)
    base = f"/api/session/{info['session_id']}"
    assert status_events(client.get(base + "/events"))[-1]["status"] == "ready"
    directory = settings.workspace_dir / info["session_id"]
    assert directory.is_dir()
    assert client.delete(base).json() == {"deleted": True}
    assert not directory.exists()
    assert client.get(base + "/status").status_code == 404
    assert client.delete(base).json() == {"deleted": False}


def test_delete_session_closes_event_stream_and_releases_workspace(client):
    manager = client.app.state.sessions
    with manager.new_workspace("processing.mp4", ".mp4") as session:
        manager.register(session)
    base = f"/api/session/{session.session_id}"

    async def check_stream():
        first_event = asyncio.Event()

        async def observe_stream(scope, receive, send):
            async def observe_body(message):
                await send(message)
                if message["type"] == "http.response.body" and message.get("more_body"):
                    first_event.set()

            await client.app(scope, receive, observe_body)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=observe_stream), base_url="http://testserver",
        ) as http:
            stream = asyncio.create_task(http.get(base + "/events"))
            await asyncio.wait_for(first_event.wait(), timeout=5)
            assert (await http.delete(base)).json() == {"deleted": True}
            states = status_events(await asyncio.wait_for(stream, timeout=5))
            assert [state["status"] for state in states] == ["processing"]
            assert not session.work_dir.exists()

    asyncio.run(check_stream())


def test_short_silent_video_stays_small_and_supports_end_frame(client, tmp_path):
    source = tmp_path / "silent.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc=size=321x241:rate=10",
        "-t", "0.4", "-c:v", "libx264", "-pix_fmt", "yuv444p", str(source),
    ], check=True)
    info = upload(client, source)
    assert info["has_audio"] is False
    base = f"/api/session/{info['session_id']}"
    assert status_events(client.get(base + "/events"))[-1]["status"] == "ready"
    assert client.get(base + "/thumbnails").json()["count"] == 1
    proxy = tmp_path / "proxy.mp4"
    proxy.write_bytes(client.get(base + "/proxy").content)
    video, = probe(proxy)["streams"]
    assert (video["width"], video["height"]) == (320, 240)
    frame = client.post(base + "/preview-frame", json={"time": info["duration"]})
    assert frame.status_code == 200, frame.text
    with Image.open(BytesIO(frame.content)) as image:
        assert image.size == (320, 240)
