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
    const type = left > 0.8 * h && right < 0.45 * h ? '[' : right > 0.8 * h && left < 0.45 * h ? ']' : null;
    if (type) comps.push({ type, x, y, w, h });
  }
  lab.delete(); st.delete(); cen.delete();
  const opens = comps.filter((c) => c.type === '['), closes = comps.filter((c) => c.type === ']');
  for (const o of opens) {
    const c = closes.filter((k) => k.x > o.x + o.w + 4 && k.x - (o.x + o.w) < 32 && Math.abs(k.y - o.y) < 7 && Math.abs(k.h - o.h) < 8)
      .sort((a, b) => a.x - b.x)[0];
    if (!c) continue;
    const box = [o.x, Math.min(o.y, c.y), c.x + c.w - o.x, Math.max(o.y + o.h, c.y + c.h) - Math.min(o.y, c.y)];
    if (inkCount(bin, [o.x + o.w + 1, box[1] + 3, c.x - o.x - o.w - 2, box[3] - 6]) > 12) continue;
    found.push({ kind: 'checkbox', shape: 'bracket', box });
  }

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
  const lineAt = (prof, thr) => { const out = []; let grp = []; prof.forEach((v, i) => { if (v > thr) { if (grp.length && i - grp[grp.length - 1] > 4) { out.push(grp); grp = []; } grp.push(i); } }); if (grp.length) out.push(grp); return out.map((g) => Math.round(g.reduce((a, b) => a + b, 0) / g.length)); };
  // tolerate rules that are a hair off straight: sum 3 neighbouring px, then take the max within ±3 px
  const tol = (p) => { const c = p.map((_, i) => (p[i - 1] || 0) + p[i] + (p[i + 1] || 0)); return c.map((_, i) => { let m = 0; for (let k = Math.max(0, i - 3); k <= Math.min(c.length - 1, i + 3); k++) m = Math.max(m, c[k]); return m; }); };
  for (const t of tables) {
    const [tx, ty, tw, th] = t, col = new Array(tw).fill(0), row = new Array(th).fill(0);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const o = (ty + y) * gw + tx + x, v = gd[o]; if (v < 250 && v >= 170 && !nd[o]) { col[x]++; row[y]++; } }
    const xs = lineAt(tol(col.map((v) => v / th)), 0.3), ys = lineAt(tol(row.map((v) => v / tw)), 0.3);
    for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
      const w = xs[i + 1] - xs[i], h = ys[j + 1] - ys[j];
      if (w < 45 || h < 28) continue;
      const cell = [tx + xs[i] + 5, ty + ys[j] + 5, w - 10, h - 10];
      if (inkCount(bin, cell) > 0.004 * cell[2] * cell[3]) continue;                // printed text: a heading or row label
      if (found.some((f) => overlapFrac(f.box, cell) > 0.3)) continue;
      found.push({ kind: 'cell', box: cell, table: t });
    }
  }
  near.delete();

  // 4) write-in lines (dark underlines outside tables)
  const ul = new cv.Mat(); const uk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(60, 1));
  cv.morphologyEx(bin, ul, cv.MORPH_OPEN, uk);
  const ll = new cv.Mat(), ls = new cv.Mat(), lc = new cv.Mat();
  const ln = cv.connectedComponentsWithStats(ul, ll, ls, lc, 8);
  for (let i = 1; i < ln; i++) {
    const x = ls.intAt(i, 0), y = ls.intAt(i, 1), w = ls.intAt(i, 2), h = ls.intAt(i, 3);
    if (h > 6 || w < 60 || w > W * 0.75) continue;
    if (tables.some((t) => x >= t[0] - 5 && x + w <= t[0] + t[2] + 5 && y >= t[1] - 5 && y <= t[1] + t[3] + 5)) continue;
    const box = [Math.max(0, x - 8), Math.max(0, y - 78), w + 16, 86];
    if (found.some((f) => overlapFrac(f.box, box) > 0.3)) continue;
    found.push({ kind: 'line', box });
  }
  [ll, ls, lc, ul, uk, hk, vk, hl, vl, grid, dk, bin, faint].forEach((m) => m.delete());

  // reading order: top to bottom, then left to right (rows within ~18 px)
  found.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) < 18 ? a.box[0] - b.box[0] : a.box[1] - b.box[1]));
  return found;
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
function buildTemplate(name) {
  const used = new Set(), uid = (base) => { let id = slug(base), k = 2; while (used.has(id)) id = `${slug(base)}_${k++}`; used.add(id); return id; };
  const questions = [], textFields = [], groups = new Map();
  for (const f of B.fields) {
    if (f.kind === 'ignore') continue;
    if (f.kind === 'checkbox') {
      const key = `${f.page}|${(f.question || 'Question').trim().toLowerCase()}`;
      if (!groups.has(key)) { const q = { id: uid(f.question || `p${f.page}_question`), label: f.question || `Page ${f.page} question`, kind: 'single', page: f.page, options: [] }; groups.set(key, q); questions.push(q); }
      const q = groups.get(key); if (!f.single) q.kind = 'multi';
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
    created: new Date().toISOString(), pages: B.pages.map((p, i) => ({ n: i + 1, ref: p.url })), textFields, questions,
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
    for (let i = 1; i <= pdf.numPages; i++) {
      prog(`Finding answer boxes on page ${i} of ${pdf.numPages}…`); await sleep(0);
      const canvas = await renderPage(pdf, i, CFG.refWidth);
      const rgba = cv.imread(canvas), g0 = new cv.Mat(); cv.cvtColor(rgba, g0, cv.COLOR_RGBA2GRAY); rgba.delete(); canvas.width = canvas.height = 0;
      const gray = deskew(g0); g0.delete();
      const found = detectPage(gray);
      const url = matToDataURL(gray), img = await loadImage(url);
      B.pages.push({ url, img, w: gray.cols, h: gray.rows }); gray.delete();
      for (const f of found) B.fields.push({ n: B.fields.length + 1, page: i, kind: f.kind === 'checkbox' ? 'checkbox' : f.kind === 'cell' ? 'number' : 'text', question: '', option: '', single: true, box: f.box });
    }
    pdf.destroy();
    if (!B.fields.length) prog('No answer boxes were found automatically. Draw them on each page.');
    else if ($('bUseAI').checked) {
      try { const k = await aiLabel(prog); prog(`Found ${B.fields.length} boxes; the AI named ${k}. Check them, then save.`); }
      catch (e) { prog(`Found ${B.fields.length} boxes, but they couldn't be named automatically (${e.message}). Name them below.`); }
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
  B.pages = []; for (const p of t.pages) { const img = await loadImage(p.ref); B.pages.push({ url: p.ref, img, w: img.width, h: img.height }); }
  B.fields = t.builder.fields.map((f) => ({ ...f })); B.page = 0; B.sel = null; B.editingId = t.id;
  $('bName').value = t.name; $('bProgress').textContent = 'Editing a saved form.'; $('bEdit').hidden = false;
  $('builder').showModal(); drawPage(); renderList();
}

function wireBuilder() {
  $('btnFormNew').addEventListener('click', () => { B.editingId = null; $('bEdit').hidden = true; $('bProgress').textContent = ''; $('bName').value = ''; $('builder').showModal(); });
  $('bClose').addEventListener('click', () => $('builder').close());
  $('bFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) startFromPdf(f); });
  $('bSave').addEventListener('click', saveForm);
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
