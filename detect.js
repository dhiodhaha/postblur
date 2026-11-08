/*
 * Finds usernames, display names, mentions and profile photos in a
 * social-media screenshot, given OCR lines and the raw pixels.
 *
 * Input lines use full-resolution image coordinates:
 *   [{ x0, y0, x1, y1, words: [{ text, x0, y0, x1, y1 }] }]
 * Output boxes: [{ x, y, w, h, kind: 'avatar' | 'name' | 'mention' }]
 */
(function (root) {
  'use strict';

  const HANDLE_RE = /^@[\p{L}\p{N}_.]{2,}/u;
  const SEP_RE = /^[·•∙・|.\-–—]+$/;
  const TIME_RE = /^\d{1,3}(s|d|m|h|w|y|j|mnt|menit|jam|hr|hrs|hari|mg|mgg|minggu|bln|bulan|th|thn|tahun|min|mins|day|days|wk|wks)$/i;
  const FOLLOW_RE = /^(follow|following|ikuti|mengikuti|diikuti|verified|terverifikasi|author|kreator|creator|pembuat)$/i;
  const REPLY_RE = /^(reply|replies|balas|balasan|like|likes|suka|ago|lalu)$/i;
  const LIKED_BY_RE = /^(oleh|by)$/i;

  const clean = (t) => t.replace(/^[^\p{L}\p{N}@_]+|[^\p{L}\p{N}_]+$/gu, '');

  function isMarker(word) {
    const raw = word.text.trim();
    if (SEP_RE.test(raw)) return true;
    const c = clean(raw);
    return TIME_RE.test(c) || FOLLOW_RE.test(c);
  }

  function isMetaLine(line) {
    // "2j  12 suka  Balas" (Instagram) / "2d ago Reply" (TikTok)
    const w = line.words;
    if (!w.length) return false;
    const first = clean(w[0].text);
    if (!(TIME_RE.test(first) || /^\d{1,3}$/.test(first))) return false;
    return w.some((x) => REPLY_RE.test(clean(x.text)));
  }

  function lineHeight(line) {
    // Median word height is steadier than the line box, which grows with emoji and badges.
    const hs = line.words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    return hs.length ? hs[Math.floor(hs.length / 2)] : line.y1 - line.y0;
  }

  function union(words) {
    return words.reduce((b, w) => ({
      x0: Math.min(b.x0, w.x0), y0: Math.min(b.y0, w.y0),
      x1: Math.max(b.x1, w.x1), y1: Math.max(b.y1, w.y1),
    }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  }

  function markWords(lines) {
    // marks[lineIdx][wordIdx] = 'name' | 'mention'
    const marks = lines.map((l) => l.words.map(() => null));
    const avatarLines = new Set();

    lines.forEach((line, li) => {
      const w = line.words;
      const m = marks[li];

      // Handles: header "Name ✓ @handle · 2h" or inline mention.
      w.forEach((word, i) => {
        if (!HANDLE_RE.test(clean(word.text))) return;
        const after = w.slice(i + 1, i + 3);
        const isHeader = i <= 6 && (
          after.some(isMarker) ||
          (i === w.length - 1 && i <= 4) ||
          (i === 0 && w.length <= 2)
        );
        if (isHeader) {
          // OCR often reads "_" as a space, splitting "@buzzer_id" into "@buzzer id".
          let end = i;
          const nextMarker = w.findIndex((x, k) => k > i && isMarker(x));
          if (nextMarker > i && nextMarker - i <= 3) end = nextMarker - 1;
          for (let k = 0; k <= end; k++) if (!isMarker(w[k])) m[k] = 'name';
          avatarLines.add(li);
        } else if (!m[i]) {
          m[i] = 'mention';
        }
      });

      // "username • Ikuti" / "username 2j" at the start of a line.
      if (!m.some(Boolean)) {
        for (let i = 1; i <= Math.min(3, w.length - 1); i++) {
          if (!isMarker(w[i])) continue;
          if (/^\d+$/.test(clean(w[0].text))) break;
          for (let k = 0; k < i; k++) if (!isMarker(w[k])) m[k] = 'name';
          avatarLines.add(li);
          break;
        }
      }

      // "Disukai oleh username" / "Liked by username"
      w.forEach((word, i) => {
        if (i > 0 && i < w.length - 1 && LIKED_BY_RE.test(clean(word.text)) &&
            /^(disukai|liked)$/i.test(clean(w[i - 1].text))) {
          m[i + 1] = m[i + 1] || 'name';
        }
      });
    });

    // Comment blocks: the top line of a block that ends with a meta line starts with the username.
    lines.forEach((line, li) => {
      if (!isMetaLine(line)) return;
      const lh = lineHeight(line);
      let top = -1;
      let prevY0 = line.y0;
      for (let k = li - 1; k >= 0 && k >= li - 6; k--) {
        const l = lines[k];
        if (Math.abs(l.x0 - line.x0) > lh * 1.5) break;
        if (prevY0 - l.y1 > lh * 1.8) break;
        top = k;
        prevY0 = l.y0;
      }
      if (top >= 0 && lines[top].words.length && !marks[top][0]) {
        marks[top][0] = 'name';
        avatarLines.add(top);
      }
    });

    return { marks, avatarLines };
  }

  function groupBoxes(lines, marks) {
    const boxes = [];
    lines.forEach((line, li) => {
      const lh = lineHeight(line);
      const pad = Math.max(2, Math.round(lh * 0.25));
      let run = [];
      let kind = null;
      const flush = () => {
        if (!run.length) return;
        const b = union(run);
        boxes.push({ x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + pad * 2, h: b.y1 - b.y0 + pad * 2, kind });
        run = [];
      };
      line.words.forEach((word, i) => {
        const k = marks[li][i];
        // Keep separators between two marked words inside the same box.
        if (k && (k === kind || !run.length)) { run.push(word); kind = k; }
        else if (k) { flush(); run.push(word); kind = k; }
        else flush();
      });
      flush();
    });
    return boxes;
  }

  function dominantColor(px, W, H, b) {
    const counts = new Map();
    let best = 0, bestKey = 0;
    const x0 = Math.max(0, b.x0 | 0), x1 = Math.min(W, b.x1 | 0);
    const y0 = Math.max(0, b.y0 | 0), y1 = Math.min(H, b.y1 | 0);
    const step = Math.max(1, Math.round((y1 - y0) / 12));
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * W + x) * 4;
        const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
        const n = (counts.get(key) || 0) + 1;
        counts.set(key, n);
        if (n > best) { best = n; bestKey = key; }
      }
    }
    return [((bestKey >> 8) & 15) * 16 + 8, ((bestKey >> 4) & 15) * 16 + 8, (bestKey & 15) * 16 + 8];
  }

  /*
   * The avatar sits left of the first name word. Look for a blob of
   * non-background pixels there, starting from the cells closest to the text.
   */
  function findAvatar(px, W, H, nameBox, lh) {
    if (nameBox.x0 < lh * 1.5) return null;
    const bg = dominantColor(px, W, H, nameBox);
    const rx0 = Math.max(0, Math.round(nameBox.x0 - lh * 7));
    const rx1 = Math.round(nameBox.x0 - lh * 0.3);
    const ry0 = Math.max(0, Math.round(nameBox.y0 - lh * 3));
    const ry1 = Math.min(H, Math.round(nameBox.y1 + lh * 4));
    if (rx1 - rx0 < lh || ry1 - ry0 < lh) return null;

    const cell = Math.max(2, Math.round(lh / 5));
    const gw = Math.ceil((rx1 - rx0) / cell);
    const gh = Math.ceil((ry1 - ry0) / cell);
    const grid = new Uint8Array(gw * gh);
    const sub = Math.max(1, Math.floor(cell / 3));
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let fg = 0;
        const cx0 = rx0 + gx * cell, cy0 = ry0 + gy * cell;
        for (let y = cy0; y < Math.min(cy0 + cell, ry1) && !fg; y += sub) {
          for (let x = cx0; x < Math.min(cx0 + cell, rx1); x += sub) {
            const i = (y * W + x) * 4;
            const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
            if (d > 60) { fg = 1; break; }
          }
        }
        grid[gy * gw + gx] = fg;
      }
    }

    // Seed: rightmost foreground cell on the rows the name occupies.
    const sy0 = Math.max(0, Math.floor((nameBox.y0 - ry0) / cell));
    const sy1 = Math.min(gh - 1, Math.floor((nameBox.y1 - ry0) / cell));
    let seed = -1;
    for (let gx = gw - 1; gx >= 0 && seed < 0; gx--) {
      for (let gy = sy0; gy <= sy1; gy++) {
        if (grid[gy * gw + gx]) { seed = gy * gw + gx; break; }
      }
    }
    if (seed < 0) return null;

    // Flood fill (8-connected), bridging 1-cell gaps so photos with background-coloured patches stay whole.
    const seen = new Uint8Array(gw * gh);
    const stack = [seed];
    seen[seed] = 1;
    let minX = gw, minY = gh, maxX = -1, maxY = -1, count = 0;
    while (stack.length) {
      const c = stack.pop();
      const cx = c % gw, cy = (c / gw) | 0;
      count++;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (!seen[n] && grid[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }

    let x = rx0 + minX * cell, y = ry0 + minY * cell;
    let w = (maxX - minX + 1) * cell, h = (maxY - minY + 1) * cell;
    if (w < lh * 1.3 || w > lh * 6.5) return null;
    if (h < w * 0.6) return null;
    if (h > w * 1.4) {
      // Thread lines on X connect avatars vertically; keep the square nearest the name.
      const top = Math.min(Math.max(y, nameBox.y0 - w * 0.6), y + h - w);
      y = top; h = w;
    }
    if (count < (w / cell) * (h / cell) * 0.35) return null;
    const pad = cell;
    return { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2, kind: 'avatar' };
  }

  function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = ix * iy;
    return inter / Math.min(a.w * a.h, b.w * b.h);
  }

  // OCR reads avatars and icons as junk like "V", "9" or "«©". Drop those so they don't anchor names.
  function dropJunk(line) {
    const lh = lineHeight(line);
    let words = line.words.filter((w) => {
      const c = clean(w.text);
      if (SEP_RE.test(w.text.trim())) return true;
      if (!c) return false;
      if (w.y1 - w.y0 > lh * 1.7) return false;
      if (c.length <= 2 && w.conf != null && w.conf < 50 && !TIME_RE.test(c)) return false;
      return true;
    });
    while (words.length > 1) {
      const [a, b] = words;
      if (clean(a.text).length <= 2 && !TIME_RE.test(clean(a.text)) && b.x0 - a.x1 > lh * 1.2) words = words.slice(1);
      else break;
    }
    if (!words.length) return null;
    const b = union(words);
    return { ...b, words };
  }

  function detect(lines, px, W, H) {
    lines = lines.map(dropJunk).filter(Boolean);
    const { marks, avatarLines } = markWords(lines);
    const boxes = groupBoxes(lines, marks);

    if (px) {
      const avatars = [];
      avatarLines.forEach((li) => {
        const line = lines[li];
        const first = marks[li].findIndex(Boolean);
        if (first !== 0) return;
        let end = 0;
        while (end + 1 < line.words.length && marks[li][end + 1]) end++;
        const nameBox = union(line.words.slice(0, end + 1));
        const a = findAvatar(px, W, H, nameBox, lineHeight(line));
        if (a && !avatars.some((b) => iou(a, b) > 0.5)) avatars.push(a);
      });
      boxes.push(...avatars);
    }

    return boxes.map((b) => {
      const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
      return {
        x, y,
        w: Math.min(W - x, Math.round(b.w)),
        h: Math.min(H - y, Math.round(b.h)),
        kind: b.kind,
      };
    }).filter((b) => b.w > 2 && b.h > 2);
  }

  const api = { detect, isMarker, isMetaLine, markWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuzzerDetect = api;
})(typeof self !== 'undefined' ? self : this);
