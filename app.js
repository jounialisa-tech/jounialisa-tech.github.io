"use strict";

const $ = (selector) => document.querySelector(selector);
const fileInput = $("#fileInput");
const dropZone = $("#dropZone");
const processBtn = $("#processBtn");
const downloadAllBtn = $("#downloadAllBtn");
const resultsGrid = $("#resultsGrid");
const emptyState = $("#emptyState");
const progress = $("#progress");
const editorDialog = $("#editorDialog");
const editorCanvas = $("#editorCanvas");

const state = {
  file: null,
  image: null,
  frames: [],
  editingIndex: -1,
  editorBase: null,
  editorSettings: null,
};

const typeLabels = {
  "color-negative": "彩色负片",
  "bw-negative": "黑白负片",
  slide: "反转片",
};

const sliderDefinitions = [
  ["exposure", "曝光", -20, 20, 0, (v) => `${(v / 10).toFixed(1)} EV`],
  ["brightness", "亮度", -100, 100, 0, signed],
  ["contrast", "对比度", 50, 150, 100, String],
  ["temperature", "色温", -100, 100, 0, signed],
  ["tint", "色调", -100, 100, 0, signed],
  ["red", "红色通道", -100, 100, 0, signed],
  ["green", "绿色通道", -100, 100, 0, signed],
  ["blue", "蓝色通道", -100, 100, 0, signed],
  ["saturation", "饱和度", 0, 200, 100, String],
];

function signed(value) { return `${Number(value) >= 0 ? "+" : ""}${value}`; }
function defaultSettings() {
  return { exposure: 0, brightness: 0, contrast: 100, temperature: 0, tint: 0, red: 0, green: 0, blue: 0, saturation: 100 };
}
function clamp(value, low = 0, high = 255) { return Math.min(high, Math.max(low, value)); }
function nextPaint() { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function cloneCanvas(source) {
  const canvas = makeCanvas(source.width, source.height);
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
  return canvas;
}

function resizeCanvas(source, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = makeCanvas(source.width * scale, source.height * scale);
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasFromImage(image) {
  const canvas = makeCanvas(image.naturalWidth || image.width, image.naturalHeight || image.height);
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function cropCanvas(source, box) {
  const canvas = makeCanvas(box.w, box.h);
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return canvas;
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function colorMetrics(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return { value: max, saturation: max === 0 ? 0 : ((max - min) / max) * 255 };
}

function connectedBrightComponents(imageData) {
  const { width, height, data } = imageData;
  const total = width * height;
  const mask = new Uint8Array(total);
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    const { value, saturation } = colorMetrics(data[p], data[p + 1], data[p + 2]);
    mask[i] = value >= 175 && saturation <= 125 ? 1 : 0;
  }
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const components = [];
  for (let seed = 0; seed < total; seed++) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0, tail = 0, area = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    queue[tail++] = seed; visited[seed] = 1;
    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / width); const x = index - y * width;
      area++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x > 0) push(index - 1);
      if (x + 1 < width) push(index + 1);
      if (y > 0) push(index - width);
      if (y + 1 < height) push(index + width);
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const ratio = w / h, fill = area / (w * h), imageArea = total;
    if (area >= imageArea * .00025 && area <= imageArea * .018 &&
        w >= width * .012 && w <= width * .13 && h >= height * .018 && h <= height * .14 &&
        ratio >= .25 && ratio <= 1.65 && fill >= .48) {
      components.push({ x: minX, y: minY, w, h, area });
    }
    function push(index) {
      if (mask[index] && !visited[index]) { visited[index] = 1; queue[tail++] = index; }
    }
  }
  return components;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clusterRows(holes, tolerance) {
  const groups = [];
  [...holes].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2)).forEach((hole) => {
    const center = hole.y + hole.h / 2;
    const group = groups.find((g) => Math.abs(center - median(g.map((x) => x.y + x.h / 2))) <= tolerance);
    if (group) group.push(hole); else groups.push([hole]);
  });
  return groups.filter((group) => group.length >= 4).map((group) => group.sort((a, b) => a.x - b.x));
}

function detectHorizontal35mm(analysis) {
  const context = analysis.getContext("2d", { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, analysis.width, analysis.height);
  const rows = clusterRows(connectedBrightComponents(imageData), Math.max(8, analysis.height * .045));
  if (rows.length < 2) return [];
  let pair = null, bestDistance = 0;
  rows.forEach((first, i) => rows.slice(i + 1).forEach((second) => {
    const distance = median(second.map((x) => x.y + x.h / 2)) - median(first.map((x) => x.y + x.h / 2));
    if (distance > bestDistance) { bestDistance = distance; pair = [first, second]; }
  }));
  if (!pair || bestDistance < analysis.height * .22) return [];
  const [top, bottom] = pair;
  const topBottom = median(top.map((x) => x.y + x.h));
  const bottomTop = median(bottom.map((x) => x.y));
  const contentHeight = bottomTop - topBottom;
  if (contentHeight < analysis.height * .18) return [];
  const insetY = Math.max(2, Math.round(contentHeight * .018));
  const y1 = Math.round(topBottom) + insetY, y2 = Math.round(bottomTop) - insetY;
  const usable = Math.min(top.length, bottom.length);
  const frameCount = Math.max(1, Math.round(usable / 8));
  const boxes = [];
  for (let index = 0; index < frameCount; index++) {
    const start = Math.round(index * usable / frameCount), end = Math.round((index + 1) * usable / frameCount);
    const topPart = top.slice(start, end), bottomPart = bottom.slice(start, end);
    if (Math.min(topPart.length, bottomPart.length) < 4) continue;
    const left = Math.max(Math.min(...topPart.map((x) => x.x)), Math.min(...bottomPart.map((x) => x.x)));
    const right = Math.min(Math.max(...topPart.map((x) => x.x + x.w)), Math.max(...bottomPart.map((x) => x.x + x.w)));
    const insetX = Math.max(1, Math.round((right - left) * .006));
    if (right > left && (right - left) * (y2 - y1) >= analysis.width * analysis.height * .04) {
      boxes.push({ x: left + insetX, y: y1, w: right - left - insetX * 2, h: y2 - y1 });
    }
  }
  return boxes;
}

function detectFrames(source) {
  const analysis = resizeCanvas(source, 1200);
  let boxes = detectHorizontal35mm(analysis);
  if (!boxes.length) {
    const rotated = makeCanvas(analysis.height, analysis.width);
    const rotatedContext = rotated.getContext("2d", { willReadFrequently: true });
    rotatedContext.translate(0, analysis.width);
    rotatedContext.rotate(-Math.PI / 2);
    rotatedContext.drawImage(analysis, 0, 0);
    const rotatedBoxes = detectHorizontal35mm(rotated);
    boxes = rotatedBoxes.map((box) => ({
      x: analysis.width - (box.y + box.h),
      y: box.x,
      w: box.h,
      h: box.w,
    }));
  }
  if (!boxes.length) return [{ x: 0, y: 0, w: source.width, h: source.height }];
  const scaleX = source.width / analysis.width, scaleY = source.height / analysis.height;
  return boxes.map((box) => {
    const x = Math.round(box.x * scaleX), y = Math.round(box.y * scaleY);
    const w = Math.round(box.w * scaleX), h = Math.round(box.h * scaleY);
    const inset = Math.max(1, Math.round(Math.min(w, h) * .012));
    return { x: x + inset, y: y + inset, w: w - inset * 2, h: h - inset * 2 };
  });
}

function histogramPercentile(histogram, percentile, total) {
  const target = total * percentile / 100;
  let sum = 0;
  for (let value = 0; value < 256; value++) {
    sum += histogram[value];
    if (sum >= target) return value;
  }
  return 255;
}

function channelBounds(data, transform, low = .5, high = 99.5) {
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const pixels = data.length / 4;
  for (let p = 0; p < data.length; p += 4) {
    histograms[0][transform(data[p])]++;
    histograms[1][transform(data[p + 1])]++;
    histograms[2][transform(data[p + 2])]++;
  }
  return histograms.map((histogram) => [histogramPercentile(histogram, low, pixels), histogramPercentile(histogram, high, pixels)]);
}

function classifyFilm(canvas) {
  const sample = resizeCanvas(canvas, 500);
  const data = sample.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sample.width, sample.height).data;
  let spread = 0, saturation = 0, red = 0, blue = 0, count = 0;
  for (let p = 0; p < data.length; p += 16) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    spread += (max - min) / 255;
    saturation += max === 0 ? 0 : (max - min) / max;
    red += r; blue += b; count++;
  }
  spread /= count; saturation /= count;
  if (spread < .065 && saturation < .12) return { type: "bw-negative", confidence: clamp(1 - spread / .065 * .45, .56, .96) };
  const orange = (red - blue) / count / 255;
  if (orange > .08) return { type: "color-negative", confidence: clamp(.60 + orange * 1.6, .58, .96) };
  return { type: "slide", confidence: .68 };
}

function processColorNegative(canvas) {
  const output = makeCanvas(canvas.width, canvas.height);
  const context = output.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  const image = context.getImageData(0, 0, output.width, output.height);
  const bounds = channelBounds(image.data, (value) => 255 - value);
  const normalized = new Float32Array((image.data.length / 4) * 3);
  const luminances = new Uint32Array(256);
  let n = 0;
  for (let p = 0; p < image.data.length; p += 4) {
    const values = [255 - image.data[p], 255 - image.data[p + 1], 255 - image.data[p + 2]];
    for (let c = 0; c < 3; c++) {
      const [low, high] = bounds[c];
      normalized[n * 3 + c] = clamp((values[c] - low) / Math.max(1, high - low), 0, 1);
    }
    const lum = normalized[n * 3] * .2126 + normalized[n * 3 + 1] * .7152 + normalized[n * 3 + 2] * .0722;
    luminances[Math.round(lum * 255)]++; n++;
  }
  const total = n;
  const lowLum = histogramPercentile(luminances, 15, total) / 255;
  const highLum = histogramPercentile(luminances, 85, total) / 255;
  const sums = [0, 0, 0]; let middleCount = 0;
  for (let i = 0; i < total; i++) {
    const lum = normalized[i * 3] * .2126 + normalized[i * 3 + 1] * .7152 + normalized[i * 3 + 2] * .0722;
    if (lum > lowLum && lum < highLum) {
      sums[0] += normalized[i * 3]; sums[1] += normalized[i * 3 + 1]; sums[2] += normalized[i * 3 + 2]; middleCount++;
    }
  }
  const means = sums.map((sum) => sum / Math.max(1, middleCount));
  const target = (means[0] + means[1] + means[2]) / 3;
  const gains = means.map((mean) => 1 + (clamp(target / Math.max(mean, .0001), .7, 1.45) - 1) * .45);
  const medianLum = histogramPercentile(luminances, 50, total) / 255;
  const brightnessGain = clamp(.48 / Math.max(medianLum, .05), .8, 1.35);
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    image.data[p] = clamp(Math.pow(clamp(normalized[i * 3] * gains[0] * brightnessGain, 0, 1), .92) * 255);
    image.data[p + 1] = clamp(Math.pow(clamp(normalized[i * 3 + 1] * gains[1] * brightnessGain, 0, 1), .92) * 255);
    image.data[p + 2] = clamp(Math.pow(clamp(normalized[i * 3 + 2] * gains[2] * brightnessGain, 0, 1), .92) * 255);
  }
  context.putImageData(image, 0, 0);
  return output;
}

function processBWNegative(canvas) {
  const output = cloneCanvas(canvas);
  const context = output.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, output.width, output.height);
  const histogram = new Uint32Array(256); const total = image.data.length / 4;
  for (let p = 0; p < image.data.length; p += 4) {
    const gray = 255 - Math.round(image.data[p] * .2126 + image.data[p + 1] * .7152 + image.data[p + 2] * .0722);
    histogram[gray]++;
  }
  const low = histogramPercentile(histogram, .7, total), high = histogramPercentile(histogram, 99.3, total);
  for (let p = 0; p < image.data.length; p += 4) {
    const gray = 255 - (image.data[p] * .2126 + image.data[p + 1] * .7152 + image.data[p + 2] * .0722);
    const value = clamp((gray - low) * 255 / Math.max(1, high - low));
    image.data[p] = image.data[p + 1] = image.data[p + 2] = value;
  }
  context.putImageData(image, 0, 0); return output;
}

function processSlide(canvas) {
  const output = cloneCanvas(canvas);
  const context = output.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, output.width, output.height);
  const bounds = channelBounds(image.data, (value) => value, .4, 99.6);
  for (let p = 0; p < image.data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      const [low, high] = bounds[c];
      image.data[p + c] = clamp((image.data[p + c] - low) * 255 / Math.max(1, high - low));
    }
  }
  context.putImageData(image, 0, 0); return output;
}

function processFrame(canvas, type) {
  if (type === "color-negative") return processColorNegative(canvas);
  if (type === "bw-negative") return processBWNegative(canvas);
  return processSlide(canvas);
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g] = [c, x]; else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x]; else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c]; else [r, b] = [c, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function applyAdjustments(source, settings, target = null) {
  const output = target || makeCanvas(source.width, source.height);
  output.width = source.width; output.height = source.height;
  const context = output.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, output.width, output.height);
  const temperature = settings.temperature / 100, tint = settings.tint / 100;
  const exposure = Math.pow(2, settings.exposure / 10), brightness = settings.brightness / 100 * .22;
  const contrast = settings.contrast / 100, saturation = settings.saturation / 100;
  const rgbGain = [1 + settings.red / 100 * .6, 1 + settings.green / 100 * .6, 1 + settings.blue / 100 * .6];
  for (let p = 0; p < image.data.length; p += 4) {
    let r = image.data[p] / 255, g = image.data[p + 1] / 255, b = image.data[p + 2] / 255;
    r *= (1 + .18 * temperature + .06 * tint) * rgbGain[0];
    g *= (1 - .12 * tint) * rgbGain[1];
    b *= (1 - .18 * temperature + .06 * tint) * rgbGain[2];
    r = clamp((r * exposure + brightness - .5) * contrast + .5, 0, 1);
    g = clamp((g * exposure + brightness - .5) * contrast + .5, 0, 1);
    b = clamp((b * exposure + brightness - .5) * contrast + .5, 0, 1);
    let [h, s, v] = rgbToHsv(r * 255, g * 255, b * 255); s = clamp(s * saturation, 0, 1);
    [r, g, b] = hsvToRgb(h, s, v);
    image.data[p] = r; image.data[p + 1] = g; image.data[p + 2] = b;
  }
  context.putImageData(image, 0, 0); return output;
}

function setFile(file) {
  if (!file || !file.type.startsWith("image/")) { showToast("请选择有效的图片文件"); return; }
  if (file.size > 30 * 1024 * 1024) { showToast("图片不能超过 30MB"); return; }
  state.file = file; state.image = null; state.frames = [];
  $("#fileName").textContent = file.name;
  $("#pageTitle").textContent = "照片已就绪";
  $("#pageHint").textContent = "选择胶片类型后，点击左侧“开始处理”。";
  processBtn.disabled = false; downloadAllBtn.disabled = true;
  resultsGrid.replaceChildren(); emptyState.hidden = false; $("#countBadge").textContent = "0 张";
}

async function processUpload() {
  if (!state.file) return;
  processBtn.disabled = true; downloadAllBtn.disabled = true; progress.hidden = false;
  $("#pageTitle").textContent = "正在分析胶片…";
  $("#pageHint").textContent = "正在定位画格、识别类型并转换颜色。";
  await nextPaint();
  try {
    state.image = await loadImage(state.file);
    const source = canvasFromImage(state.image);
    const boxes = detectFrames(source);
    const selected = $("#filmType").value;
    state.frames = [];
    for (let index = 0; index < boxes.length; index++) {
      await nextPaint();
      const cropped = cropCanvas(source, boxes[index]);
      const detected = classifyFilm(cropped);
      const type = selected === "auto" ? detected.type : selected;
      const confidence = selected === "auto" ? detected.confidence : 1;
      const automatic = processFrame(cropped, type);
      state.frames.push({ source: cropped, automatic, current: cloneCanvas(automatic), type, confidence, settings: defaultSettings() });
    }
    renderResults();
    $("#pageTitle").textContent = "转换完成";
    const types = [...new Set(state.frames.map((frame) => typeLabels[frame.type]))].join("、");
    $("#pageHint").textContent = `识别到 ${state.frames.length} 个画格 · ${types}`;
    downloadAllBtn.disabled = !state.frames.length;
    showToast("处理完成，可以调色或下载");
  } catch (error) {
    console.error(error); showToast("处理失败，请尝试换一张照片");
    $("#pageTitle").textContent = "处理失败";
    $("#pageHint").textContent = "图片可能过大或格式不受浏览器支持。";
  } finally {
    processBtn.disabled = false; progress.hidden = true;
  }
}

function renderResults() {
  resultsGrid.replaceChildren(); emptyState.hidden = Boolean(state.frames.length);
  $("#countBadge").textContent = `${state.frames.length} 张`;
  state.frames.forEach((frame, index) => {
    const card = document.createElement("article"); card.className = "card"; card.style.animationDelay = `${index * 45}ms`;
    const previewWrap = document.createElement("div"); previewWrap.className = "card-preview";
    previewWrap.append(resizeCanvas(frame.current, 900));
    const footer = document.createElement("footer"); footer.className = "card-footer";
    const title = document.createElement("div"); title.className = "card-title";
    title.innerHTML = `<h3>画格 ${String(index + 1).padStart(2, "0")}</h3><p>${typeLabels[frame.type]} · ${Math.round(frame.confidence * 100)}%</p>`;
    const actions = document.createElement("div"); actions.className = "card-actions";
    const edit = document.createElement("button"); edit.textContent = "调色"; edit.addEventListener("click", () => openEditor(index));
    const save = document.createElement("button"); save.textContent = "下载"; save.addEventListener("click", () => downloadFrame(index));
    actions.append(edit, save); footer.append(title, actions); card.append(previewWrap, footer); resultsGrid.append(card);
  });
}

function buildSliders() {
  const list = $("#sliderList"); list.replaceChildren();
  sliderDefinitions.forEach(([key, label, min, max, fallback, formatter]) => {
    if (key === "red") {
      const section = document.createElement("p"); section.className = "section-label"; section.textContent = "RGB 三原色"; list.append(section);
    }
    const row = document.createElement("label"); row.className = "slider-row";
    const head = document.createElement("span"); head.className = "slider-head";
    const value = state.editorSettings[key] ?? fallback;
    head.innerHTML = `<span>${label}</span><span class="slider-value" id="value-${key}">${formatter(value)}</span>`;
    const input = document.createElement("input"); input.type = "range"; input.min = min; input.max = max; input.value = value; input.dataset.key = key;
    if (["red", "green", "blue"].includes(key)) input.className = key;
    input.addEventListener("input", () => {
      state.editorSettings[key] = Number(input.value); $(`#value-${key}`).textContent = formatter(input.value); renderEditorPreview();
    });
    row.append(head, input); list.append(row);
  });
}

function openEditor(index) {
  state.editingIndex = index;
  state.editorSettings = { ...state.frames[index].settings };
  state.editorBase = resizeCanvas(state.frames[index].automatic, 1400);
  buildSliders(); renderEditorPreview(); editorDialog.showModal();
}

function renderEditorPreview() { applyAdjustments(state.editorBase, state.editorSettings, editorCanvas); }

function resetEditor() {
  state.editorSettings = defaultSettings(); buildSliders(); renderEditorPreview();
}

async function finishEditor() {
  const index = state.editingIndex; if (index < 0) return;
  const done = $("#doneBtn"); done.disabled = true; done.textContent = "处理中…"; await nextPaint();
  state.frames[index].settings = { ...state.editorSettings };
  state.frames[index].current = applyAdjustments(state.frames[index].automatic, state.editorSettings);
  done.disabled = false; done.textContent = "完成"; editorDialog.close(); renderResults(); showToast(`画格 ${index + 1} 已完成调色`);
}

function canvasBlob(canvas, type = "image/jpeg", quality = .95) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片编码失败")), type, quality));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadFrame(index) {
  const blob = await canvasBlob(state.frames[index].current);
  triggerDownload(blob, `film_frame_${String(index + 1).padStart(2, "0")}.jpg`);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) { return new Uint8Array([value & 255, value >>> 8 & 255]); }
function u32(value) { return new Uint8Array([value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255]); }
function joinBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0), output = new Uint8Array(size); let offset = 0;
  parts.forEach((part) => { output.set(part, offset); offset += part.length; }); return output;
}

function makeZip(files) {
  const encoder = new TextEncoder(), locals = [], centrals = []; let offset = 0;
  files.forEach(({ name, bytes }) => {
    const filename = encoder.encode(name), crc = crc32(bytes);
    const local = joinBytes([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(bytes.length), u32(bytes.length), u16(filename.length), u16(0), filename, bytes]);
    const central = joinBytes([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(bytes.length), u32(bytes.length), u16(filename.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), filename]);
    locals.push(local); centrals.push(central); offset += local.length;
  });
  const centralBlock = joinBytes(centrals);
  const end = joinBytes([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralBlock.length), u32(offset), u16(0)]);
  return new Blob([...locals, centralBlock, end], { type: "application/zip" });
}

async function downloadAll() {
  if (!state.frames.length) return;
  downloadAllBtn.disabled = true; downloadAllBtn.textContent = "正在打包…";
  try {
    const files = [];
    for (let index = 0; index < state.frames.length; index++) {
      const blob = await canvasBlob(state.frames[index].current);
      files.push({ name: `film_frame_${String(index + 1).padStart(2, "0")}.jpg`, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    triggerDownload(makeZip(files), "film_digitizer_results.zip"); showToast("全部结果已打包下载");
  } finally { downloadAllBtn.disabled = false; downloadAllBtn.textContent = "下载全部结果"; }
}

let toastTimer;
function showToast(message) {
  const toast = $("#toast"); toast.textContent = message; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); setFile(event.dataTransfer.files[0]); });
processBtn.addEventListener("click", processUpload);
downloadAllBtn.addEventListener("click", downloadAll);
$("#resetBtn").addEventListener("click", resetEditor);
$("#cancelBtn").addEventListener("click", () => editorDialog.close());
$("#doneBtn").addEventListener("click", finishEditor);
editorDialog.addEventListener("cancel", (event) => { event.preventDefault(); editorDialog.close(); });

function registerWebMCP() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const keys = Object.keys(defaultSettings());
  Promise.resolve(context.registerTool({
    name: "adjust_film_frame",
    title: "调整胶片画格色彩",
    description: "调整已处理画格的曝光、亮度、对比度、色温、色调、饱和度或 RGB 通道，并更新页面预览。",
    inputSchema: {
      type: "object",
      properties: {
        frameIndex: { type: "integer", minimum: 0 },
        settings: { type: "object", properties: Object.fromEntries(keys.map((key) => [key, { type: "number" }])), additionalProperties: false }
      },
      required: ["frameIndex", "settings"], additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!Number.isInteger(input?.frameIndex) || !state.frames[input.frameIndex]) throw new Error("画格不存在");
      const frame = state.frames[input.frameIndex];
      for (const [key, value] of Object.entries(input.settings || {})) if (keys.includes(key) && Number.isFinite(value)) frame.settings[key] = value;
      frame.current = applyAdjustments(frame.automatic, frame.settings); renderResults();
      return { frameIndex: input.frameIndex, settings: frame.settings, status: "updated" };
    }
  })).catch(() => {});
}
registerWebMCP();
