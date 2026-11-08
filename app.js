(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const els = {
    input: $('#file-input'),
    dropzone: $('#dropzone'),
    gallery: $('#gallery'),
    thumbs: $('#thumbs'),
    editor: $('#editor'),
    stage: $('#stage'),
    canvas: $('#canvas'),
    status: $('#status'),
    toggle: $('#toggle-censor'),
    draw: $('#draw-mode'),
    remove: $('#remove-item'),
    actionbar: $('#actionbar'),
    saveOne: $('#save-one'),
    saveAll: $('#save-all'),
  };

  const state = {
    items: [],
    current: null,
    opts: { avatar: true, name: true, mention: true },
    style: 'blur',
    showCensor: true,
    drawing: false,
  };

  if (location.hash === '#debug') window.__sensor = state;

  let nextId = 1;
  let queue = Promise.resolve();
  let workerPromise = null;
  let ocrProgress = null;

  // ---------- OCR ----------

  function getWorker() {
    if (!workerPromise) {
      if (!window.Tesseract) return Promise.reject(new Error('OCR gagal dimuat. Cek koneksi internet, lalu muat ulang halaman.'));
      workerPromise = Tesseract.createWorker(['eng', 'ind'], 1, {
        logger: (m) => ocrProgress && ocrProgress(m),
      }).catch((err) => { workerPromise = null; throw err; });
    }
    return workerPromise;
  }

  function prepForOcr(item) {
    const scale = Math.min(1, 1400 / item.w);
    const c = document.createElement('canvas');
    c.width = Math.round(item.w * scale);
    c.height = Math.round(item.h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(item.bitmap, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    let sum = 0, n = 0;
    for (let i = 0; i < p.length; i += 64) { sum += p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114; n++; }
    const invert = sum / n < 110; // dark mode screenshots read better inverted
    for (let i = 0; i < p.length; i += 4) {
      let g = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
      if (invert) g = 255 - g;
      p[i] = p[i + 1] = p[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return { canvas: c, scale };
  }

  function getPixels(item) {
    const c = document.createElement('canvas');
    c.width = item.w; c.height = item.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(item.bitmap, 0, 0);
    return ctx.getImageData(0, 0, item.w, item.h).data;
  }

  async function analyze(item) {
    item.status = 'ocr';
    item.progress = 0;
    updateThumb(item);
    if (item === state.current) setStatus('Menyiapkan pembaca teks…');

    try {
      ocrProgress = (m) => {
        if (m.status === 'recognizing text') {
          item.progress = m.progress;
          updateThumb(item);
          if (item === state.current) setStatus(`Membaca teks… ${Math.round(m.progress * 100)}%`);
        } else if (/load|initializ/i.test(m.status) && item === state.current) {
          setStatus('Mengunduh pembaca teks (sekali saja)…');
        }
      };
      const worker = await getWorker();
      const { canvas, scale } = prepForOcr(item);
      const { data } = await worker.recognize(canvas);
      const k = 1 / scale;
      const box = (b) => ({ x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k });
      const lines = (data.lines || []).map((l) => ({
        ...box(l.bbox),
        words: (l.words || []).filter((w) => w.text.trim()).map((w) => ({ text: w.text, conf: w.confidence, ...box(w.bbox) })),
      }));
      item.words = lines.flatMap((l) => l.words);
      const found = BuzzerDetect.detect(lines, getPixels(item), item.w, item.h);
      item.boxes = found.map((b) => ({ ...b, on: true })).concat(item.boxes.filter((b) => b.kind === 'manual'));
      item.status = 'done';
    } catch (err) {
      console.error(err);
      item.status = 'error';
      item.error = err && err.message ? err.message : String(err);
    } finally {
      ocrProgress = null;
    }

    item.version++;
    updateThumb(item);
    if (item === state.current) { render(); showItemStatus(item); }
    scheduleExport(item);
  }

  // ---------- Rendering ----------

  function activeBoxes(item) {
    return item.boxes.filter((b) => b.on && (b.kind === 'manual' || state.opts[b.kind]));
  }

  const scratch = document.createElement('canvas');

  function censorBox(ctx, src, b) {
    if (state.style === 'solid') {
      ctx.fillStyle = '#111';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      return;
    }
    // Shrinking to a few pixels then scaling back up destroys the detail for good.
    const pixel = state.style === 'pixel';
    const k = Math.max(6, Math.min(b.w, b.h) / (pixel ? 4 : 3));
    const tw = Math.max(1, Math.round(b.w / k));
    const th = Math.max(1, Math.round(b.h / k));
    scratch.width = tw; scratch.height = th;
    const sctx = scratch.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, tw, th);
    ctx.save();
    ctx.imageSmoothingEnabled = !pixel;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scratch, 0, 0, tw, th, b.x, b.y, b.w, b.h);
    ctx.restore();
  }

  function paint(ctx, item, censored) {
    ctx.drawImage(item.bitmap, 0, 0);
    if (censored) activeBoxes(item).forEach((b) => censorBox(ctx, item.bitmap, b));
  }

  let dragRect = null;

  function render() {
    const item = state.current;
    if (!item) return;
    const c = els.canvas;
    if (c.width !== item.w || c.height !== item.h) { c.width = item.w; c.height = item.h; }
    const ctx = c.getContext('2d');
    paint(ctx, item, state.showCensor);

    // Outlines are for editing only; exports never include them.
    const lw = Math.max(2, Math.round(item.w / 400));
    ctx.lineWidth = lw;
    item.boxes.forEach((b) => {
      if (b.kind !== 'manual' && !state.opts[b.kind]) return;
      ctx.setLineDash(b.on ? [] : [lw * 3, lw * 2]);
      ctx.strokeStyle = b.on ? '#ef3b45' : 'rgba(128,128,128,.9)';
      ctx.strokeRect(b.x + lw / 2, b.y + lw / 2, b.w - lw, b.h - lw);
    });
    if (dragRect) {
      ctx.setLineDash([lw * 3, lw * 2]);
      ctx.strokeStyle = '#ef3b45';
      ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    }
    ctx.setLineDash([]);
  }

  // ---------- Export ----------

  function exportBlob(item) {
    const c = document.createElement('canvas');
    c.width = item.w; c.height = item.h;
    paint(c.getContext('2d'), item, true);
    return new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal membuat gambar'))), 'image/png'));
  }

  // iOS only allows the share sheet straight from a tap, so files are prepared ahead of time.
  function scheduleExport(item) {
    clearTimeout(item.exportTimer);
    item.file = null;
    updateSaveButtons();
    item.exportTimer = setTimeout(async () => {
      if (item.removed) return;
      const v = item.version;
      const style = state.style;
      try {
        const blob = await exportBlob(item);
        if (v !== item.version || style !== state.style) return;
        item.file = new File([blob], item.outName, { type: 'image/png' });
        if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
        item.thumbUrl = URL.createObjectURL(blob);
        updateThumb(item);
      } catch (err) {
        console.error(err);
      }
      updateSaveButtons();
    }, 250);
  }

  function exportAll() { state.items.forEach(scheduleExport); }

  function canShareFiles(files) {
    try { return !!(navigator.canShare && navigator.canShare({ files })); } catch { return false; }
  }

  async function saveFiles(files) {
    if (canShareFiles(files)) {
      try {
        await navigator.share({ files });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.warn('share failed, falling back to download', err);
      }
    }
    files.forEach((f, i) => setTimeout(() => {
      const url = URL.createObjectURL(f);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, i * 300));
  }

  function updateSaveButtons() {
    const item = state.current;
    const busy = (it) => it.status === 'ocr' || it.status === 'queued' || !it.file;
    els.saveOne.disabled = !item || busy(item);
    els.saveOne.textContent = item && busy(item) ? 'Menyiapkan…' : 'Simpan foto ini';
    const n = state.items.length;
    els.saveAll.hidden = n < 2;
    els.saveAll.disabled = state.items.some(busy);
    els.saveAll.textContent = `Simpan semua (${n})`;
  }

  // ---------- Items ----------

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif|gif)$/i.test(f.name));
    if (!files.length) return;
    let firstNew = null;
    for (const file of files) {
      let bitmap;
      try {
        bitmap = await loadImage(file);
      } catch (err) {
        console.error(err);
        setStatus(`${file.name} tidak bisa dibuka. Coba format PNG atau JPG.`);
        continue;
      }
      const item = {
        id: nextId++,
        name: file.name,
        outName: (file.name.replace(/\.[^.]+$/, '') || 'screenshot') + '-blur.png',
        bitmap,
        w: bitmap.naturalWidth || bitmap.width,
        h: bitmap.naturalHeight || bitmap.height,
        srcUrl: bitmap.src,
        boxes: [],
        words: [],
        status: 'queued',
        progress: 0,
        version: 0,
        file: null,
      };
      state.items.push(item);
      addThumb(item);
      if (!firstNew) firstNew = item;
      queue = queue.then(() => analyze(item));
    }
    if (!firstNew) return;
    els.gallery.hidden = false;
    els.editor.hidden = false;
    els.actionbar.hidden = false;
    // The editor always shows what was just added, otherwise taps and saves land on an older screenshot.
    select(firstNew);
    showEditor();
  }

  function showEditor() {
    const smooth = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
    els.editor.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    if (!smooth) return;
    // Some webviews (in-app browsers) drop smooth scrolling; make sure the editor still ends up in view.
    setTimeout(() => {
      const top = els.editor.getBoundingClientRect().top;
      if (top > window.innerHeight * 0.5 || top < -els.editor.offsetHeight) {
        els.editor.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    }, 600);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = URL.createObjectURL(file);
    });
  }

  function addThumb(item) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb';
    btn.dataset.id = item.id;
    btn.innerHTML = '<img alt=""><span class="thumb-badge"></span>';
    btn.addEventListener('click', () => select(item));
    li.appendChild(btn);
    els.thumbs.appendChild(li);
    item.thumbEl = btn;
    updateThumb(item);
  }

  function updateThumb(item) {
    const btn = item.thumbEl;
    if (!btn) return;
    const img = btn.querySelector('img');
    const src = item.thumbUrl || item.srcUrl;
    if (img.getAttribute('src') !== src) img.src = src;
    const badge = btn.querySelector('.thumb-badge');
    const n = activeBoxes(item).length;
    const label = {
      queued: 'Antre',
      ocr: `${Math.round(item.progress * 100)}%`,
      done: `${n} blur`,
      error: 'Manual',
    }[item.status];
    badge.textContent = label;
    badge.classList.toggle('is-done', item.status === 'done');
    btn.setAttribute('aria-label', `${item.name}: ${label}`);
    btn.setAttribute('aria-current', item === state.current ? 'true' : 'false');
  }

  function select(item) {
    state.current = item;
    state.items.forEach(updateThumb);
    render();
    showItemStatus(item);
    updateSaveButtons();
  }

  function showItemStatus(item) {
    if (item.status === 'done') {
      const n = activeBoxes(item).length;
      setStatus(n ? `${n} area diblur. Cek lagi sebelum disimpan.` : 'Gak nemu nama atau foto profil. Tap teks atau gambar kotak sendiri.');
    } else if (item.status === 'error') {
      setStatus(`Deteksi otomatis gagal (${item.error}). Kamu masih bisa blur manual.`);
    } else if (item.status === 'queued') {
      setStatus('Menunggu giliran…');
    }
  }

  function removeCurrent() {
    const item = state.current;
    if (!item) return;
    const idx = state.items.indexOf(item);
    state.items.splice(idx, 1);
    item.thumbEl.parentElement.remove();
    URL.revokeObjectURL(item.srcUrl);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    item.removed = true;
    state.current = null;
    const next = state.items[idx] || state.items[idx - 1];
    if (next) select(next);
    else {
      els.gallery.hidden = true;
      els.editor.hidden = true;
      els.actionbar.hidden = true;
      setStatus('');
    }
  }

  function setStatus(text) { els.status.textContent = text; }

  function changed(item) {
    item.version++;
    render();
    updateThumb(item);
    showItemStatus(item);
    scheduleExport(item);
  }

  // ---------- Canvas interaction ----------

  function toImage(e) {
    const r = els.canvas.getBoundingClientRect();
    const item = state.current;
    return {
      x: (e.clientX - r.left) * (item.w / r.width),
      y: (e.clientY - r.top) * (item.h / r.height),
      scale: item.w / r.width,
    };
  }

  // How far (in CSS px) a tap may land outside a box or word and still count.
  const TAP_SLOP = 12;

  function distance(p, b) {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
    return Math.hypot(dx, dy);
  }

  const inside = (p, b, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

  let pointer = null;

  els.canvas.addEventListener('pointerdown', (e) => {
    if (!state.current) return;
    pointer = { start: toImage(e), id: e.pointerId, moved: false };
    if (state.drawing) els.canvas.setPointerCapture(e.pointerId);
  });

  els.canvas.addEventListener('pointermove', (e) => {
    if (!pointer || pointer.id !== e.pointerId || !state.drawing) return;
    const p = toImage(e);
    const s = pointer.start;
    if (!pointer.moved && Math.hypot(p.x - s.x, p.y - s.y) / p.scale < 6) return;
    pointer.moved = true;
    dragRect = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    render();
  });

  els.canvas.addEventListener('pointerup', (e) => {
    if (!pointer || pointer.id !== e.pointerId) return;
    const item = state.current;
    const p = toImage(e);
    if (pointer.moved && dragRect) {
      if (dragRect.w > 4 && dragRect.h > 4) {
        item.boxes.push({ ...roundBox(dragRect), kind: 'manual', on: true });
      }
      dragRect = null;
      pointer = null;
      changed(item);
      return;
    }
    const s = pointer.start;
    pointer = null;
    if (Math.hypot(p.x - s.x, p.y - s.y) / p.scale > 10) return; // a scroll or drag, not a tap
    handleTap(item, p);
  });

  els.canvas.addEventListener('pointercancel', () => { pointer = null; dragRect = null; render(); });

  function roundBox(b) {
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
  }

  function handleTap(item, p) {
    const boxes = item.boxes.filter((b) => b.kind === 'manual' || state.opts[b.kind]);
    const words = item.words.map((w) => ({ x: w.x0, y: w.y0, w: w.x1 - w.x0, h: w.y1 - w.y0, word: w }));

    // A direct hit wins. Otherwise take the nearest target within a fingertip's reach,
    // because on a phone a 15px-tall name box is too small to hit exactly.
    let target = boxes.filter((b) => inside(p, b)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (!target) target = words.find((w) => inside(p, w));
    if (!target) {
      const reach = TAP_SLOP * p.scale;
      let best = Infinity;
      for (const t of [...boxes, ...words]) {
        const d = distance(p, t);
        if (d <= reach && d < best) { best = d; target = t; }
      }
    }
    if (!target) return;

    if (!target.word) {
      if (target.kind === 'manual') item.boxes.splice(item.boxes.indexOf(target), 1);
      else target.on = !target.on;
      changed(item);
      return;
    }
    const word = target.word;
    {
      const pad = Math.max(2, Math.round((word.y1 - word.y0) * 0.25));
      item.boxes.push({
        ...roundBox({ x: word.x0 - pad, y: word.y0 - pad, w: word.x1 - word.x0 + pad * 2, h: word.y1 - word.y0 + pad * 2 }),
        kind: 'manual', on: true,
      });
      changed(item);
    }
  }

  // ---------- Controls ----------

  els.input.addEventListener('change', () => {
    addFiles(els.input.files);
    els.input.value = '';
  });

  ['dragenter', 'dragover'].forEach((t) => els.dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('is-dragover');
  }));
  ['dragleave', 'drop'].forEach((t) => els.dropzone.addEventListener(t, () => els.dropzone.classList.remove('is-dragover')));
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  // Paste a screenshot straight from the clipboard on desktop.
  window.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData ? e.clipboardData.files : []);
    if (files.length) addFiles(files);
  });

  [['opt-avatar', 'avatar'], ['opt-name', 'name'], ['opt-mention', 'mention']].forEach(([id, key]) => {
    $('#' + id).addEventListener('change', (e) => {
      state.opts[key] = e.target.checked;
      state.items.forEach((it) => { it.version++; updateThumb(it); });
      render();
      if (state.current) showItemStatus(state.current);
      exportAll();
    });
  });

  document.querySelectorAll('input[name="style"]').forEach((r) => r.addEventListener('change', (e) => {
    state.style = e.target.value;
    state.items.forEach((it) => it.version++);
    render();
    exportAll();
  }));

  els.toggle.addEventListener('change', () => {
    state.showCensor = els.toggle.checked;
    render();
  });

  els.draw.addEventListener('click', () => {
    state.drawing = !state.drawing;
    els.draw.setAttribute('aria-pressed', String(state.drawing));
    els.stage.classList.toggle('is-drawing', state.drawing);
  });

  els.remove.addEventListener('click', removeCurrent);

  els.saveOne.addEventListener('click', () => {
    const item = state.current;
    if (item && item.file) saveFiles([item.file]);
  });

  els.saveAll.addEventListener('click', () => {
    const files = state.items.map((it) => it.file).filter(Boolean);
    if (files.length === state.items.length) saveFiles(files);
  });
})();
