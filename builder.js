/* Tally form builder: blank PDF -> detected answer boxes -> AI names them -> you check -> saved form template.
 * Uses globals from app.js: S, CFG, $, esc, cv, pdfjsLib, renderPage, loadImage, settings, helperHealth,
 * FormStore, useForm, renderForms, setStatus, download, stamp, sleep.
 */
'use strict';

const B = { pages: [], fields: [], page: 0, sel: null, drag: null, editingId: null };

/* ---------- page preparation ---------- */
function matToDataURL(mat) { const c = document.createElement('canvas'); cv.imshow(c, mat); return c.toDataURL('image/jpeg', 0.9); }

// straighten a slightly rotated scan: pick the angle where text rows are sharpest
function deskew(gray) {
  const small = new cv.Mat(); cv.resize(gray, small, new cv.Size(0, 0), 0.25, 0.25, cv.INTER_AREA);
  const bin = new cv.Mat(); cv.threshold(small, bin, 160, 1, cv.THRESH_BINARY_INV);
  let best = 0, bestVar = -1; const w = bin.cols, h = bin.rows, rot = new cv.Mat();
  for (let a = -4; a <= 4.001; a += 0.25) {
    const M = cv.getRotationMatrix2D(new cv.Point(w / 2, h / 2), a, 1);
    cv.warpAffine(bin, rot, M, new cv.Size(w, h)); M.delete();
    const d = rot.data; let sum = 0, sq = 0;
    for (let y = 0; y < h; y++) { let r = 0; for (let x = 0; x < w; x++) r += d[y * w + x]; sum += r; sq += r * r; }
    const v = sq / h - (sum / h) ** 2; if (v > bestVar) { bestVar = v; best = a; }
  }
  small.delete(); bin.delete(); rot.delete();
  if (Math.abs(best) < 0.2) return gray.clone();
  const out = new cv.Mat(), M = cv.getRotationMatrix2D(new cv.Point(gray.cols / 2, gray.rows / 2), best, 1);
  cv.warpAffine(gray, out, M, new cv.Size(gray.cols, gray.rows), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255)); M.delete();
  return out;
}

/* ---------- detection ---------- */
function overlapFrac(a, b) {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (x * y) / Math.min(a[2] * a[3], b[2] * b[3]);
}
function inkCount(bin, r) {
  const x = Math.max(0, r[0] | 0), y = Math.max(0, r[1] | 0), w = Math.min(bin.cols - x, r[2] | 0), h = Math.min(bin.rows - y, r[3] | 0);
  if (w <= 0 || h <= 0) return 0;
  const roi = bin.roi(new cv.Rect(x, y, w, h)); const n = cv.countNonZero(roi); roi.delete(); return n;
}

function detectPage(gray) {
  const W = gray.cols, H = gray.rows, found = [];
  const bin = new cv.Mat(); cv.threshold(gray, bin, 160, 255, cv.THRESH_BINARY_INV);
  const faint = new cv.Mat(); cv.threshold(gray, faint, 242, 255, cv.THRESH_BINARY_INV);

  // 1) "[ ]" bracket pairs (printed as text)
  const lab = new cv.Mat(), st = new cv.Mat(), cen = new cv.Mat();
  const n = cv.connectedComponentsWithStats(bin, lab, st, cen, 8);
  const comps = [];
  for (let i = 1; i < n; i++) {
    const x = st.intAt(i, 0), y = st.intAt(i, 1), w = st.intAt(i, 2), h = st.intAt(i, 3);
    if (h < 20 || h > 46 || w < 4 || w > 15) continue;
    // stroke side: a "[" has its full-height stroke on the left, a "]" on the right
    let left = 0, right = 0;
    for (let yy = y; yy < y + h; yy++) { if (bin.ucharPtr(yy, x)[0] || bin.ucharPtr(yy, x + 1)[0]) left++; if (bin.ucharPtr(yy, x + w - 1)[0] || bin.ucharPtr(yy, x + w - 2)[0]) right++; }
    let type = left > 0.8 * h && right < 0.45 * h ? '[' : right > 0.8 * h && left < 0.45 * h ? ']' : null;
    if (type) {
      const openX = type === '[' ? x + w - 1 : x;                 // the side away from the stroke
      const at = (yy) => bin.ucharPtr(yy, openX)[0] || bin.ucharPtr(yy, type === '[' ? openX - 1 : openX + 1)[0];
      let top = 0, bot = 0, mid = 0;
      for (let k = 0; k < 4; k++) { if (at(y + k)) top = 1; if (at(y + h - 1 - k)) bot = 1; }
      for (let yy = y + Math.round(h * 0.3); yy < y + Math.round(h * 0.7); yy++) if (at(yy)) mid++;
      if (!top || !bot || mid > 1) type = null;
    }
    if (type) comps.push({ type, x, y, w, h });
  }
  lab.delete(); st.delete(); cen.delete();
  const opens = comps.filter((c) => c.type === '['), closes = comps.filter((c) => c.type === ']');
  const usedClose = new Set(), pairs = [];
  for (const o of opens) {
    const c = closes.filter((k) => !usedClose.has(k) && k.x > o.x + o.w + 4 && k.x - (o.x + o.w) < 32 && Math.abs(k.y - o.y) < 7 && Math.abs(k.h - o.h) < 8)
      .sort((a, b) => a.x - b.x)[0];
    if (!c) continue;
    usedClose.add(c); o.paired = true;
    const box = [o.x, Math.min(o.y, c.y), c.x + c.w - o.x, Math.max(o.y + o.h, c.y + c.h) - Math.min(o.y, c.y)];
    pairs.push(box); found.push({ kind: 'checkbox', shape: 'bracket', box });   // ticks inside are fine: forms are often filled
  }
  // a tick that touches the other bracket hides it; use the typical box width from the pairs we did find
  const bw = pairs.length ? pairs.map((b) => b[2]).sort((a, b) => a - b)[pairs.length >> 1] : 30;
  for (const o of opens) if (!o.paired) found.push({ kind: 'checkbox', shape: 'bracket', box: [o.x, o.y, bw, o.h], guessed: true });
  for (const c of closes) if (!usedClose.has(c) && !found.some((f) => overlapFrac(f.box, [c.x + c.w - bw, c.y, bw, c.h]) > 0.3)) found.push({ kind: 'checkbox', shape: 'bracket', box: [c.x + c.w - bw, c.y, bw, c.h], guessed: true });

  // 2) printed squares
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i), r = cv.boundingRect(c);
    if (r.width >= 16 && r.width <= 60 && r.height >= 16 && r.height <= 60 && r.width / r.height > 0.75 && r.width / r.height < 1.33) {
      const ap = new cv.Mat(); cv.approxPolyDP(c, ap, 0.08 * cv.arcLength(c, true), true);
      // a real box has straight sides: its outline fills its bounding rectangle (a letter "o" does not)
      const fill = cv.contourArea(c) / (r.width * r.height);
      if (ap.rows === 4 && r.width >= 16 && fill > 0.86 && cv.isContourConvex(ap) && inkCount(bin, [r.x + 4, r.y + 4, r.width - 8, r.height - 8]) < 0.08 * r.width * r.height) {
        const box = [r.x, r.y, r.width, r.height];
        if (!found.some((f) => overlapFrac(f.box, box) > 0.4)) found.push({ kind: 'checkbox', shape: 'square', box });
      }
      ap.delete();
    }
    c.delete();
  }
  contours.delete(); hier.delete();

  // 3) tables. Ruled lines on scanned forms are often faint and broken, so: find table areas from line fragments,
  //    then locate the rows and columns from where light-grey ink lines up across the area.
  const hk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.round(W * 0.05), 1));
  const vk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 45));
  const hl = new cv.Mat(), vl = new cv.Mat(), grid = new cv.Mat();
  cv.morphologyEx(faint, hl, cv.MORPH_OPEN, hk); cv.morphologyEx(faint, vl, cv.MORPH_OPEN, vk);
  cv.bitwise_or(hl, vl, grid);
  const dk = cv.Mat.ones(31, 31, cv.CV_8U); cv.dilate(grid, grid, dk);
  const tables = [];
  const gl = new cv.Mat(), gs = new cv.Mat(), gc = new cv.Mat();
  const gn = cv.connectedComponentsWithStats(grid, gl, gs, gc, 8);
  for (let i = 1; i < gn; i++) {
    const x = gs.intAt(i, 0), y = gs.intAt(i, 1), w = gs.intAt(i, 2), h = gs.intAt(i, 3);
    if (w > 300 && h > 120) tables.push([x, y, w, h]);
  }
  gl.delete(); gs.delete(); gc.delete();
  const gd = gray.data, gw = gray.cols;
  // light-grey rule pixels only: ignore the grey edges of printed letters (anything within 2 px of dark ink)
  const dark = new cv.Mat(), near = new cv.Mat(), k5 = cv.Mat.ones(5, 5, cv.CV_8U);
  cv.threshold(gray, dark, 170, 255, cv.THRESH_BINARY_INV); cv.dilate(dark, near, k5); dark.delete(); k5.delete();
  const nd = near.data;
  const lineAt = (prof, thr) => {
    const groups = []; let grp = [];
    prof.forEach((v, i) => { if (v > thr) { if (grp.length && i - grp[grp.length - 1] > 4) { groups.push(grp); grp = []; } grp.push(i); } });
    if (grp.length) groups.push(grp);
    const lines = groups.map((g) => ({ at: Math.round(g.reduce((a, b) => a + b, 0) / g.length), score: Math.max(...g.map((i) => prof[i])) }));
    const out = [];
    for (const l of lines) { const last = out[out.length - 1]; if (last && l.at - last.at < 22) { if (l.score > last.score) out[out.length - 1] = l; } else out.push(l); }
    return out.map((l) => l.at);
  };
  // tolerate rules that are a hair off straight: sum 3 neighbouring px, then take the max within ±3 px
  const tol = (p) => { const c = p.map((_, i) => (p[i - 1] || 0) + p[i] + (p[i + 1] || 0)); return c.map((_, i) => { let m = 0; for (let k = Math.max(0, i - 3); k <= Math.min(c.length - 1, i + 3); k++) m = Math.max(m, c[k]); return m; }); };
  for (const t of tables) {
    const [tx, ty, tw, th] = t, col = new Array(tw).fill(0), row = new Array(th).fill(0);
    const hd = hl.data, vd = vl.data;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const o = (ty + y) * gw + tx + x, v = gd[o];
      // a rule pixel is part of a long straight run (dark or faint), or a light-grey pixel away from printed letters
      const faintRule = v < 250 && v >= 170 && !nd[o];
      if (vd[o] || faintRule) col[x]++;
      if (hd[o] || faintRule) row[y]++;
    }
    const xs = lineAt(tol(col.map((v) => v / th)), 0.45), ys = lineAt(tol(row.map((v) => v / tw)), 0.35);
    for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
      const w = xs[i + 1] - xs[i], h = ys[j + 1] - ys[j];
      if (w < 45 || h < 28) continue;
      const cell = [tx + xs[i] + 5, ty + ys[j] + 5, w - 10, h - 10];
      if (found.some((f) => overlapFrac(f.box, cell) > 0.3)) continue;
      // keep cells even if something is written in them (filled sample forms); printed headings get set to Ignore
      const printed = inkCount(bin, cell) / (cell[2] * cell[3]);
      found.push({ kind: 'cell', box: cell, table: t, header: j === 0, inked: printed > 0.004, col: i, row: j });
    }
  }
  near.delete();

  // 4) write-in lines (dark underlines outside tables)
  const ul = new cv.Mat(); const uk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(40, 1));
  cv.morphologyEx(bin, ul, cv.MORPH_OPEN, uk);
  const ll = new cv.Mat(), ls = new cv.Mat(), lc = new cv.Mat();
  const ln = cv.connectedComponentsWithStats(ul, ll, ls, lc, 8);
  for (let i = 1; i < ln; i++) {
    const x = ls.intAt(i, 0), y = ls.intAt(i, 1), w = ls.intAt(i, 2), h = ls.intAt(i, 3);
    if (h > 6 || w < 40 || w > W * 0.75) continue;
    if (y < H * 0.06 || y > H * 0.95 || x < W * 0.03 || x + w > W * 0.97) continue;   // scanner edges and shadows
    if (tables.some((t) => x >= t[0] - 5 && x + w <= t[0] + t[2] + 5 && y >= t[1] - 5 && y <= t[1] + t[3] + 5)) continue;
    const box = [Math.max(0, x - 8), Math.max(0, y - (w < 120 ? 52 : 78)), w + 16, w < 120 ? 60 : 86];
    if (found.some((f) => overlapFrac(f.box, box) > 0.3)) continue;
    found.push({ kind: 'line', box });
  }
  [ll, ls, lc, ul, uk, hk, vk, hl, vl, grid, dk, bin, faint].forEach((m) => m.delete());

  found.pairs = pairs;
  // reading order: top to bottom, then left to right (rows within ~18 px)
  found.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) < 18 ? a.box[0] - b.box[0] : a.box[1] - b.box[1]));
  return found;
}

// Ticks often run through a bracket and hide its shape. Take the clean "[" brackets found anywhere in the document,
// average them into a pattern, and look for that pattern on every page.
function bracketPattern(samples) {
  if (samples.length < 2) return null;
  const hs = samples.map((s) => s.box[3]).sort((a, b) => a - b), h = hs[hs.length >> 1];
  const w = Math.max(8, Math.round(h * 0.42)) + 4, acc = new Float32Array(w * (h + 4));
  let k = 0;
  for (const s of samples.slice(0, 60)) {
    const [x, y] = s.box; if (x < 2 || y < 2 || x + w > s.gray.cols || y + h + 2 > s.gray.rows) continue;
    const roi = s.gray.roi(new cv.Rect(x - 2, y - 2, w, h + 4)), sz = new cv.Mat(); cv.resize(roi, sz, new cv.Size(w, h + 4)); roi.delete();
    for (let i = 0; i < acc.length; i++) acc[i] += sz.data[i]; sz.delete(); k++;
  }
  if (k < 2) return null;
  const t = new cv.Mat(h + 4, w, cv.CV_8U); for (let i = 0; i < acc.length; i++) t.data[i] = Math.round(acc[i] / k);
  return { mat: t, h, w };
}
function recoverBrackets(gray, found, pat, bw) {
  // a box needs both a "[" and a mirrored "]" one box-width to its right
  const flip = new cv.Mat(); cv.flip(pat.mat, flip, 1);
  const resL = new cv.Mat(), resR = new cv.Mat();
  cv.matchTemplate(gray, pat.mat, resL, cv.TM_CCOEFF_NORMED);
  cv.matchTemplate(gray, flip, resR, cv.TM_CCOEFF_NORMED); flip.delete();
  const added = [], dx = bw - pat.w + 4;
  const rAt = (x, y) => {
    let best = -1;
    for (let yy = y - 3; yy <= y + 3; yy++) for (let xx = x - 4; xx <= x + 4; xx++) {
      if (yy < 0 || xx < 0 || yy >= resR.rows || xx >= resR.cols) continue;
      best = Math.max(best, resR.floatAt(yy, xx));
    }
    return best;
  };
  for (let n = 0; n < 200; n++) {
    const m = cv.minMaxLoc(resL); if (m.maxVal < 0.72) break;
    const lx = m.maxLoc.x, ly = m.maxLoc.y;
    cv.rectangle(resL, new cv.Point(Math.max(0, lx - 12), Math.max(0, ly - 12)), new cv.Point(lx + 12, ly + 12), new cv.Scalar(-1), -1);
    if (rAt(lx + dx, ly) < 0.6) continue;
    const box = [lx + 2, ly + 2, bw, pat.h];
    // a printed box starts a phrase: the strip left of it is blank (letters inside words fail this)
    if (box[0] < 14) continue;
    let ink = 0;
    for (let yy = box[1] + 3; yy < box[1] + box[3] - 3; yy++) for (let xx = box[0] - 12; xx < box[0] - 3; xx++) if (gray.ucharPtr(yy, xx)[0] < 140) ink++;
    if (ink > 4) continue;
    const near = (f) => Math.abs(f.box[1] + f.box[3] / 2 - (box[1] + box[3] / 2)) < box[3] && Math.abs(f.box[0] + f.box[2] / 2 - (box[0] + box[2] / 2)) < bw * 1.8;
    if (found.some(near) || added.some(near)) continue;
    added.push({ kind: 'checkbox', shape: 'bracket', box, guessed: true });
  }
  resL.delete(); resR.delete();
  return added;
}

/* ---------- AI naming ---------- */
const LABEL_SCHEMA = { type: 'object', properties: { fields: { type: 'array', items: { type: 'object', properties: {
  n: { type: 'integer' }, kind: { type: 'string', enum: ['checkbox', 'number', 'text', 'ignore'] },
  question: { type: 'string' }, option: { type: 'string' }, single: { type: 'boolean' } },
  required: ['n', 'kind', 'question', 'option', 'single'] } } }, required: ['fields'] };

function overlayImage(page, fields) {
  const s = 0.62, c = document.createElement('canvas');
  c.width = Math.round(page.w * s); c.height = Math.round(page.h * s);
  const x = c.getContext('2d'); x.drawImage(page.img, 0, 0, c.width, c.height);
  x.lineWidth = 2; x.font = 'bold 15px Arial'; x.textBaseline = 'top';
  for (const f of fields) {
    const [bx, by, bw, bh] = f.box.map((v) => v * s);
    x.strokeStyle = '#E0261B'; x.strokeRect(bx, by, bw, bh);
    const t = String(f.n), tw = x.measureText(t).width + 6;
    x.fillStyle = '#FFE500'; x.fillRect(bx - tw - 2, by - 1, tw, 18);
    x.fillStyle = '#000'; x.fillText(t, bx - tw + 1, by + 1);
  }
  return c.toDataURL('image/png');
}
function labelPrompt() {
  return `These images are the pages of a BLANK survey form, in order (image 1 is page 1). Red boxes with a yellow number mark places where a respondent answers: tick boxes, write-in lines and empty table cells.
For EVERY number return one entry:
- kind: "checkbox" for a tick box that selects an option; "number" when a count or number is written there; "text" when words, a name or a date are written; "ignore" when it is not an answer area.
- question: the question or field it belongs to, in plain words, at most 8 words. Use exactly the same text for every option of one question. For a table cell use "<row label>: <column heading>", e.g. "Smartphones: active count".
- option: for a checkbox, the option text printed next to it (short); otherwise "".
- single: true when the question expects only one ticked option; otherwise false.`;
}
async function aiLabel(prog) {
  const h = await helperHealth();
  if (!h.ok || !h.engines || !h.engines[settings.reader]) throw new Error('the AI helper is not running (see step 3 on the main page)');
  const imgs = B.pages.map((p, i) => overlayImage(p, B.fields.filter((f) => f.page === i + 1)));
  prog(`Asking ${settings.reader === 'gemini' ? 'Gemini' : 'Claude'} to name ${B.fields.length} boxes on ${imgs.length} page(s)…`);
  const r = await fetch(settings.helperUrl + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: settings.reader, model: settings.models[settings.reader] || '', images: imgs, prompt: labelPrompt(), schema: LABEL_SCHEMA }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `helper error ${r.status}`);
  let named = 0;
  for (const e of j.fields || []) {
    const f = B.fields.find((x) => x.n === e.n); if (!f) continue;
    f.kind = e.kind; f.question = e.question || ''; f.option = e.option || ''; f.single = !!e.single; named++;
  }
  return named;
}

/* ---------- build the template ---------- */
const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';
function cbZones(b) {
  const [x, y, w, h] = b.map(Math.round);
  return { box: [x - 8, y - 22, w + 16, h + 44], inner: [x + 4, y + 3, Math.max(4, w - 8), Math.max(4, h - 6)], gap: [x + w + 2, y - 2, 10, h + 4],
    above: [x - 8, y - h - 8, w + 70, h + 4], anchor: [x - 55, y - 26, 420, h + 52], line: [x - 15, y - 28, 560, h + 56] };
}
// The sample PDF is often a filled-in copy. Processing treats anything on the reference as printed and subtracts it,
// so the sample's own handwriting would hide the answers on every scan. Blank the answer areas, keeping ruled lines.
function cleanRef(p, fields) {
  const c = document.createElement('canvas'); c.width = p.w; c.height = p.h;
  const ctx = c.getContext('2d'); ctx.drawImage(p.img, 0, 0, p.w, p.h);
  const id = ctx.getImageData(0, 0, p.w, p.h), d = id.data;
  const white = (x0, y0, w, h, keepRules) => {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    const x1 = Math.min(p.w, Math.round(x0 + w)), y1 = Math.min(p.h, Math.round(y0 + h));
    for (let y = y0; y < y1; y++) {
      if (keepRules) {
        let dark = 0; for (let x = x0; x < x1; x++) if (d[(y * p.w + x) * 4] < 150) dark++;
        if (dark > (x1 - x0) * 0.6) continue;   // a printed rule or underline
      }
      for (let x = x0; x < x1; x++) { const k = (y * p.w + x) * 4; d[k] = d[k + 1] = d[k + 2] = 255; }
    }
  };
  for (const f of fields) {
    if (f.kind === 'ignore') continue;
    if (f.kind === 'checkbox') { const [x, y, w, h] = cbZones(f.box).inner; white(x, y, w, h, false); }
    else white(f.box[0], f.box[1], f.box[2], f.box[3], true);
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/jpeg', 0.9);
}

function buildTemplate(name) {
  const used = new Set(), uid = (base) => { let id = slug(base), k = 2; while (used.has(id)) id = `${slug(base)}_${k++}`; used.add(id); return id; };
  const questions = [], textFields = [], groups = new Map();
  for (const f of B.fields) {
    if (f.kind === 'ignore') continue;
    if (f.kind === 'checkbox') {
      const key = `${f.page}|${(f.question || 'Question').trim().toLowerCase()}`;
      if (!groups.has(key)) { const q = { id: uid(f.question || `p${f.page}_question`), label: f.question || `Page ${f.page} question`, kind: 'single', page: f.page, options: [] }; groups.set(key, q); questions.push(q); }
      const q = groups.get(key); if (!f.single || !f.question) q.kind = 'multi';
      q.options.push({ value: f.option || `Option ${q.options.length + 1}`, ...cbZones(f.box) });
    } else {
      const [x, y, w, h] = f.box.map(Math.round);
      textFields.push({ id: uid(f.question || `p${f.page}_field_${f.n}`), label: f.question || `Page ${f.page} field ${f.n}`, kind: f.kind === 'number' ? 'count' : 'text',
        page: f.page, box: [x, y, w, h], anchor: [x - 120, y - 24, w + 240, h + 48] });
    }
  }
  // a question with a single option is a yes/no tick: keep it multi so "ticked" shows as 1/0
  for (const q of questions) if (q.options.length === 1) q.kind = 'multi';
  return { id: B.editingId || `form-${Date.now().toString(36)}`, name, short: slug(name).slice(0, 24), refWidth: CFG.refWidth, custom: true,
    created: new Date().toISOString(), pages: B.pages.map((p, i) => ({ n: i + 1, ref: cleanRef(p, B.fields.filter((f) => f.page === i + 1)), source: p.url })), textFields, questions,
    builder: { fields: B.fields.map(({ n, page, kind, question, option, single, box }) => ({ n, page, kind, question, option, single, box })) } };
}

/* ---------- editor ---------- */
const KIND_COLOR = { checkbox: '#2F5FD0', number: '#22744A', text: '#7A3FB8', ignore: '#9AA3B2', cell: '#22744A', line: '#7A3FB8' };
function drawPage() {
  const p = B.pages[B.page], c = $('bCanvas'); if (!p) return;
  const maxW = Math.min(780, c.parentElement.clientWidth || 780), s = maxW / p.w;
  c.width = Math.round(p.w * s); c.height = Math.round(p.h * s); B.scale = s;
  const x = c.getContext('2d'); x.drawImage(p.img, 0, 0, c.width, c.height);
  x.font = '600 11px "Public Sans", Arial'; x.textBaseline = 'bottom';
  for (const f of B.fields.filter((f) => f.page === B.page + 1)) {
    const [bx, by, bw, bh] = f.box.map((v) => v * s), col = KIND_COLOR[f.kind] || '#2F5FD0';
    x.setLineDash(f.kind === 'ignore' ? [4, 3] : []); x.lineWidth = f === B.sel ? 3 : 1.6; x.strokeStyle = col; x.strokeRect(bx, by, bw, bh);
    x.setLineDash([]); x.fillStyle = col; x.fillText(String(f.n), bx, by - 1);
  }
  if (B.drag && B.drag.cur) { const d = B.drag; x.strokeStyle = '#C7352B'; x.lineWidth = 2; x.strokeRect(Math.min(d.x0, d.cur.x), Math.min(d.y0, d.cur.y), Math.abs(d.cur.x - d.x0), Math.abs(d.cur.y - d.y0)); }
}
function renderList() {
  const fs = B.fields.filter((f) => f.page === B.page + 1);
  $('bList').innerHTML = fs.map((f) => `
    <div class="bf ${f === B.sel ? 'sel' : ''} k-${f.kind}" data-n="${f.n}">
      <div class="bfhead"><b>${f.n}</b>
        <select data-k="kind">${['checkbox', 'number', 'text', 'ignore'].map((k) => `<option${k === f.kind ? ' selected' : ''}>${k}</option>`).join('')}</select>
        <button class="btn small quiet" data-k="del" title="Delete this box">Delete</button></div>
      <input data-k="question" placeholder="${f.kind === 'checkbox' ? 'Question, same for all its options' : 'Field name'}" value="${esc(f.question || '')}">
      ${f.kind === 'checkbox' ? `<input data-k="option" placeholder="Option text" value="${esc(f.option || '')}">
      <label class="inline"><input type="checkbox" data-k="single"${f.single ? ' checked' : ''}> Only one option can be ticked</label>` : ''}
    </div>`).join('') || '<p class="hint">No boxes on this page. Tick "Draw a missing box" to add one.</p>';
  const counts = { checkbox: 0, number: 0, text: 0, ignore: 0 }; for (const f of B.fields) counts[f.kind] = (counts[f.kind] || 0) + 1;
  $('bStats').textContent = `${counts.checkbox} checkboxes, ${counts.number} number fields, ${counts.text} text fields, ${counts.ignore} ignored`;
  $('bPages').innerHTML = B.pages.map((_, i) => `<button class="tab${i === B.page ? ' on' : ''}" data-p="${i}">Page ${i + 1}</button>`).join('');
}
function select(f) {
  B.sel = f; drawPage(); renderList();
  const el = f && [...$('bList').children].find((d) => +d.dataset.n === f.n); if (el) el.scrollIntoView({ block: 'nearest' });
}
function canvasPt(ev) { const r = $('bCanvas').getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }

/* ---------- flow ---------- */
async function startFromPdf(file) {
  const prog = (t) => { $('bProgress').textContent = t; };
  const name = $('bName').value.trim() || file.name.replace(/\.pdf$/i, '');
  $('bName').value = name;
  try {
    prog('Reading the PDF…');
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    if (pdf.numPages > 20) throw new Error('that PDF has more than 20 pages; upload one blank copy of the form');
    B.pages = []; B.fields = []; B.page = 0; B.sel = null; B.editingId = null;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      prog(`Finding answer boxes on page ${i} of ${pdf.numPages}…`); await sleep(0);
      const canvas = await renderPage(pdf, i, CFG.refWidth);
      const rgba = cv.imread(canvas), g0 = new cv.Mat(); cv.cvtColor(rgba, g0, cv.COLOR_RGBA2GRAY); rgba.delete(); canvas.width = canvas.height = 0;
      const gray = deskew(g0); g0.delete();
      pages.push({ gray, found: detectPage(gray) });
    }
    // second pass: find ticked brackets using the clean ones as a pattern
    const samples = pages.flatMap((p) => (p.found.pairs || []).map((box) => ({ box, gray: p.gray })));
    const pat = bracketPattern(samples);
    if (pat) {
      const bws = samples.map((x) => x.box[2]).sort((a, b) => a - b), bw = bws[bws.length >> 1];
      for (const p of pages) {
        const cells = p.found.filter((f) => f.kind === 'cell');
        const extra = recoverBrackets(p.gray, p.found, pat, bw).filter((e) => !cells.some((c) => overlapFrac(e.box, c.box) > 0.3));
        p.found.push(...extra);
        p.found.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) < 18 ? a.box[0] - b.box[0] : a.box[1] - b.box[1]));
      }
      pat.mat.delete();
    }
    // every printed option has its label to the right; boxes on scan borders don't
    for (const p of pages) {
      const g = p.gray;
      const inkIn = (x0, x1, y0, y1) => {
        let n = 0;
        for (let yy = Math.max(0, y0); yy < Math.min(g.rows, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(g.cols, x1); xx++) if (g.ucharPtr(yy, xx)[0] < 140) n++;
        return n;
      };
      p.found = p.found.filter((f) => {
        const [x, y, w, h] = f.box;
        if (f.kind === 'checkbox') return inkIn(x + w + 3, x + w + 70, y + 2, y + h - 2) >= 25 || inkIn(x - 70, x - 3, y + 2, y + h - 2) >= 25;
        // a write-in line has its printed question on the same row, to its left or just above
        if (f.kind === 'line') return inkIn(x - 400, x - 4, y + h - 40, y + h) >= 40 || inkIn(x, x + w, y - 40, y + 4) >= 60;
        return true;
      });
    }
    for (let k = 0; k < pages.length; k++) {
      const i = k + 1, { gray, found } = pages[k];
      const url = matToDataURL(gray), img = await loadImage(url);
      B.pages.push({ url, img, w: gray.cols, h: gray.rows }); gray.delete();
      // row-label columns: the left columns where every row already has printed text
      const cells = found.filter((f) => f.kind === 'cell' && !f.header), labelCols = new Set();
      for (const c of new Set(cells.map((f) => `${f.table}|${f.col}`))) {
        const colCells = cells.filter((f) => `${f.table}|${f.col}` === c);
        if (colCells[0].col <= 1 && colCells.every((f) => f.inked)) labelCols.add(c);
      }
      const start = (f) => f.kind === 'checkbox' ? 'checkbox' : f.kind === 'cell' ? (f.header || labelCols.has(`${f.table}|${f.col}`) ? 'ignore' : 'text') : 'text';
      for (const f of found) B.fields.push({ n: B.fields.length + 1, page: i, kind: start(f), question: '', option: '', single: true, box: f.box });
    }
    pdf.destroy();
    if (!B.fields.length) prog('No answer boxes were found automatically. Draw them on each page.');
    else if ($('bUseAI').checked) {
      try { const k = await aiLabel(prog); prog(`Found ${B.fields.length} boxes; the AI named ${k}. Check them, then save.`); }
      catch (e) { prog(`Found ${B.fields.length} boxes, but they couldn't be named (${e.message}). Start the helper and click "Name with AI", or name them below.`); }
    } else prog(`Found ${B.fields.length} boxes. Name them below, then save.`);
    $('bEdit').hidden = false; drawPage(); renderList();
  } catch (e) { console.error(e); prog('Could not read that PDF: ' + e.message); }
  window.__builderDone = true;
}

async function saveForm() {
  const name = $('bName').value.trim();
  if (!name) { $('bName').focus(); $('bProgress').textContent = 'Give the form a name first.'; $('bStart').hidden = false; return; }
  const tpl = buildTemplate(name);
  if (!tpl.questions.length && !tpl.textFields.length) { alert('Every box is set to Ignore. Mark at least one box as checkbox, number or text.'); return; }
  await FormStore.put(tpl);
  await useForm(tpl.id);
  $('builder').close();
  setStatus('Ready', 'ok');
  window.__savedForm = tpl.id;
}

async function editForm(id) {
  const t = await FormStore.get(id); if (!t || !t.builder) return alert('This form cannot be edited here.');
  B.pages = []; for (const p of t.pages) { const src = p.source || p.ref, img = await loadImage(src); B.pages.push({ url: src, img, w: img.width, h: img.height }); }
  B.fields = t.builder.fields.map((f) => ({ ...f })); B.page = 0; B.sel = null; B.editingId = t.id;
  $('bName').value = t.name; $('bProgress').textContent = 'Editing a saved form.'; $('bEdit').hidden = false;
  $('builder').showModal(); drawPage(); renderList();
}

function wireBuilder() {
  $('btnFormNew').addEventListener('click', () => { B.editingId = null; $('bEdit').hidden = true; $('bProgress').textContent = ''; $('bName').value = ''; $('builder').showModal(); });
  $('bClose').addEventListener('click', () => $('builder').close());
  $('bFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) startFromPdf(f); });
  $('bSave').addEventListener('click', saveForm);
  $('bName2').addEventListener('click', async () => {
    const btn = $('bName2'), prog = (t) => { $('bProgress').textContent = t; };
    btn.disabled = true;
    try { const k = await aiLabel(prog); prog(`The AI named ${k} of ${B.fields.length} boxes. Check them, then save.`); drawPage(); renderList(); }
    catch (e) { prog(`Couldn't name the boxes: ${e.message}. Start the helper (step 3 on the main page), then click "Name with AI" again.`); }
    finally { btn.disabled = false; }
  });
  $('bPages').addEventListener('click', (e) => { const p = e.target.dataset.p; if (p !== undefined) { B.page = +p; B.sel = null; drawPage(); renderList(); } });
  $('bList').addEventListener('input', (e) => {
    const card = e.target.closest('.bf'); if (!card) return; const f = B.fields.find((x) => x.n === +card.dataset.n); const k = e.target.dataset.k;
    if (k === 'question' || k === 'option') f[k] = e.target.value;
  });
  $('bList').addEventListener('change', (e) => {
    const card = e.target.closest('.bf'); if (!card) return; const f = B.fields.find((x) => x.n === +card.dataset.n); const k = e.target.dataset.k;
    if (k === 'kind') { f.kind = e.target.value; select(f); } else if (k === 'single') f.single = e.target.checked;
  });
  $('bList').addEventListener('click', (e) => {
    const card = e.target.closest('.bf'); if (!card) return; const f = B.fields.find((x) => x.n === +card.dataset.n);
    if (e.target.dataset.k === 'del') { B.fields = B.fields.filter((x) => x !== f); B.sel = null; drawPage(); renderList(); }
    else if (!['INPUT', 'SELECT', 'OPTION'].includes(e.target.tagName)) select(f);
  });
  const c = $('bCanvas');
  c.addEventListener('mousedown', (e) => { if ($('bDraw').checked) { const p = canvasPt(e); B.drag = { x0: p.x, y0: p.y }; } });
  c.addEventListener('mousemove', (e) => { if (B.drag) { B.drag.cur = canvasPt(e); drawPage(); } });
  c.addEventListener('mouseup', (e) => {
    const p = canvasPt(e);
    if (B.drag) {
      const d = B.drag; B.drag = null; const s = B.scale;
      const box = [Math.min(d.x0, p.x) / s, Math.min(d.y0, p.y) / s, Math.abs(p.x - d.x0) / s, Math.abs(p.y - d.y0) / s].map(Math.round);
      if (box[2] > 8 && box[3] > 8) { const f = { n: Math.max(0, ...B.fields.map((x) => x.n)) + 1, page: B.page + 1, kind: 'text', question: '', option: '', single: true, box }; B.fields.push(f); select(f); }
      else drawPage();
      return;
    }
    const s = B.scale, hit = B.fields.filter((f) => f.page === B.page + 1 && p.x >= f.box[0] * s - 3 && p.x <= (f.box[0] + f.box[2]) * s + 3 && p.y >= f.box[1] * s - 3 && p.y <= (f.box[1] + f.box[3]) * s + 3)
      .sort((a, b) => a.box[2] * a.box[3] - b.box[2] * b.box[3])[0];
    select(hit || null);
  });
  $('btnFormEdit').addEventListener('click', () => editForm(S.formId));
  $('btnFormDelete').addEventListener('click', async () => {
    if (!confirm(`Delete the form "${S.tpl.name}" from this browser?`)) return;
    await FormStore.del(S.formId); await useForm(BUILTIN_FORMS[0].id);
  });
  $('btnFormExport').addEventListener('click', async () => {
    const t = { ...S.tpl, tallyForm: 1, pages: [] };
    for (const p of S.tpl.pages) {   // embed page images so the file is self-contained
      if (/^data:image\//.test(p.ref)) { t.pages.push(p); continue; }
      const img = await loadImage(p.ref), c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0); t.pages.push({ ...p, ref: c.toDataURL('image/jpeg', 0.9) });
    }
    download(`${(S.tpl.short || 'form')}-form.tally.json`, new Blob([JSON.stringify(t)], { type: 'application/json' }));
  });
  $('formImport').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    // a PDF here means "make a form from this blank PDF": open the builder with it
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      B.editingId = null; $('bEdit').hidden = true; $('bName').value = f.name.replace(/\.pdf$/i, '');
      $('builder').showModal(); startFromPdf(f); return;
    }
    try {
      const t = JSON.parse(await f.text());
      if (!Array.isArray(t.pages) || !Array.isArray(t.questions) || !Array.isArray(t.textFields)) throw new Error('this is not a Tally form file. To use a blank PDF, choose it here or click New form from a blank PDF');
      if (t.pages.some((p) => !/^data:image\//.test(p.ref || ''))) throw new Error('the form file is missing its page images');
      if (BUILTIN_FORMS.some((b) => b.id === t.id)) t.id = `${t.id}-imported`;
      t.custom = true; await FormStore.put(t); await useForm(t.id); setStatus('Ready', 'ok');
    } catch (err) { alert('Could not import that form: ' + err.message); }
  });
}
wireBuilder();
