// 分鏡九宮格裁切工具 - 前端偵測 / 裁切 / OCR 邏輯
// 演算法對應 storyboard_cutter.py 的偵測邏輯（白色留白帶分析）。

const state = {
  files: [],       // [{ id, file, name, img, width, height }]
  cells: null,     // Map<fileId, Cell[]>  (after preview)
};

let idCounter = 0;

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileListEl = document.getElementById("file-list");
const btnPreview = document.getElementById("btn-preview");
const btnExport = document.getElementById("btn-export");
const previewSummary = document.getElementById("preview-summary");
const previewResults = document.getElementById("preview-results");
const exportProgress = document.getElementById("export-progress");
const exportProgressFill = document.getElementById("export-progress-fill");
const exportProgressText = document.getElementById("export-progress-text");

["dragenter", "dragover"].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", e => {
  const dropped = Array.from(e.dataTransfer.files).filter(f => f.type === "image/png");
  addFiles(dropped);
});
fileInput.addEventListener("change", e => {
  addFiles(Array.from(e.target.files));
  fileInput.value = "";
});

function addFiles(fileArr) {
  for (const file of fileArr) {
    const entry = { id: idCounter++, file, name: file.name, img: null };
    state.files.push(entry);
  }
  renderFileList();
  updateButtons();
}

function renderFileList() {
  fileListEl.innerHTML = "";
  state.files.forEach((entry, idx) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.id = entry.id;

    const orderBadge = document.createElement("span");
    orderBadge.className = "order-badge";
    orderBadge.textContent = String(idx + 1);

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    nameSpan.textContent = entry.name;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.title = "移除";
    removeBtn.textContent = "✕";

    li.appendChild(orderBadge);
    li.appendChild(nameSpan);
    li.appendChild(removeBtn);

    removeBtn.addEventListener("click", () => {
      state.files = state.files.filter(f => f.id !== entry.id);
      renderFileList();
      updateButtons();
    });
    li.addEventListener("dragstart", () => li.classList.add("dragging"));
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      reorderFromDOM();
    });
    fileListEl.appendChild(li);
  });
}

fileListEl.addEventListener("dragover", e => {
  e.preventDefault();
  const dragging = fileListEl.querySelector(".dragging");
  if (!dragging) return;
  const after = [...fileListEl.querySelectorAll("li:not(.dragging)")].find(li => {
    const rect = li.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2;
  });
  if (after) fileListEl.insertBefore(dragging, after);
  else fileListEl.appendChild(dragging);
});

function reorderFromDOM() {
  const ids = [...fileListEl.querySelectorAll("li")].map(li => Number(li.dataset.id));
  state.files.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  renderFileList();
}

function updateButtons() {
  btnPreview.disabled = state.files.length === 0;
  btnExport.disabled = true; // re-enabled only after a successful preview
}

// ---------------------------------------------------------------------------
// Detection thresholds
// ---------------------------------------------------------------------------

function readThresholds() {
  return {
    whiteLevel: Number(document.getElementById("p-white-level").value),
    colBlankFrac: Number(document.getElementById("p-col-blank-frac").value),
    minColSeparator: Number(document.getElementById("p-min-col-separator").value),
    textWhiteFrac: Number(document.getElementById("p-text-white-frac").value),
    textRun: Number(document.getElementById("p-text-run").value),
    imageRun: Number(document.getElementById("p-image-run").value),
  };
}

// ---------------------------------------------------------------------------
// Core grid detection (ported from storyboard_cutter.py)
// ---------------------------------------------------------------------------

function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return gray;
}

function findBands(isBlankArr, minSeparator) {
  const n = isBlankArr.length;
  const separators = [];
  let i = 0;
  while (i < n) {
    if (isBlankArr[i]) {
      let j = i;
      while (j < n && isBlankArr[j]) j++;
      if (j - i >= minSeparator) separators.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  const bands = [];
  let cursor = 0;
  for (const [s, e] of separators) {
    if (s > cursor) bands.push([cursor, s]);
    cursor = e;
  }
  if (cursor < n) bands.push([cursor, n]);
  return bands.filter(([s, e]) => e - s > 2);
}

function detectColumns(gray, width, height, whiteLevel, colBlankFrac, minColSeparator) {
  const isBlankCol = new Array(width);
  for (let x = 0; x < width; x++) {
    let whiteCount = 0;
    for (let y = 0; y < height; y++) {
      if (gray[y * width + x] >= whiteLevel) whiteCount++;
    }
    isBlankCol[x] = whiteCount / height >= colBlankFrac;
  }
  return findBands(isBlankCol, minColSeparator);
}

// Row boundaries are NOT assumed to have any white gap between them (many
// real storyboard grids butt the next screenshot directly against the
// previous row's caption, with only *columns* separated by whitespace).
// Instead, scan top-to-bottom within [x0, x1) for sustained transitions
// between "screenshot" (low white fraction) and "white caption background"
// (high white fraction, sustained for `textRun` rows), then back to the next
// row's screenshot (sustained for `imageRun` rows). This also transparently
// handles grids that *do* have a blank gutter between rows: the gutter just
// becomes part of the caption band, which is harmless for cropping/OCR.
function computeRowSegments(gray, width, height, whiteLevel, textWhiteFrac, textRun, imageRun, x0, x1) {
  const rowWhiteFrac = new Float32Array(height);
  const colCount = x1 - x0;
  for (let y = 0; y < height; y++) {
    let whiteCount = 0;
    const rowOffset = y * width;
    for (let x = x0; x < x1; x++) {
      if (gray[rowOffset + x] >= whiteLevel) whiteCount++;
    }
    rowWhiteFrac[y] = whiteCount / colCount;
  }

  const segments = [];
  let pos = 0;
  while (pos < height) {
    // A row must start with actual screenshot content. Skip any leading
    // blank/white margin first (e.g. the outer padding above the very first
    // row) so it isn't mistaken for a zero-height row whose "caption" is
    // really just that margin.
    let imgStart = null;
    for (let y = pos; y < height; y++) {
      if (rowWhiteFrac[y] < textWhiteFrac) { imgStart = y; break; }
    }
    if (imgStart === null) break; // nothing but blank/white remains

    let splitY = null;
    let run = 0;
    for (let y = imgStart; y < height; y++) {
      if (rowWhiteFrac[y] >= textWhiteFrac) {
        run++;
        if (run >= textRun) { splitY = y - run + 1; break; }
      } else {
        run = 0;
      }
    }

    if (splitY === null) {
      segments.push({ y0: imgStart, y1: height, splitY: height });
      break;
    }

    let nextImageStart = null;
    run = 0;
    for (let y = splitY; y < height; y++) {
      if (rowWhiteFrac[y] < textWhiteFrac) {
        run++;
        if (run >= imageRun) { nextImageStart = y - run + 1; break; }
      } else {
        run = 0;
      }
    }

    if (nextImageStart === null) {
      segments.push({ y0: imgStart, y1: height, splitY });
      break;
    }

    segments.push({ y0: imgStart, y1: nextImageStart, splitY });
    pos = nextImageStart;
  }

  return segments.filter(s => s.y1 - s.y0 > 2);
}

// Columns are detected once from the whole image (they share a consistent
// white gutter), but each column's cells are then found *independently* by
// scanning that column's own vertical strip top-to-bottom. This matters
// because real storyboard grids are not always a rigid table: caption
// length varies per cell, so one column's row boundaries commonly do not
// line up with another column's -- forcing shared row coordinates across
// columns would crop into the wrong cell's content. "Row" here is only a
// reading-order index (top-to-bottom position within a column), not a
// shared y-coordinate. A short last row (fewer cells than other rows) is
// handled naturally: that column's scan just yields one fewer segment.
function detectGrid(imageData, thresholds) {
  const { width, height } = imageData;
  const gray = toGray(imageData);
  const { whiteLevel, colBlankFrac, minColSeparator,
    textWhiteFrac, textRun, imageRun } = thresholds;

  const colBands = detectColumns(gray, width, height, whiteLevel, colBlankFrac, minColSeparator);
  const columnSegments = colBands.map(([cx0, cx1]) =>
    computeRowSegments(gray, width, height, whiteLevel, textWhiteFrac, textRun, imageRun, cx0, cx1)
  );
  const nRows = Math.max(0, ...columnSegments.map(segs => segs.length));

  const cells = [];
  for (let r = 0; r < nRows; r++) {
    colBands.forEach(([x0, x1], c) => {
      const segs = columnSegments[c];
      if (r >= segs.length) return;
      const { y0, y1, splitY } = segs[r];
      cells.push({
        row: r,
        col: c,
        imgBox: [x0, y0, x1, splitY],
        textBox: [x0, splitY, x1, y1],
      });
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function drawPreview(img, cells, startIndex) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  let index = startIndex;
  for (const cell of cells) {
    const [x0, y0, x1, y1] = cell.imgBox;
    const [tx0, ty0, tx1, ty1] = cell.textBox;

    if (y1 > y0) {
      ctx.strokeStyle = "#ff0000";
      ctx.lineWidth = 3;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    if (ty1 > ty0) {
      ctx.strokeStyle = "#0088ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(tx0, ty0, tx1 - tx0, ty1 - ty0);
    }

    const label = String(index);
    ctx.font = "bold 20px sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(label, x0 + 4, y0 + 20);
    ctx.fillStyle = "#ff0000";
    ctx.fillText(label, x0 + 4, y0 + 20);

    index++;
  }
  return { canvas, nextIndex: index };
}

// ---------------------------------------------------------------------------
// Preview button
// ---------------------------------------------------------------------------

btnPreview.addEventListener("click", async () => {
  btnPreview.disabled = true;
  btnPreview.textContent = "偵測中...";
  previewResults.innerHTML = "";
  previewSummary.textContent = "";

  const thresholds = readThresholds();
  state.cells = new Map();

  let globalIndex = 1;
  const summaryLines = [];

  for (const entry of state.files) {
    const img = await loadImage(entry.file);
    entry.img = img;

    const off = document.createElement("canvas");
    off.width = img.width;
    off.height = img.height;
    const offCtx = off.getContext("2d", { willReadFrequently: true });
    offCtx.drawImage(img, 0, 0);
    const imageData = offCtx.getImageData(0, 0, img.width, img.height);

    const cells = detectGrid(imageData, thresholds);
    state.cells.set(entry.id, cells);

    const nRows = new Set(cells.map(c => c.row)).size;
    const { canvas, nextIndex } = drawPreview(img, cells, globalIndex);

    const card = document.createElement("div");
    card.className = "preview-card";
    const heading = document.createElement("h3");
    heading.textContent = `${entry.name} — 偵測到 ${cells.length} 格,共 ${nRows} 列 (全域編號 ${globalIndex}-${nextIndex - 1})`;
    card.appendChild(heading);
    card.appendChild(canvas);
    previewResults.appendChild(card);

    summaryLines.push(`${entry.name}: ${cells.length} 格 / ${nRows} 列 -> 編號 ${globalIndex}-${nextIndex - 1}`);
    globalIndex = nextIndex;
  }

  previewSummary.textContent = summaryLines.join("\n");
  btnPreview.disabled = false;
  btnPreview.textContent = "執行偵測 / 預覽";
  btnExport.disabled = state.files.length === 0;
});

// ---------------------------------------------------------------------------
// Export: crop + OCR + zip
// ---------------------------------------------------------------------------

function cropToBlob(img, box) {
  const [x0, y0, x1, y1] = box;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

function cropToCanvas(img, box) {
  const [x0, y0, x1, y1] = box;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  return canvas;
}

btnExport.addEventListener("click", async () => {
  if (!state.cells) return;
  btnExport.disabled = true;
  btnPreview.disabled = true;
  exportProgress.hidden = false;

  const lang = document.getElementById("p-lang").value.trim() || "eng";
  const zip = new JSZip();

  const totalCells = [...state.cells.values()].reduce((sum, c) => sum + c.length, 0);
  let done = 0;

  const updateProgress = (label) => {
    const pct = totalCells === 0 ? 0 : Math.round((done / totalCells) * 100);
    exportProgressFill.style.width = `${pct}%`;
    exportProgressText.textContent = `${label} (${done}/${totalCells})`;
  };

  updateProgress("初始化 OCR 引擎...");
  const worker = await Tesseract.createWorker(lang);

  try {
    let globalIndex = 1;
    for (const entry of state.files) {
      const cells = state.cells.get(entry.id) || [];
      const stem = entry.name.replace(/\.png$/i, "");
      const folder = zip.folder(stem);

      for (const cell of cells) {
        const base = `${stem}_${globalIndex}`;
        updateProgress(`處理 ${base}`);

        const pngBlob = await cropToBlob(entry.img, cell.imgBox);
        folder.file(`${base}.png`, pngBlob);

        const textCanvas = cropToCanvas(entry.img, cell.textBox);
        const { data } = await worker.recognize(textCanvas);
        folder.file(`${base}.txt`, data.text);

        globalIndex++;
        done++;
        updateProgress(`處理 ${base}`);
      }
    }

    updateProgress("打包 ZIP...");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "storyboard_output.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    exportProgressText.textContent = `完成！共輸出 ${totalCells} 格,已下載 ZIP。`;
  } finally {
    await worker.terminate();
    btnExport.disabled = false;
    btnPreview.disabled = false;
  }
});
