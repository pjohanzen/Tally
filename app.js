/* E-WACS Survey Encoder — runs fully in the browser.
 * Pipeline per PDF page: render (pdf.js) -> identify form page + align to template (OpenCV ORB + homography)
 * -> per-field local alignment (matchTemplate) -> checkboxes by ink count -> handwriting crops for the AI sheets.
 */
'use strict';

const CFG = {
  template: 'templates/ewacs-v1.json',
  orbFeatures: 3000,
  alignScale: 0.5,          // ORB runs on a half-size image
  acceptInliers: 300,       // accept the expected page without trying the others
  minInliers: 60,           // below this the page is "not recognised"
  searchPad: 45,            // px (full res) for local field alignment
  minAnchorScore: 0.35,
  inkLevel: 150,            // gray < inkLevel counts as ink (handwriting fields)
  tickInk: 200,             // lighter threshold for checkboxes: faint pen ticks still count
  chkOn: 25,                // extra ink over a blank box -> ticked
  chkUnsure: 12,            // between unsure and on -> ask the AI
  blankInk: { count: 10, text: 15 }, // handwriting pixels below this = blank (blank cells measure ~0)
  cropScale: 0.6,           // crops on the sheet (200 dpi * 0.6 = 120 dpi)
  sheetW: 1150, sheetMaxH: 1150, labelW: 78,
};

const S = { tpl: null, refs: [], files: [], surveys: [], items: {}, nextId: 1, ready: false, debug: /[?&]debug=1/.test(location.search) };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// yield to the browser without setTimeout, which Chrome throttles hard in background tabs
const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

/* ---------------- boot ---------------- */
async function boot() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  if (S.debug) $('debug').hidden = false;
  try {
    while (!(window.cv && cv.Mat)) await sleep(100);
    S.tpl = await (await fetch(CFG.template)).json();
    for (const p of S.tpl.pages) S.refs.push(await loadRef(p));
    S.ready = true;
    setStatus(`Ready · template: ${S.tpl.name}`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Could not load the tools: ' + e.message + ' (open the page through GitHub Pages or a local web server, not by double-clicking the file)', 'err');
  }
  updateButtons();
  renderAll();
}
function setStatus(t, cls) { const el = $('libstatus'); el.textContent = t; el.className = 'pill ' + (cls || ''); }

async function loadRef(p) {
  const img = await loadImage(p.ref);
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  const rgba = cv.imread(c); const gray = new cv.Mat(); cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY); rgba.delete();
  const small = new cv.Mat(); cv.resize(gray, small, new cv.Size(0, 0), CFG.alignScale, CFG.alignScale, cv.INTER_AREA);
  const { kp, des } = orbDetect(small);
  const bin = binarize(gray);
  return { n: p.n, gray, small, bin, kp, des, w: gray.cols, h: gray.rows };
}
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('cannot load ' + src)); i.src = src; }); }

/* ---------------- OpenCV helpers ---------------- */
function orbDetect(img) {
  const orb = new cv.ORB(CFG.orbFeatures); const kp = new cv.KeyPointVector(); const des = new cv.Mat(); const mask = new cv.Mat();
  orb.detectAndCompute(img, mask, kp, des); orb.delete(); mask.delete();
  return { kp, des };
}
function binarize(gray) { const b = new cv.Mat(); cv.threshold(gray, b, CFG.inkLevel, 255, cv.THRESH_BINARY_INV); return b; }

function homographyTo(ref, kp, des) {
  if (des.rows < 10 || ref.des.rows < 10) return { inliers: 0 };
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false); const mm = new cv.DMatchVectorVector();
  bf.knnMatch(des, ref.des, mm, 2);
  const src = [], dst = [];
  for (let i = 0; i < mm.size(); i++) {
    const m = mm.get(i); if (m.size() < 2) continue;
    const a = m.get(0), b = m.get(1);
    if (a.distance < 0.75 * b.distance) {
      const p = kp.get(a.queryIdx).pt, q = ref.kp.get(a.trainIdx).pt; src.push(p.x, p.y); dst.push(q.x, q.y);
    }
  }
  bf.delete(); mm.delete();
  const n = src.length / 2; if (n < 12) return { inliers: 0 };
  const sm = cv.matFromArray(n, 1, cv.CV_32FC2, src), dm = cv.matFromArray(n, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
  const H = cv.findHomography(sm, dm, cv.RANSAC, 4.0, mask);
  const inliers = H.empty() ? 0 : cv.countNonZero(mask);
  sm.delete(); dm.delete(); mask.delete();
  if (!inliers) { H.delete(); return { inliers: 0 }; }
  return { inliers, H };
}
// homography found on half-size images -> full size
function scaleH(H, s) {
  const h = H.data64F, k = 1 / s;
  const a = [h[0], h[1], h[2] * k, h[3], h[4], h[5] * k, h[6] * s, h[7] * s, h[8]];
  return cv.matFromArray(3, 3, cv.CV_64F, a);
}

function clampRect(r, w, h) {
  const x = Math.max(0, Math.round(r[0])), y = Math.max(0, Math.round(r[1]));
  const x2 = Math.min(w, Math.round(r[0] + r[2])), y2 = Math.min(h, Math.round(r[1] + r[3]));
  return new cv.Rect(x, y, Math.max(1, x2 - x), Math.max(1, y2 - y));
}
function localOffset(ref, warpedSmall, anchor) {
  const s = CFG.alignScale, pad = CFG.searchPad * s;
  const a = clampRect(anchor.map((v) => v * s), ref.small.cols, ref.small.rows);
  const sr = clampRect([a.x - pad, a.y - pad, a.width + 2 * pad, a.height + 2 * pad], warpedSmall.cols, warpedSmall.rows);
  if (sr.width <= a.width || sr.height <= a.height) return { dx: 0, dy: 0, score: 0 };
  const templ = ref.small.roi(a), img = warpedSmall.roi(sr), res = new cv.Mat();
  cv.matchTemplate(img, templ, res, cv.TM_CCOEFF_NORMED);
  const mm = cv.minMaxLoc(res);
  templ.delete(); img.delete(); res.delete();
  if (!(mm.maxVal >= CFG.minAnchorScore)) return { dx: 0, dy: 0, score: mm.maxVal || 0 };
  return { dx: (sr.x + mm.maxLoc.x - a.x) / s, dy: (sr.y + mm.maxLoc.y - a.y) / s, score: mm.maxVal };
}
function shift(box, o) { return [box[0] + o.dx, box[1] + o.dy, box[2], box[3]]; }

/* ---------------- PDF processing ---------------- */
async function renderPage(pdf, i) {
  const page = await pdf.getPage(i);
  const vp0 = page.getViewport({ scale: 1 });
  const scale = S.tpl.refWidth / Math.min(vp0.width, vp0.height);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return c;
}

async function processFile(f) {
  f.status = 'reading…'; renderFiles();
  const buf = await f.file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let survey = null, last = 0, count = 0;
  const unknown = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    f.status = `page ${i}/${pdf.numPages}`; renderFiles(); await tick();
    const canvas = await renderPage(pdf, i);
    const res = analysePage(canvas, last + 1 <= S.refs.length ? last + 1 : 1);
    canvas.width = canvas.height = 0;
    if (!res) { unknown.push(i); continue; }
    if (!survey || res.n <= last || survey.pages[res.n]) {
      survey = newSurvey(f, ++count); S.surveys.push(survey);
    }
    survey.pages[res.n] = i; last = res.n;
    absorbPage(survey, res);
  }
  pdf.destroy();
  const mine = S.surveys.filter((s) => s.fileKey === f.key);
  for (const s of mine) finishSurvey(s);
  if (unknown.length) {
    const tgt = mine[0];
    if (tgt) tgt.flags.push(`Page(s) ${unknown.join(', ')} of the PDF did not match the form`);
  }
  const real = mine.filter((s) => !s.blank).length, blank = mine.length - real;
  f.status = `${real} survey${real === 1 ? '' : 's'}` + (blank ? ` · ${blank} blank skipped` : '') + (unknown.length ? ` · ${unknown.length} page(s) not recognised` : '');
  f.cls = unknown.length || mine.some((s) => !s.blank && s.flags.length) ? 'warn' : 'ok';
  f.done = true;
}

function newSurvey(f, idx) {
  return { key: `${f.key}#${idx}`, file: f.name, fileKey: f.key, idx, pages: {}, answers: {}, fields: {}, flags: [], blank: false };
}

function analysePage(canvas, expected) {
  const rgba = cv.imread(canvas), gray = new cv.Mat(); cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY); rgba.delete();
  const small = new cv.Mat(); cv.resize(gray, small, new cv.Size(0, 0), CFG.alignScale, CFG.alignScale, cv.INTER_AREA);
  const { kp, des } = orbDetect(small); small.delete();
  // try the expected page first, then the rest
  const order = [expected, ...S.refs.map((r) => r.n).filter((n) => n !== expected)];
  let best = { inliers: 0 };
  for (const n of order) {
    const ref = S.refs[n - 1]; const h = homographyTo(ref, kp, des);
    if (h.inliers > best.inliers) { if (best.H) best.H.delete(); best = { ...h, ref }; } else if (h.H) h.H.delete();
    if (n === expected && best.inliers >= CFG.acceptInliers) break;
  }
  kp.delete(); des.delete();
  if (best.inliers < CFG.minInliers) { if (best.H) best.H.delete(); gray.delete(); return null; }
  const ref = best.ref, Hs = scaleH(best.H, CFG.alignScale); best.H.delete();
  const warped = new cv.Mat();
  cv.warpPerspective(gray, warped, Hs, new cv.Size(ref.w, ref.h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));
  gray.delete(); Hs.delete();
  const wSmall = new cv.Mat(); cv.resize(warped, wSmall, new cv.Size(0, 0), CFG.alignScale, CFG.alignScale, cv.INTER_AREA);
  const wBin = binarize(warped);
  const wTick = new cv.Mat(); cv.threshold(warped, wTick, CFG.tickInk, 255, cv.THRESH_BINARY_INV);
  const out = { n: ref.n, inliers: best.inliers, checks: [], fields: [] };
  const dbg = S.debug ? [] : null;

  // checkboxes
  const qs = S.tpl.questions.filter((q) => q.page === ref.n);
  const all = [];
  for (const q of qs) for (const o of q.options) {
    const off = localOffset(ref, wSmall, o.anchor);
    // three zones that are always empty on a blank form: inside the brackets, the gap after ']', and the strip above the text
    const inner = inkIn(wTick, shift(o.inner, off)) + inkIn(wTick, shift(o.gap, off)), above = inkIn(wTick, shift(o.above, off));
    all.push({ q, o, off, inner, above });
  }
  // a blank "[ ]" looks the same everywhere, so the page median is the blank baseline
  const bIn = median(all.map((a) => a.inner)), bAb = median(all.map((a) => a.above));
  for (const a of all) {
    const delta = (a.inner - bIn) + (a.above - bAb);
    const state = delta >= CFG.chkOn ? 'on' : delta >= CFG.chkUnsure ? 'unsure' : 'off';
    const c = { qid: a.q.id, value: a.o.value, delta, state };
    if (state === 'unsure') c.crop = cropCanvas(warped, shift(a.o.line, a.off), false);
    out.checks.push(c);
    if (S.debug) (S.debugChecks = S.debugChecks || []).push([ref.n, a.q.id, a.o.value, a.inner, a.above, delta, Math.round(a.off.dx), Math.round(a.off.dy), +a.off.score.toFixed(2)]);
    if (dbg) dbg.push({ box: shift(a.o.box, a.off), color: state === 'on' ? '#0a0' : state === 'unsure' ? '#f90' : '#c00' });
  }

  // handwriting fields
  for (const f of S.tpl.textFields.filter((t) => t.page === ref.n)) {
    const off = localOffset(ref, wSmall, f.anchor);
    const r = clampRect(shift(f.box, off), warped.cols, warped.rows);
    const rr = clampRect(f.box, ref.w, ref.h);
    const w = Math.min(r.width, rr.width), h = Math.min(r.height, rr.height);
    const sRoi = wBin.roi(new cv.Rect(r.x, r.y, w, h)), refRoi = ref.bin.roi(new cv.Rect(rr.x, rr.y, w, h));
    const refDil = new cv.Mat(); const k = cv.Mat.ones(7, 7, cv.CV_8U); cv.dilate(refRoi, refDil, k);
    const hw = new cv.Mat(); cv.subtract(sRoi, refDil, hw);
    const clean = new cv.Mat(); const k2 = cv.Mat.ones(2, 2, cv.CV_8U); cv.morphologyEx(hw, clean, cv.MORPH_OPEN, k2);
    const ink = cv.countNonZero(clean);
    let crop = null;
    const blank = ink < (CFG.blankInk[f.kind] || CFG.blankInk.text);
    if (!blank) {
      const bb = inkBounds(clean);
      const padX = 14, padY = 12;
      crop = cropCanvas(warped, [r.x + bb.x - padX, r.y + bb.y - padY, bb.width + 2 * padX, bb.height + 2 * padY], true);
    }
    [sRoi, refRoi, refDil, k, hw, clean, k2].forEach((m) => m.delete());
    out.fields.push({ id: f.id, kind: f.kind, blank, ink, crop });
    if (S.debug) (S.debugFields = S.debugFields || []).push([ref.n, f.id, ink]);
    if (dbg) dbg.push({ box: shift(f.box, off), color: blank ? '#88a' : '#00f' });
  }
  if (dbg) S.debugPages.push(debugImage(warped, dbg, ref.n));
  warped.delete(); wSmall.delete(); wBin.delete(); wTick.delete();
  return out;
}

function inkBounds(m) {
  const d = m.data, w = m.cols, h = m.rows, step = m.step[0];
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[y * step + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? { x: 0, y: 0, width: w, height: h } : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
function inkIn(bin, box) { const r = clampRect(box, bin.cols, bin.rows); const roi = bin.roi(r); const n = cv.countNonZero(roi); roi.delete(); return n; }
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function cropCanvas(mat, box, scaleDown) {
  const r = clampRect(box, mat.cols, mat.rows);
  const roi = mat.roi(r); const out = new cv.Mat();
  const s = scaleDown ? CFG.cropScale : CFG.cropScale * 0.85;
  cv.resize(roi, out, new cv.Size(0, 0), s, s, cv.INTER_AREA); roi.delete();
  const c = document.createElement('canvas'); cv.imshow(c, out); out.delete();
  return c.toDataURL('image/jpeg', 0.85);
}
function debugImage(mat, boxes, n) {
  const c = document.createElement('canvas'); cv.imshow(c, mat); const ctx = c.getContext('2d'); ctx.lineWidth = 4;
  for (const b of boxes) { ctx.strokeStyle = b.color; ctx.strokeRect(b.box[0], b.box[1], b.box[2], b.box[3]); }
  ctx.fillStyle = '#c00'; ctx.font = 'bold 60px sans-serif'; ctx.fillText('P' + n, 20, 70);
  const s = document.createElement('canvas'); s.width = c.width / 3; s.height = c.height / 3;
  s.getContext('2d').drawImage(c, 0, 0, s.width, s.height); return s.toDataURL('image/jpeg', 0.7);
}

/* ---------------- survey assembly ---------------- */
function newItem(survey, fieldId, kind, crop, extra) {
  const suffix = kind === 'count' ? 'n' : kind === 'check' ? 'c' : 't';
  const id = `${S.nextId++}${suffix}`;
  S.items[id] = { id, survey: survey.key, field: fieldId, kind, crop, value: null, ...extra };
  return id;
}
function absorbPage(survey, res) {
  for (const c of res.checks) {
    const a = survey.answers[c.qid] || (survey.answers[c.qid] = { on: [], unsure: {} });
    if (c.state === 'on') a.on.push(c.value);
    else if (c.state === 'unsure') a.unsure[c.value] = newItem(survey, c.qid, 'check', c.crop, { option: c.value });
  }
  for (const f of res.fields) {
    survey.fields[f.id] = f.blank ? { blank: true } : { item: newItem(survey, f.id, f.kind, f.crop) };
  }
}
function finishSurvey(s) {
  const nPages = S.tpl.pages.length;
  const missing = []; for (let n = 1; n <= nPages; n++) if (!s.pages[n]) missing.push(n);
  if (missing.length) s.flags.push(`Missing form page(s): ${missing.join(', ')}`);
  const anyCheck = Object.values(s.answers).some((a) => a.on.length || Object.keys(a.unsure).length);
  const anyText = Object.values(s.fields).some((f) => f.item);
  s.blank = !anyCheck && !anyText;
  if (s.blank) for (const id of Object.keys(S.items)) if (S.items[id].survey === s.key) delete S.items[id];
}

/* ---------------- values ---------------- */
function itemValue(it) {
  if (!it || it.value === null || it.value === undefined) return { v: 'PENDING', bad: false, pending: true };
  let v = String(it.value).trim();
  if (it.kind === 'count') {
    if (/^[-–—_~=]+$/.test(v) || /^(none|wala|zero)$/i.test(v)) v = '0';
    if (v === '') return { v: '', bad: false };
    if (/^\d+$/.test(v)) return { v: Number(v), bad: false };
    return { v, bad: true, why: v === '?' ? 'AI could not read it' : 'not a whole number' };
  }
  if (it.kind === 'check') return { v: /^(x|✓|✔|yes|checked|ticked|marked|1)$/i.test(v), bad: v === '?', why: 'AI unsure if ticked' };
  return { v, bad: v === '?' || /\?$/.test(v), why: 'AI could not read it' };
}
function checksFor(s, q) {
  const a = s.answers[q.id] || { on: [], unsure: {} };
  const on = [...a.on]; let pending = false;
  for (const [opt, id] of Object.entries(a.unsure)) {
    const r = itemValue(S.items[id]); if (r.pending) pending = true; else if (r.v === true) on.push(opt);
  }
  return { on: q.options.map((o) => o.value).filter((v) => on.includes(v)), pending };
}
function fieldVal(s, id) {
  const f = s.fields[id]; if (!f) return { v: '', missing: true };
  if (f.blank) return { v: '' };
  return itemValue(S.items[f.item]);
}

function buildRows() {
  const T = S.tpl, resp = [], dev = [], review = [];
  const devFields = T.textFields.filter((f) => f.group === 'devices');
  const devKeys = [...new Set(devFields.map((f) => f.device))];
  for (const s of S.surveys.filter((x) => !x.blank)) {
    const rid = `${s.file.replace(/\.pdf$/i, '')}${S.surveys.filter((x) => x.fileKey === s.fileKey && !x.blank).length > 1 ? '#' + s.idx : ''}`;
    const row = { respondent_id: rid, file: s.file, survey_in_file: s.idx };
    const notes = [...s.flags];
    for (const f of T.textFields.filter((f) => !f.group)) {
      const r = fieldVal(s, f.id); row[f.id] = r.v;
      if (r.bad) notes.push(`${f.label}: ${r.why}`);
    }
    for (const q of T.questions) {
      const c = checksFor(s, q);
      if (q.kind === 'single') {
        row[q.id] = c.pending && !c.on.length ? 'PENDING' : c.on.join('; ');
        if (c.on.length > 1) notes.push(`${q.label}: more than one box ticked`);
      } else {
        row[q.id] = c.on.join('; ');
        q.options.forEach((o, i) => { row[`${q.id}__${i + 1}`] = c.on.includes(o.value) ? 1 : 0; });
      }
    }
    for (const dk of devKeys) {
      const fs = devFields.filter((f) => f.device === dk); const d = { respondent_id: rid, device: dk, device_label: fs[0].deviceLabel };
      let any = false;
      for (const f of fs) {
        const r = fieldVal(s, f.id); row[`${dk}_${f.column}`] = r.v; d[f.column] = r.v;
        if (r.v !== '' && r.v !== undefined) any = true;
        if (r.bad) notes.push(`${fs[0].deviceLabel} ${f.column}: ${r.why} ("${r.v}")`);
      }
      if (any) dev.push({ respondent_id: rid, device: dk, device_label: d.device_label, other_device_name: d.name ?? '', active_in_use: d.active ?? '', broken_in_storage: d.broken ?? '', storage_location: d.where ?? '' });
    }
    row.review_notes = notes.join(' | ');
    for (const n of notes) review.push({ respondent_id: rid, file: s.file, issue: n });
    resp.push(row);
  }
  return { resp, dev, review };
}

/* ---------------- sheets for the AI ---------------- */
function pendingItems() { return Object.values(S.items).filter((i) => i.value === null); }

async function buildSheets() {
  const items = Object.values(S.items).sort((a, b) => parseInt(a.id) - parseInt(b.id));
  const sheets = []; let cur = null, x = 0, y = 0, rowH = 0;
  const pad = 8, gap = 6;
  const newSheet = () => { cur = { items: [], places: [] }; sheets.push(cur); x = 0; y = 0; rowH = 0; };
  newSheet();
  for (const it of items) {
    const img = await loadImage(it.crop); it._img = img;
    const maxW = CFG.sheetW - CFG.labelW - 2 * pad;
    const s = Math.min(1, maxW / img.width);
    const w = CFG.labelW + Math.round(img.width * s) + 2 * pad, h = Math.max(40, Math.round(img.height * s) + 2 * pad);
    if (x + w > CFG.sheetW) { x = 0; y += rowH + gap; rowH = 0; }
    if (y + h > CFG.sheetMaxH && cur.items.length) { newSheet(); }
    cur.items.push(it.id); cur.places.push({ it, x, y, w, h, s });
    x += w + gap; rowH = Math.max(rowH, h);
  }
  S.sheets = sheets.filter((s) => s.items.length).map((sh, i) => {
    const H = Math.max(...sh.places.map((p) => p.y + p.h)) + 4;
    const c = document.createElement('canvas'); c.width = CFG.sheetW; c.height = H;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    for (const p of sh.places) {
      ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
      ctx.fillStyle = '#ffeb3b'; ctx.fillRect(p.x + 1, p.y + 1, CFG.labelW - 4, p.h - 2);
      ctx.fillStyle = '#000'; ctx.font = 'bold 22px Arial, sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText(p.it.id, p.x + 6, p.y + p.h / 2);
      ctx.drawImage(p.it._img, p.x + CFG.labelW, p.y + pad, p.it._img.width * p.s, p.it._img.height * p.s);
    }
    return { n: i + 1, ids: sh.items, url: c.toDataURL('image/png'), w: c.width, h: H };
  });
  for (const it of items) delete it._img;
}

const PROMPT = `I'll send images of handwritten survey answers. Each box has a yellow ID label on its left (like 12n, 13t, 14c).
For every image, reply ONLY with one line per ID, in this exact format, nothing else:
ID|value

Rules:
- IDs ending in "n" are counts: write the number only. A dash or a single line means 0.
- IDs ending in "t" are words or dates: copy exactly what is written (Filipino/Hiligaynon place names are normal). Dates as written.
- IDs ending in "c" are checkboxes: write X if the box is ticked or marked, otherwise write -
- If a box has no handwriting at all, write nothing after the |
- If you really cannot read it, write ?
- Do not skip any ID and do not add explanations.`;

function applyReply(text) {
  let ok = 0, unknown = 0;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/[`*]/g, '').replace(/^\s*[-•]\s*/, '').replace(/^\|/, '').trim();
    const m = line.match(/^(\d+[ntc])\s*[|:\t=]\s*(.*?)\s*\|?\s*$/i);
    if (!m) continue;
    const it = S.items[m[1].toLowerCase()];
    if (!it) { unknown++; continue; }
    let v = m[2];
    if (it.kind === 'check') v = /^(x|✓|✔|yes|checked|ticked|marked)$/i.test(v) ? 'X' : v === '?' ? '?' : '-';
    it.value = v; ok++;
  }
  return { ok, unknown };
}

/* ---------------- UI ---------------- */
function renderFiles() {
  $('fileList').innerHTML = S.files.map((f) => `<li><span>${esc(f.name)}</span><span class="st ${f.cls || ''}">${esc(f.status || 'waiting')}</span></li>`).join('');
}
function updateButtons() {
  $('btnProcess').disabled = !S.ready || S.busy || !S.files.some((f) => !f.done);
}
function renderSheets() {
  const total = Object.keys(S.items).length, pend = pendingItems().length;
  $('aiStatus').textContent = total ? `${total - pend} of ${total} handwriting boxes read · ${S.sheets.length} sheet(s)` : 'No sheets yet. Process PDFs first.';
  $('sheets').innerHTML = (S.sheets || []).map((sh) => {
    const done = sh.ids.every((id) => S.items[id] && S.items[id].value !== null);
    return `<div class="sheet ${done ? 'done' : ''}"><img src="${sh.url}" data-n="${sh.n}" alt="Sheet ${sh.n}">
      <div class="meta"><span class="tag">Sheet ${sh.n}${done ? ' ✓' : ''}</span><span>${sh.ids.length} boxes</span></div>
      <div class="row" style="margin:4px 0 0"><button class="btn small" data-copy="${sh.n}">Copy image</button><button class="btn small" data-dl="${sh.n}">Download</button></div></div>`;
  }).join('');
}
function renderReview() {
  const out = [];
  for (const it of Object.values(S.items)) {
    const r = itemValue(it);
    if (r.pending || !r.bad) continue;
    out.push(`<div class="rv"><img src="${it.crop}"><div><b>${esc(fieldLabel(it))}</b><div class="muted">${esc(surveyLabel(it.survey))} · ${it.id}</div><div class="why">${esc(r.why)}</div></div>
      <input data-item="${it.id}" value="${esc(it.value)}"></div>`);
  }
  const { review } = buildRows();
  for (const r of review.filter((r) => !/AI could not read|not a whole number|AI unsure/.test(r.issue)))
    out.push(`<div class="rv note"><div class="muted">note</div><div><b>${esc(r.respondent_id)}</b> — ${esc(r.issue)}</div></div>`);
  $('review').innerHTML = out.join('') || '<p class="muted">Nothing to review yet.</p>';
}
function fieldLabel(it) {
  const f = S.tpl.textFields.find((x) => x.id === it.field);
  if (f) return f.group === 'devices' ? `${f.deviceLabel} — ${f.column === 'name' ? 'device name' : f.column}` : f.label;
  const q = S.tpl.questions.find((x) => x.id === it.field);
  return q ? `${q.label}: "${it.option}" ticked?` : it.field;
}
function surveyLabel(key) { const s = S.surveys.find((x) => x.key === key); return s ? `${s.file} (survey ${s.idx})` : key; }
function renderDebug() { if (S.debug) $('debugPages').innerHTML = (S.debugPages || []).map((u) => `<img src="${u}">`).join(''); }
function renderAll() { renderFiles(); renderSheets(); renderReview(); renderDebug(); updateButtons(); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function addFiles(list) {
  for (const file of list) {
    if (!/\.pdf$/i.test(file.name)) continue;
    const key = `${file.name}|${file.size}`;
    if (S.files.some((f) => f.key === key) || S.surveys.some((s) => s.fileKey === key)) continue;
    S.files.push({ key, name: file.name, file });
  }
  renderFiles(); updateButtons();
}

async function processAll() {
  S.busy = true; S.debugPages = S.debugPages || []; updateButtons();
  const todo = S.files.filter((f) => !f.done);
  let i = 0;
  for (const f of todo) {
    $('progress').textContent = `Processing ${++i} of ${todo.length}: ${f.name}`;
    $('barFill').style.width = `${((i - 1) / todo.length) * 100}%`;
    try { await processFile(f); } catch (e) { console.error(e); f.status = 'error: ' + e.message; f.cls = 'err'; f.done = true; }
    renderFiles(); await tick();
  }
  $('barFill').style.width = '100%';
  $('progress').textContent = 'Building handwriting sheets…';
  await buildSheets();
  const n = S.surveys.filter((s) => !s.blank).length;
  $('progress').textContent = `Done: ${n} survey(s) from ${S.files.length} PDF(s). Next: step 2.`;
  S.busy = false; renderAll();
  window.__done = true;
}

function download(name, blobOrUrl) {
  const a = document.createElement('a'); a.download = name;
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl); a.click();
}
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const q = (v) => { v = v ?? ''; v = String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
}
function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }

function wire() {
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => addFiles(ev.dataTransfer.files));
  $('fileInput').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });
  $('btnProcess').addEventListener('click', processAll);
  $('btnAllSheets').addEventListener('click', async () => {
    const todo = S.sheets.filter((sh) => !sh.ids.every((id) => S.items[id] && S.items[id].value !== null));
    for (const sh of todo) { download(`sheet-${String(sh.n).padStart(3, '0')}.png`, sh.url); await sleep(350); }
  });
  $('btnPrompt').addEventListener('click', async () => { await navigator.clipboard.writeText(PROMPT); flash($('btnPrompt'), 'Copied ✓'); });
  $('sheets').addEventListener('click', async (ev) => {
    const t = ev.target, n = +(t.dataset.copy || t.dataset.dl || t.dataset.n);
    const sh = S.sheets.find((s) => s.n === n); if (!sh) return;
    if (t.dataset.dl) download(`sheet-${String(n).padStart(3, '0')}.png`, sh.url);
    else if (t.dataset.copy) {
      try { const blob = await (await fetch(sh.url)).blob(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); flash(t, 'Copied ✓'); }
      catch (e) { flash(t, 'Use Download'); }
    } else if (t.tagName === 'IMG') { const d = document.createElement('dialog'); d.innerHTML = `<img src="${sh.url}">`; d.onclick = () => d.remove(); document.body.append(d); d.showModal(); }
  });
  $('btnApply').addEventListener('click', () => {
    const r = applyReply($('reply').value);
    $('applyMsg').textContent = `${r.ok} value(s) applied` + (r.unknown ? `, ${r.unknown} unknown ID(s) ignored` : '') + `. ${pendingItems().length} still waiting.`;
    if (r.ok) $('reply').value = '';
    renderAll();
  });
  $('review').addEventListener('change', (ev) => { const id = ev.target.dataset.item; if (id && S.items[id]) { S.items[id].value = ev.target.value; renderSheets(); ev.target.style.borderColor = '#1a7f37'; } });
  $('btnXlsx').addEventListener('click', () => {
    const { resp, dev, review } = buildRows(); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resp), 'Respondents');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dev.length ? dev : [{ note: 'no device rows' }]), 'Devices');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(review.length ? review : [{ note: 'nothing to review' }]), 'Review');
    XLSX.writeFile(wb, `ewacs-responses-${stamp()}.xlsx`);
  });
  $('btnCsvR').addEventListener('click', () => download(`ewacs-respondents-${stamp()}.csv`, new Blob(['﻿' + toCsv(buildRows().resp)], { type: 'text/csv' })));
  $('btnCsvD').addEventListener('click', () => download(`ewacs-devices-${stamp()}.csv`, new Blob(['﻿' + toCsv(buildRows().dev)], { type: 'text/csv' })));
  $('btnSave').addEventListener('click', () => {
    const data = { app: 'ewacs-encoder', v: 1, tpl: S.tpl.id, nextId: S.nextId, surveys: S.surveys, items: S.items,
      files: S.files.filter((f) => f.done).map(({ key, name, status, cls }) => ({ key, name, status, cls, done: true })) };
    download(`ewacs-session-${stamp()}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
  });
  $('sessionInput').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text()); if (d.app !== 'ewacs-encoder') throw new Error('not a session file');
      S.surveys = d.surveys; S.items = d.items; S.nextId = d.nextId; S.files = d.files || [];
      await buildSheets(); renderAll(); $('progress').textContent = 'Session loaded.';
    } catch (e) { alert('Could not load session: ' + e.message); }
  });
  $('btnReset').addEventListener('click', () => {
    if (!confirm('Clear all PDFs, sheets and answers?')) return;
    S.files = []; S.surveys = []; S.items = {}; S.sheets = []; S.nextId = 1; S.debugPages = [];
    $('progress').textContent = ''; $('barFill').style.width = '0'; renderAll();
  });
  window.addEventListener('beforeunload', (e) => { if (Object.keys(S.items).length) { e.preventDefault(); e.returnValue = ''; } });
}
function flash(btn, t) { const o = btn.textContent; btn.textContent = t; setTimeout(() => (btn.textContent = o), 1500); }

S.sheets = [];
wire();
boot();
