/* Live Photo Tool —— 前端单页逻辑（Vanilla JS）。
 *
 * 状态机：
 *   [初始] -> 上传 -> [代理生成中(轮询)] -> [就绪] -> 预览/裁剪 -> 导出
 */

const API = "/api";
const MAX_CLIP = 3.0; // Live Photo 片段最大时长（秒）

// 色调调整项定义（范围统一 -100..100，0 中性）
const ADJUSTMENTS = [
  { key: "exposure", label: "曝光", group: "基础" },
  { key: "contrast", label: "对比度", group: "基础" },
  { key: "highlights", label: "高光", group: "分区" },
  { key: "shadows", label: "阴影", group: "分区" },
  { key: "whites", label: "白色色阶", group: "分区" },
  { key: "blacks", label: "黑色色阶", group: "分区" },
];
// 分组渲染顺序
const ADJUST_GROUP_ORDER = ["基础", "分区"];

const state = {
  sessionId: null,
  meta: null,        // {duration, width, height, fps}
  thumbnails: [],    // [{index, time, url}]
  inPoint: 0,
  outPoint: 0,
  coverTime: 0,
  drag: null,        // 'in' | 'out' | 'cover' | null
  intensity: 100,    // LUT 强度 0..100
  adjustments: Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, 0])),
  hasPreview: false, // 是否已生成过预览（决定滑块是否触发自动重渲染）
};

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("file-input");
const uploadProgress = $("upload-progress");
const progressFill = $("progress-fill");
const editorView = $("editor-view");
const uploadView = $("upload-view");
const video = $("video");
const lutSelect = $("lut-select");
const lutInput = $("lut-input");
const intensitySlider = $("intensity");
const intensityValue = $("intensity-value");
const adjustContainer = $("adjust-sliders");
const resetAdjustBtn = $("reset-adjust");
const previewBtn = $("preview-btn");
const previewImg = $("preview-img");
const exportBtn = $("export-btn");
const timeline = $("timeline");
const clipDuration = $("clip-duration");
const statusbar = document.querySelector(".statusbar");
const videoTime = $("video-time");
const setCoverBtn = $("set-cover-btn");
const resetVideoBtn = $("reset-video-btn");
const previewClipBtn = $("preview-clip-btn");
const clipModal = $("clip-modal");
const clipModalClose = $("clip-modal-close");
const clipModalVideo = $("clip-modal-video");
const clipModalLoading = $("clip-modal-loading");

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res;
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

const ACCEPTED_EXT = [".mov", ".mp4"];

// 重新选择视频：清理当前会话与前端状态，切回上传态，直接弹出文件选择
async function resetVideo() {
  // 释放后端临时文件（失败不阻塞流程）
  const oldId = state.sessionId;
  if (oldId) {
    try { await api(`/session/${oldId}`, { method: "DELETE" }); } catch (_) {}
  }

  // 清理预览/视频引用，避免占用内存
  if (previewImg.src && previewImg.src.startsWith("blob:")) URL.revokeObjectURL(previewImg.src);
  previewImg.src = "";
  previewImg.classList.add("hidden");
  video.removeAttribute("src");
  video.load();

  // 重置状态
  state.sessionId = null;
  state.meta = null;
  state.thumbnails = [];
  state.thumbImgs = null;
  state.inPoint = 0;
  state.outPoint = 0;
  state.coverTime = 0;
  state.intensity = 100;
  state.hasPreview = false;
  ADJUSTMENTS.forEach((a) => (state.adjustments[a.key] = 0));
  if (previewTimer) clearTimeout(previewTimer);

  // 重置 UI
  intensitySlider.value = 100;
  intensityValue.textContent = "100%";
  $("filename").textContent = "未选择文件";
  resetVideoBtn.classList.add("hidden");
  uploadProgress.classList.add("hidden");
  progressFill.style.width = "0%";
  editorView.classList.add("hidden");
  uploadView.classList.remove("hidden");

  // 直接弹出文件选择，省一步
  fileInput.value = "";
  fileInput.click();
}

resetVideoBtn.addEventListener("click", resetVideo);

async function uploadFile(file) {
  if (!ACCEPTED_EXT.some((ext) => file.name.toLowerCase().endsWith(ext))) {
    toast("仅支持 .mov / .mp4 文件");
    return;
  }
  $("filename").textContent = file.name;
  uploadProgress.classList.remove("hidden");

  const form = new FormData();
  form.append("file", file);
  try {
    const res = await api("/upload", { method: "POST", body: form });
    const data = await res.json();
    state.sessionId = data.session_id;
    state.meta = data;
    pollStatus();
  } catch (err) {
    toast("上传失败：" + err.message);
    uploadProgress.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// 轮询代理生成状态
// ---------------------------------------------------------------------------
async function pollStatus() {
  try {
    const res = await api(`/session/${state.sessionId}/status`);
    const s = await res.json();
    progressFill.style.width = (s.proxy_progress || 0) + "%";

    if (s.status === "ready") {
      onReady();
    } else if (s.status === "error") {
      toast("处理失败：" + (s.error || "未知错误"));
    } else {
      setTimeout(pollStatus, 2000);
    }
  } catch (err) {
    toast("状态查询失败：" + err.message);
  }
}

// ---------------------------------------------------------------------------
// 就绪：加载代理视频 + 缩略图 + LUT 列表
// ---------------------------------------------------------------------------
async function onReady() {
  uploadView.classList.add("hidden");
  editorView.classList.remove("hidden");
  resetVideoBtn.classList.remove("hidden");

  video.src = `${API}/session/${state.sessionId}/proxy`;

  // 默认选区：从 0 到 min(3, duration)
  state.inPoint = 0;
  state.outPoint = Math.min(MAX_CLIP, state.meta.duration);
  state.coverTime = state.inPoint;

  buildAdjustSliders();
  await Promise.all([loadThumbnails(), loadLuts()]);
  drawTimeline();
  updateDurationLabel();
}

async function loadThumbnails() {
  const res = await api(`/session/${state.sessionId}/thumbnails`);
  const data = await res.json();
  state.thumbnails = data.items;
  // 预加载图片
  state.thumbImgs = data.items.map((it) => {
    const img = new Image();
    img.src = it.url;
    return img;
  });
}

async function loadLuts() {
  const res = await api(`/luts?session_id=${state.sessionId}`);
  const data = await res.json();
  lutSelect.innerHTML = "";
  data.luts.forEach((lut) => {
    const opt = document.createElement("option");
    opt.value = lut.id;
    opt.textContent = lut.name + (lut.source === "custom" ? " (自定义)" : "");
    lutSelect.appendChild(opt);
  });
}

// ---------------------------------------------------------------------------
// 自定义 LUT 上传
// ---------------------------------------------------------------------------
lutInput.addEventListener("change", async () => {
  const f = lutInput.files[0];
  if (!f) return;
  const form = new FormData();
  form.append("file", f);
  try {
    await api(`/session/${state.sessionId}/lut/upload`, { method: "POST", body: form });
    await loadLuts();
    toast("LUT 上传成功");
  } catch (err) {
    toast("LUT 上传失败：" + err.message);
  }
});

// ---------------------------------------------------------------------------
// LUT 强度 + 色调调整滑块
// ---------------------------------------------------------------------------
// LUT 强度
intensitySlider.addEventListener("input", () => {
  state.intensity = Number(intensitySlider.value);
  intensityValue.textContent = state.intensity + "%";
});
intensitySlider.addEventListener("change", autoPreview);

// 双向滑块：从中点向两侧填充（正值偏右蓝色，负值偏左蓝色）
function updateBidirFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const val = Number(input.value);
  const mid = (min + max) / 2;
  const span = (max - min) / 2;
  const lo = Math.min(mid, val);
  const hi = Math.max(mid, val);
  const lp = ((lo - min) / (max - min)) * 100;
  const hp = ((hi - min) / (max - min)) * 100;
  input.style.background =
    `linear-gradient(to right, var(--border) ${lp}%, var(--accent) ${lp}%, var(--accent) ${hp}%, var(--border) ${hp}%)`;
}

// 动态生成色调调整滑块（按「基础 / 分区」两列分组）
function buildAdjustSliders() {
  adjustContainer.innerHTML = "";
  for (const groupName of ADJUST_GROUP_ORDER) {
    const items = ADJUSTMENTS.filter((a) => a.group === groupName);
    if (!items.length) continue;

    const group = document.createElement("div");
    group.className = "adjust-group";
    group.dataset.group = groupName;
    if (groupName !== ADJUST_GROUP_ORDER[0]) {
      group.style.marginTop = "14px";
    }

    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = groupName;
    group.appendChild(title);

    items.forEach((adj) => {
      const row = document.createElement("div");
      row.className = "adjust-row";
      row.dataset.key = adj.key;
      row.innerHTML = `
        <label class="slider-label">${adj.label} <b>0</b></label>
        <input type="range" class="bidir" min="-100" max="100" value="0" step="1">`;
      const input = row.querySelector("input");
      const valueEl = row.querySelector("b");
      updateBidirFill(input);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        state.adjustments[adj.key] = v;
        valueEl.textContent = v > 0 ? "+" + v : String(v);
        row.classList.toggle("changed", v !== 0);
        updateBidirFill(input);
      });
      input.addEventListener("change", autoPreview);
      group.appendChild(row);
    });

    adjustContainer.appendChild(group);
  }
}

resetAdjustBtn.addEventListener("click", () => {
  ADJUSTMENTS.forEach((adj) => (state.adjustments[adj.key] = 0));
  adjustContainer.querySelectorAll(".adjust-row").forEach((row) => {
    const input = row.querySelector("input");
    input.value = 0;
    row.querySelector("b").textContent = "0";
    row.classList.remove("changed");
    updateBidirFill(input);
  });
  autoPreview();
});

// 当前色彩参数 payload
function colorPayload() {
  return {
    lut_id: lutSelect.value,
    lut_intensity: state.intensity / 100,
    adjustments: state.adjustments,
  };
}

// ---------------------------------------------------------------------------
// 从播放器当前帧选取封面
// ---------------------------------------------------------------------------
function formatTime(t) {
  return t.toFixed(1) + "s";
}

// 视频播放/拖动时，实时显示当前帧时间
video.addEventListener("timeupdate", () => {
  videoTime.textContent = "当前帧：" + formatTime(video.currentTime);
});
video.addEventListener("seeked", () => {
  videoTime.textContent = "当前帧：" + formatTime(video.currentTime);
});

// 把当前播放帧设为封面（自动夹紧到选区内）
setCoverBtn.addEventListener("click", () => {
  if (!state.meta) return;
  let t = video.currentTime;
  if (t < state.inPoint) {
    t = state.inPoint;
    toast("当前帧在选区前，已夹紧到入点");
  } else if (t > state.outPoint) {
    t = state.outPoint;
    toast("当前帧在选区后，已夹紧到出点");
  }
  state.coverTime = t;
  drawTimeline();
  // 同步刷新封面预览（带上当前色彩参数）
  renderPreview();
});

// ---------------------------------------------------------------------------
// 预览帧
// ---------------------------------------------------------------------------
let previewTimer = null;

async function renderPreview() {
  previewBtn.disabled = true;
  previewBtn.textContent = "渲染中…";
  try {
    const res = await api(`/session/${state.sessionId}/preview-frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time: state.coverTime, ...colorPayload() }),
    });
    const blob = await res.blob();
    previewImg.src = URL.createObjectURL(blob);
    previewImg.classList.remove("hidden");
    state.hasPreview = true;
  } catch (err) {
    toast("预览失败：" + err.message);
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = "预览当前帧";
  }
}

// 滑块调整后自动重渲染（防抖；仅在已生成过预览时触发）
function autoPreview() {
  if (!state.hasPreview) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 250);
}

previewBtn.addEventListener("click", renderPreview);

// ---------------------------------------------------------------------------
// 时间轴绘制与交互
// ---------------------------------------------------------------------------
function timeToX(t) {
  // 用 CSS 像素宽度（timeline.clientWidth），与鼠标事件坐标一致
  return (t / state.meta.duration) * timeline.clientWidth;
}
function xToTime(x) {
  return (x / timeline.clientWidth) * state.meta.duration;
}

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = timeline.clientWidth;
  timeline.width = cssW * dpr;
  timeline.height = 90 * dpr;
  const ctx = timeline.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = 90;

  ctx.clearRect(0, 0, W, H);

  // 缩略图平铺
  if (state.thumbImgs && state.meta.duration > 0) {
    const tw = W / state.meta.duration; // 每秒宽度
    state.thumbnails.forEach((it, i) => {
      const img = state.thumbImgs[i];
      if (img && img.complete) ctx.drawImage(img, timeToX(it.time), 0, tw, H);
    });
  }

  // 选区遮罩
  const xin = timeToX(state.inPoint);
  const xout = timeToX(state.outPoint);
  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.fillRect(0, 0, xin, H);
  ctx.fillRect(xout, 0, W - xout, H);

  // 选区边框（超时变红）
  const over = state.outPoint - state.inPoint > MAX_CLIP + 1e-6;
  ctx.strokeStyle = over ? "#ff453a" : "#0a84ff";
  ctx.lineWidth = 3;
  ctx.strokeRect(xin, 1.5, xout - xin, H - 3);

  // 手柄
  drawHandle(ctx, xin, H, "#0a84ff");
  drawHandle(ctx, xout, H, "#0a84ff");

  // 封面帧指示线
  const xc = timeToX(state.coverTime);
  ctx.strokeStyle = "#ffd60a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xc, 0);
  ctx.lineTo(xc, H);
  ctx.stroke();
}

function drawHandle(ctx, x, H, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x - 2, 0, 4, H);
  ctx.beginPath();
  ctx.moveTo(x - 6, 0);
  ctx.lineTo(x + 6, 0);
  ctx.lineTo(x, 10);
  ctx.closePath();
  ctx.fill();
}

timeline.addEventListener("mousedown", (e) => {
  const x = e.offsetX;
  const handles = [
    ["in", timeToX(state.inPoint)],
    ["out", timeToX(state.outPoint)],
    ["cover", timeToX(state.coverTime)],
  ];
  // 选最近的手柄（阈值 14px）
  let best = null, bestDist = 14;
  for (const [name, hx] of handles) {
    const d = Math.abs(hx - x);
    if (d < bestDist) { best = name; bestDist = d; }
  }
  // 未命中手柄：点击在选区内 → 拖封面；在选区外 → 拖最近的边界
  if (!best) {
    if (x > timeToX(state.inPoint) && x < timeToX(state.outPoint)) {
      best = "cover";
    } else {
      const toIn = Math.abs(timeToX(state.inPoint) - x);
      const toOut = Math.abs(timeToX(state.outPoint) - x);
      best = toIn < toOut ? "in" : "out";
    }
  }
  state.drag = best;
  e.preventDefault(); // 防止选中文本/拖出 canvas
});

window.addEventListener("mousemove", (e) => {
  if (!state.drag) return;
  const rect = timeline.getBoundingClientRect();
  // clientX - rect.left 已经是 CSS 像素，与 xToTime 用的 clientWidth 一致
  let t = xToTime(e.clientX - rect.left);
  t = Math.max(0, Math.min(state.meta.duration, t));

  if (state.drag === "in") {
    state.inPoint = Math.min(t, state.outPoint - 0.1);
    state.coverTime = Math.max(state.coverTime, state.inPoint);
  } else if (state.drag === "out") {
    state.outPoint = Math.max(t, state.inPoint + 0.1);
    state.coverTime = Math.min(state.coverTime, state.outPoint);
  } else if (state.drag === "cover") {
    state.coverTime = Math.max(state.inPoint, Math.min(t, state.outPoint));
  }
  drawTimeline();
  updateDurationLabel();
});

window.addEventListener("mouseup", () => { state.drag = null; });

function updateDurationLabel() {
  const d = state.outPoint - state.inPoint;
  clipDuration.textContent = `已选时长：${d.toFixed(1)}s`;
  statusbar.classList.toggle("over-limit", d > MAX_CLIP + 1e-6);
}

// ---------------------------------------------------------------------------
// 选区片段弹框预览
// ---------------------------------------------------------------------------
let clipPreviewUrl = null; // 当前预览的 ObjectURL，关闭时释放

async function previewClip() {
  if (!state.sessionId) return;
  const d = state.outPoint - state.inPoint;
  if (d <= 0) { toast("请先在时间轴上选择片段"); return; }
  if (d > MAX_CLIP + 1e-6) { toast(`片段时长不能超过 ${MAX_CLIP} 秒`); return; }

  openClipModal(true); // 先开弹框显示 loading

  try {
    const res = await api(`/session/${state.sessionId}/preview-clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        in_point: state.inPoint,
        out_point: state.outPoint,
        ...colorPayload(),
      }),
    });
    const blob = await res.blob();
    if (clipPreviewUrl) URL.revokeObjectURL(clipPreviewUrl);
    clipPreviewUrl = URL.createObjectURL(blob);
    clipModalVideo.src = clipPreviewUrl;
    clipModalLoading.classList.add("hidden");
    clipModalVideo.play().catch(() => {}); // autoplay 可能被拒，忽略
  } catch (err) {
    closeClipModal();
    toast("片段预览失败：" + err.message);
  }
}

function openClipModal(loading) {
  clipModal.classList.remove("hidden");
  clipModalLoading.classList.toggle("hidden", !loading);
  if (loading) {
    clipModalVideo.removeAttribute("src");
    clipModalVideo.load();
  }
}

function closeClipModal() {
  clipModal.classList.add("hidden");
  clipModalVideo.pause();
  clipModalVideo.removeAttribute("src");
  clipModalVideo.load();
  if (clipPreviewUrl) { URL.revokeObjectURL(clipPreviewUrl); clipPreviewUrl = null; }
}

previewClipBtn.addEventListener("click", previewClip);
clipModalClose.addEventListener("click", closeClipModal);
clipModal.querySelector(".modal-backdrop").addEventListener("click", closeClipModal);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !clipModal.classList.contains("hidden")) closeClipModal();
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
exportBtn.addEventListener("click", async () => {
  const d = state.outPoint - state.inPoint;
  if (d > MAX_CLIP + 1e-6) {
    toast(`片段时长不能超过 ${MAX_CLIP} 秒`);
    return;
  }
  const fmt = $("export-format").value; // "apple" | "samsung"
  const name = $("output-name").value || "IMG_0001";
  exportBtn.disabled = true;
  exportBtn.textContent = "导出中…";
  try {
    const res = await api(`/session/${state.sessionId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        in_point: state.inPoint,
        out_point: state.outPoint,
        cover_time: state.coverTime,
        output_name: name,
        format: fmt,
        ...colorPayload(),
      }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Apple → ZIP（HEIC+MOV）；三星 → 单个 JPG（Motion Photo，文件名需 MV 前缀）
    if (fmt === "samsung") {
      const mv = name.startsWith("MV") ? name : "MV" + name;
      a.download = mv + ".jpg";
    } else {
      a.download = name + ".zip";
    }
    a.click();
    URL.revokeObjectURL(url);
    toast(fmt === "samsung" ? "三星 Motion Photo 导出完成" : "Live Photo 导出完成");
  } catch (err) {
    toast("导出失败：" + err.message);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = "导出 Live Photo";
  }
});

// 窗口缩放时重绘时间轴
window.addEventListener("resize", () => {
  if (!editorView.classList.contains("hidden")) drawTimeline();
});
