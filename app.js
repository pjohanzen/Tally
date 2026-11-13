/* E-WACS Survey Encoder — runs fully in the browser.
 * Pipeline per PDF page: render (pdf.js) -> identify form page + align to template (OpenCV ORB + homography)
 * -> per-field local alignment (matchTemplate) -> checkboxes by ink count -> handwriting crops for the AI sheets.
 */
'use strict';
const APP_VERSION = '2026.11.13-5';

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
  cropScale: 0.8,           // handwriting crops (200 dpi * 0.8 = 160 dpi)
  ocrModel: 'Xenova/trocr-small-handwritten',
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
    if (state === 'unsure') { c.crop = cropCanvas(warped, shift(a.o.line, a.off), false); c.guess = delta >= 18; }
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
    let crop = null, dash = false;
    const blank = ink < (CFG.blankInk[f.kind] || CFG.blankInk.text);
    if (!blank) {
      const bb = inkBounds(clean);
      dash = f.kind === 'count' && bb.height <= 20 && bb.width >= 2 * bb.height;
      const padX = 14, padY = 12;
      crop = cropCanvas(warped, [r.x + bb.x - padX, r.y + bb.y - padY, bb.width + 2 * padX, bb.height + 2 * padY], true);
    }
    [sRoi, refRoi, refDil, k, hw, clean, k2].forEach((m) => m.delete());
    out.fields.push({ id: f.id, kind: f.kind, blank, ink, crop, dash });
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
    else if (c.state === 'unsure') a.unsure[c.value] = newItem(survey, c.qid, 'check', c.crop, { option: c.value, guess: c.guess });
  }
  for (const f of res.fields) {
    survey.fields[f.id] = f.blank ? { blank: true } : { item: newItem(survey, f.id, f.kind, f.crop, { dash: f.dash }) };
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
  if (!it || it.value === null || it.value === undefined) return { v: '', bad: true, pending: true, why: 'not read yet' };
  const v = String(it.value).trim();
  if (it.kind === 'count') return /^\d+$/.test(v) ? { v: Number(v), bad: !!it.flag, why: 'check the number' } : { v, bad: true, why: 'not a number' };
  if (it.kind === 'check') return { v: v === 'X', bad: !!it.flag, why: 'faint mark: ticked or not?' };
  return { v, bad: !!it.flag, why: it.missed ? 'not returned by the AI' : v ? 'check spelling' : 'could not read' };
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
        row[q.id] = c.on.join('; ');
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

/* ---------------- on-device handwriting reading ---------------- */
const OCR = { pipe: null, loading: null, device: '' };
async function loadOcr(onProgress) {
  if (OCR.pipe) return OCR.pipe;
  if (OCR.loading) return OCR.loading;
  OCR.loading = (async () => {
    const T = await import('./vendor/transformers.min.js');
    T.env.allowLocalModels = false;
    T.env.backends.onnx.wasm.wasmPaths = new URL('vendor/', location.href).href;
    const files = {};
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) { files[p.file] = [p.loaded, p.total]; const v = Object.values(files); onProgress(v.reduce((a, x) => a + x[0], 0), v.reduce((a, x) => a + x[1], 0)); }
    };
    const make = (device, dtype) => T.pipeline('image-to-text', CFG.ocrModel, { device, dtype, progress_callback });
    // Fastest working setup: image encoder on the GPU (full precision; half precision breaks on some Macs),
    // text decoder on the CPU. Self-test it and fall back to CPU-only if the GPU gives wrong answers.
    let pipe = null, device = 'wasm';
    if (navigator.gpu && !/[?&]wasm=1/.test(location.search)) {
      try {
        pipe = await make({ encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, { encoder_model: 'fp32', decoder_model_merged: 'q8' });
        const out = await pipe(testImage('37'), { max_new_tokens: 6 });
        if (!/3\s*7/.test(out[0].generated_text)) throw new Error('GPU self-test failed: ' + out[0].generated_text);
        device = 'webgpu';
      } catch (e) { console.warn('WebGPU not usable, using CPU', e); if (pipe) { try { await pipe.dispose(); } catch (_) {} } pipe = null; }
    }
    if (!pipe) pipe = await make('wasm', 'q8');
    OCR.pipe = pipe;
    OCR.device = device;
    return OCR.pipe;
  })();
  return OCR.loading;
}

// TrOCR expects a line of text; give tiny crops a wider white canvas so they are not stretched
function testImage(txt) {
  const c = document.createElement('canvas'); c.width = 140; c.height = 64; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000'; x.font = '40px sans-serif'; x.fillText(txt, 30, 48);
  return c.toDataURL('image/png');
}
async function ocrInput(it) {
  const img = await loadImage(it.crop);
  const h = Math.max(img.height, 48), w = Math.max(img.width, Math.round(h * 2.2)) + 20;
  const c = document.createElement('canvas'); c.width = w; c.height = h + 16;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, Math.round((w - img.width) / 2), Math.round((c.height - img.height) / 2));
  return c.toDataURL('image/png');
}

const DIGIT_MAP = { l: '1', I: '1', i: '1', '|': '1', '!': '1', '/': '1', '\\': '1', ']': '1', '[': '1', ')': '1', '(': '1', t: '1', T: '1', J: '1', j: '1',
  O: '0', o: '0', D: '0', Q: '0', S: '5', s: '5', Z: '2', z: '2', B: '8', g: '9', q: '9', G: '6', b: '6', A: '4', '?': '7' };
function cleanCount(raw) {
  let t = String(raw || '').trim();
  if (!t || /^[-–—_~=.,'"`]+$/.test(t)) return { v: '0', flag: false };
  const toks = t.split(/\s+/); if (toks.length > 1 && toks.every((x) => x === toks[0])) t = toks[0];
  let d = '';
  for (const ch of t.replace(/\s+/g, '')) d += /\d/.test(ch) ? ch : (DIGIT_MAP[ch] || '');
  if (!d) return { v: t, flag: true };
  d = d.replace(/^0+(?=\d)/, '');
  return { v: d, flag: d.length > 2 || t.replace(/[\s.,]/g, '').length > d.length + 1 };
}
const PLACES = ['House', 'Bahay', 'Cabinet', 'Bodega', 'Garage', 'Outdoors', 'Outside', 'Kitchen', 'Storage room', 'Bodega/Storage'];
function lev(a, b) { const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
function snapPlace(raw) {
  const t = String(raw || '').trim().replace(/[.,;:]+$/, ''); if (!t) return { v: '', flag: true };
  let best = null, bd = 99;
  for (const p of PLACES) { const dd = lev(t.toLowerCase(), p.toLowerCase()); if (dd < bd) { bd = dd; best = p; } }
  if (best && bd <= Math.max(1, Math.floor(best.length * 0.4))) return { v: best, flag: false };
  return { v: t, flag: true };
}

async function readHandwriting(items, onStep) {
  const pipe = await loadOcr(() => {});
  let i = 0;
  for (const it of items) {
    onStep(++i, items.length);
    if (it.value !== null) continue;
    if (it.kind === 'check') { it.value = it.guess ? 'X' : '-'; it.flag = true; continue; }
    if (it.kind === 'count' && it.dash) { it.value = '0'; it.raw = '—'; continue; }
    let raw = '';
    try { const out = await pipe(await ocrInput(it), { max_new_tokens: it.kind === 'count' ? 5 : 24 }); raw = (out[0] && out[0].generated_text) || ''; }
    catch (e) { console.error(e); }
    it.raw = raw;
    const f = S.tpl.textFields.find((x) => x.id === it.field) || {};
    const r = it.kind === 'count' ? cleanCount(raw) : f.column === 'where' ? snapPlace(raw)
      : it.field === 'date' ? { v: raw.trim(), flag: !/^\d{1,2}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{2,4}$/.test(raw.trim()) }
      : { v: raw.trim().replace(/[.]$/, ''), flag: !raw.trim() };
    it.value = r.v; it.flag = r.flag;
    if (i % 4 === 0) await tick();
  }
}

/* ---------------- AI readers: Claude (via local helper) or Gemini (API key) ---------------- */
const SETTINGS_KEY = 'ewacs-settings-v1';
const IS_WIN = /Win/i.test(navigator.platform || navigator.userAgent);
function defaultHelperCmd() {
  const url = new URL('ai-helper.mjs', location.href).href;
  return IS_WIN
    ? `irm ${url} -OutFile $HOME\\ewacs-ai-helper.mjs; node $HOME\\ewacs-ai-helper.mjs`
    : `curl -fsSL ${url} -o ~/ewacs-ai-helper.mjs && node ~/ewacs-ai-helper.mjs`;
}
const settings = (() => {
  const d = { reader: 'claude', helperCmd: '', helperUrl: 'http://127.0.0.1:8787', barangays: '', surveyors: '' };
  let s; try { s = Object.assign(d, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { s = d; }
  if (!s.helperCmd || /claude-helper\.mjs/.test(s.helperCmd)) s.helperCmd = defaultHelperCmd();
  if (!['claude', 'gemini', 'offline'].includes(s.reader)) s.reader = 'claude';
  delete s.geminiKey; delete s.geminiModel;
  return s;
})();
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } }
const listOf = (txt) => String(txt || '').split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);

const READ_SCHEMA = { type: 'object', properties: { values: { type: 'array', items: { type: 'object',
  properties: { id: { type: 'string' }, value: { type: 'string' }, unsure: { type: 'boolean' } }, required: ['id', 'value', 'unsure'] } } }, required: ['values'] };

function readerPrompt() {
  const b = listOf(settings.barangays), s = listOf(settings.surveyors);
  return `These images contain handwriting cropped from household survey forms (E-WACS e-waste survey, Bacolod City, Philippines).
Each box has a yellow ID label on its left (for example 12n, 13t, 14c). Transcribe EVERY box in EVERY image exactly as written.

Rules by the last letter of the ID:
- "n" = a count of devices or people. Return digits only (e.g. "3", "12"). A dash, a single horizontal line or "none" means "0".
- "t" = words or a date, written in English, Filipino or Hiligaynon. Copy what is written; do not translate or expand abbreviations (keep "Prk." as "Prk."). Dates exactly as written, e.g. "9/24/26".
- "c" = a printed checkbox option. Return "X" if the [ ] box or option is ticked/marked by hand, otherwise "-".
Set "unsure" to true whenever any character is hard to read or you had to guess; otherwise false. Never leave out an ID.${b.length ? `\nKnown barangay/purok names (use this exact spelling when the writing matches one): ${b.join('; ')}` : ''}${s.length ? `\nKnown surveyor/enumerator names (use this exact spelling when the writing matches one): ${s.join('; ')}` : ''}`;
}

// pack crops into labelled sheets (~1150 px wide) — the only thing an AI ever sees
async function buildSheets(items) {
  const W = 1150, MAXH = 1150, LABEL = 78, pad = 8, gap = 6, scale = 0.75;
  const sheets = []; let cur = null, x = 0, y = 0, rowH = 0;
  const next = () => { cur = { places: [] }; sheets.push(cur); x = 0; y = 0; rowH = 0; };
  next();
  for (const it of items) {
    const img = await loadImage(it.crop);
    const s = Math.min(scale, (W - LABEL - 2 * pad) / img.width);
    const w = LABEL + Math.round(img.width * s) + 2 * pad, h = Math.max(40, Math.round(img.height * s) + 2 * pad);
    if (x + w > W) { x = 0; y += rowH + gap; rowH = 0; }
    if (y + h > MAXH && cur.places.length) next();
    cur.places.push({ it, img, x, y, w, h, s }); x += w + gap; rowH = Math.max(rowH, h);
  }
  return sheets.filter((sh) => sh.places.length).map((sh) => {
    const H = Math.max(...sh.places.map((p) => p.y + p.h)) + 4;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    for (const p of sh.places) {
      ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
      ctx.fillStyle = '#ffeb3b'; ctx.fillRect(p.x + 1, p.y + 1, LABEL - 4, p.h - 2);
      ctx.fillStyle = '#000'; ctx.font = 'bold 22px Arial, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText(p.it.id, p.x + 6, p.y + p.h / 2);
      ctx.drawImage(p.img, p.x + LABEL + pad, p.y + pad, p.img.width * p.s, p.img.height * p.s);
    }
    return { ids: sh.places.map((p) => p.it.id), url: c.toDataURL('image/png') };
  });
}

async function helperHealth() {
  try { const r = await fetch(settings.helperUrl + '/health', { cache: 'no-store' }); return await r.json(); }
  catch (e) { return { ok: false, error: 'helper not running' }; }
}
async function readWithHelper(engine, sheets, onStep) {
  const per = engine === 'claude' ? 8 : 6, name = engine === 'claude' ? 'Claude' : 'Gemini';
  let done = 0;
  for (let i = 0; i < sheets.length; i += per) {
    const group = sheets.slice(i, i + per);
    onStep(`Reading handwriting with ${name}: batch ${i / per + 1} of ${Math.ceil(sheets.length / per)}`, done / sheets.length);
    const r = await fetch(settings.helperUrl + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine, images: group.map((s) => s.url), prompt: readerPrompt(), schema: READ_SCHEMA }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `helper error ${r.status}`);
    applyValues(j.values || []); done += group.length;
  }
}

function snapToList(raw, list) {
  const t = String(raw || '').trim(); if (!t || !list.length) return null;
  let best = null, bd = 99;
  for (const p of list) { const d = lev(t.toLowerCase(), p.toLowerCase()); if (d < bd) { bd = d; best = p; } }
  return best && bd <= Math.max(1, Math.floor(best.length * 0.35)) ? best : null;
}
function applyValues(values) {
  for (const v of values || []) {
    const it = S.items[String(v.id || '').trim().toLowerCase()]; if (!it) continue;
    const raw = String(v.value ?? '').trim(); let value = raw, flag = !!v.unsure;
    it.raw = raw;
    if (it.kind === 'count') { const r = cleanCount(raw); value = r.v; flag = flag || r.flag || !/^\d+$/.test(r.v); }
    else if (it.kind === 'check') { value = /^x$/i.test(raw) ? 'X' : '-'; }
    else {
      const f = S.tpl.textFields.find((x) => x.id === it.field) || {};
      if (f.column === 'where') { const s = snapPlace(raw); if (!s.flag) value = s.v; }
      else if (it.field === 'date') flag = flag || !/^\d{1,2}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{2,4}$/.test(raw);
      else if (it.field === 'barangay' || it.field === 'surveyor') {
        const list = listOf(it.field === 'barangay' ? settings.barangays : settings.surveyors);
        const m = snapToList(raw, list); if (m) value = m; else if (list.length) flag = true;
      }
      if (!raw) flag = true;
    }
    it.value = value; it.flag = flag;
  }
}

async function readHandwritingAI(items, prog) {
  S.readerUsed = settings.reader === 'gemini' ? 'Gemini' : 'Claude';
  const sheets = await buildSheets(items);
  S.sheetCount = (S.sheetCount || 0) + sheets.length;
  await readWithHelper(settings.reader, sheets, prog);
  for (const it of items) if (it.value === null) { it.value = ''; it.flag = true; it.missed = true; }
}

/* ---------------- UI ---------------- */
function renderFiles() {
  $('fileList').innerHTML = S.files.map((f) => `<li><span>${esc(f.name)}</span><span class="st ${f.cls || ''}">${esc(f.status || 'waiting')}</span></li>`).join('');
}
function updateButtons() {
  $('btnProcess').disabled = !S.ready || S.busy || !S.files.some((f) => !f.done);
  const has = S.surveys.some((s) => !s.blank) && !S.busy;
  ['btnCsvR', 'btnXlsx', 'btnCsvD'].forEach((id) => ($(id).disabled = !has));
  const unread = Object.values(S.items).filter((it) => it.value === null).length;
  $('btnRetry').hidden = !(unread && !S.busy && settings.reader !== 'offline');
}
function renderResults() {
  if (S.busy || !S.surveys.some((s) => !s.blank)) { $('preview').innerHTML = ''; return; }
  const { resp, dev } = buildRows();
  const flagged = Object.values(S.items).filter((it) => itemValue(it).bad).length;
  $('summary').innerHTML = `<b>${resp.length}</b> survey(s), <b>${dev.length}</b> device rows. ` + (S.readerUsed ? `Handwriting read by <b>${esc(S.readerUsed)}</b>. ` : '') +
    (flagged ? `${flagged} handwritten value(s) worth a quick check (below).` : 'All handwriting read.');
  $('checkCount').textContent = flagged ? `${flagged} to check` : 'all good';
  $('checkCount').className = 'badge' + (flagged ? '' : ' ok');
  const cols = Object.keys(resp[0] || {}).filter((c) => !/__\d+$/.test(c));
  $('preview').innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>` +
    resp.slice(0, 50).map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
}
function renderReview() {
  const all = $('showAll').checked;
  const items = Object.values(S.items).filter((it) => it.value !== null && (all || itemValue(it).bad))
    .sort((a, b) => (itemValue(b).bad - itemValue(a).bad) || (parseInt(a.id) - parseInt(b.id)));
  $('review').innerHTML = items.map((it) => {
    const r = itemValue(it);
    const input = it.kind === 'check'
      ? `<select data-item="${it.id}"><option value="X"${it.value === 'X' ? ' selected' : ''}>Ticked</option><option value="-"${it.value !== 'X' ? ' selected' : ''}>Not ticked</option></select>`
      : `<input data-item="${it.id}" value="${esc(it.value)}">`;
    return `<div class="rv ${r.bad ? 'flag' : ''}"><img src="${it.crop}"><div><b>${esc(fieldLabel(it))}</b><div class="muted">${esc(surveyLabel(it.survey))}</div>${r.bad ? `<div class="why">${esc(r.why)}</div>` : ''}</div>${input}</div>`;
  }).join('') || '<p class="muted">Nothing to check.</p>';
}
function fieldLabel(it) {
  const f = S.tpl.textFields.find((x) => x.id === it.field);
  if (f) return f.group === 'devices' ? `${f.deviceLabel} — ${{ active: 'active / in use', broken: 'broken / in storage', where: 'where stored', name: 'device name' }[f.column]}` : f.label;
  const q = S.tpl.questions.find((x) => x.id === it.field);
  return q ? `${q.label}: "${it.option}"` : it.field;
}
function surveyLabel(key) { const s = S.surveys.find((x) => x.key === key); return s ? `${s.file}${s.idx > 1 ? ` (survey ${s.idx})` : ''}` : key; }
function renderDebug() { if (S.debug) $('debugPages').innerHTML = (S.debugPages || []).map((u) => `<img src="${u}">`).join(''); }
function renderAll() { renderFiles(); renderResults(); renderReview(); renderDebug(); updateButtons(); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function addFiles(list) {
  for (const file of list) {
    if (!/\.pdf$/i.test(file.name)) continue;
    const key = `${file.name}|${file.size}`;
    if (S.files.some((f) => f.key === key)) continue;
    S.files.push({ key, name: file.name, file });
  }
  renderFiles(); updateButtons();
}

async function processAll() {
  S.busy = true; S.debugPages = S.debugPages || []; updateButtons();
  const prog = (t, frac) => { $('progress').textContent = t; if (frac !== undefined) $('barFill').style.width = `${Math.round(frac * 100)}%`; };
  S.progAI = (t, frac) => prog(t, frac === undefined ? undefined : 0.5 + frac * 0.5);
  // check the chosen reader before spending time on the PDFs
  if (settings.reader !== 'offline') {
    const h = await helperHealth(), name = settings.reader === 'claude' ? 'Claude Code' : 'Antigravity CLI (agy)';
    if (!h.ok) { prog('The AI helper is not running. Click Copy above, paste it in Terminal, press Enter, then click Process again.'); S.busy = false; updateButtons(); return; }
    if (!h.engines || !h.engines[settings.reader]) { prog(`The helper is running but ${name} was not found on this computer. Install it and log in once (see the README), then try again.`); S.busy = false; updateButtons(); return; }
  }
  const modelReady = settings.reader === 'offline' ? loadOcr((done, total) => { S.modelPct = Math.round((done / total) * 100); }).catch((e) => { S.modelErr = e; }) : null;
  const todo = S.files.filter((f) => !f.done);
  let i = 0;
  for (const f of todo) {
    prog(`Reading PDF ${++i} of ${todo.length}: ${f.name}`, (i - 1) / todo.length * 0.5);
    try { await processFile(f); } catch (e) { console.error(e); f.status = 'error: ' + e.message; f.cls = 'err'; f.done = true; }
    renderFiles(); await tick();
  }
  const items = Object.values(S.items).filter((it) => it.value === null).sort((a, b) => parseInt(a.id) - parseInt(b.id));
  if (items.length && settings.reader !== 'offline') {
    try { await readHandwritingAI(items, S.progAI); }
    catch (e) {
      console.error(e);
      const left = Object.values(S.items).filter((it) => it.value === null).length;
      prog(`Stopped while reading handwriting: ${e.message}. ${left} value(s) not read yet; click "Read remaining handwriting" to continue.`);
      S.busy = false; renderAll(); window.__done = true; return;
    }
  } else if (items.length) {
    S.readerUsed = 'Offline model (less accurate)';
    const wait = setInterval(() => { if (!OCR.pipe) prog(`Downloading handwriting model (first time only, ~130 MB)… ${S.modelPct || 0}%`); }, 300);
    await modelReady; clearInterval(wait);
    if (S.modelErr || !OCR.pipe) {
      prog('Could not load the handwriting model: ' + (S.modelErr && S.modelErr.message) + '. Check your internet connection and try again.');
      S.busy = false; renderAll(); return;
    }
    const t0 = performance.now();
    await readHandwriting(items, (k, n) => {
      const eta = k > 3 ? Math.round(((performance.now() - t0) / k) * (n - k) / 1000) : null;
      prog(`Reading handwriting ${k} of ${n}${eta !== null ? ` · about ${eta < 90 ? eta + ' s' : Math.round(eta / 60) + ' min'} left` : ''}`, 0.5 + (k / n) * 0.5);
    });
  }
  const n = S.surveys.filter((s) => !s.blank).length;
  prog(`Done: ${n} survey(s) from ${S.files.length} PDF(s).`, 1);
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

function flash(btn, t) { const o = btn.textContent; btn.textContent = t; setTimeout(() => (btn.textContent = o), 1500); }
function renderSettings() {
  document.querySelectorAll('input[name=reader]').forEach((r) => (r.checked = r.value === settings.reader));
  $('helperBox').hidden = settings.reader === 'offline';
  $('helperCmd').value = settings.helperCmd; $('listBarangays').value = settings.barangays; $('listSurveyors').value = settings.surveyors;
  if (settings.reader !== 'offline') checkHelper();
}
async function checkHelper() {
  const el = $('helperStatus'); el.textContent = 'checking…'; el.className = 'pill';
  const h = await helperHealth(), name = settings.reader === 'claude' ? 'Claude Code' : 'Gemini (agy)';
  if (!h.ok) { el.textContent = 'Helper not running'; el.className = 'pill err'; return; }
  const v = h.engines && h.engines[settings.reader];
  el.textContent = v ? `Helper running · ${name} found` : `Helper running · ${name} not found`;
  el.className = 'pill ' + (v ? 'ok' : 'err');
}
async function retryRemaining() {
  const items = Object.values(S.items).filter((it) => it.value === null);
  if (!items.length) return;
  S.busy = true; updateButtons();
  const prog = (t, f) => { $('progress').textContent = t; if (f !== undefined) $('barFill').style.width = `${Math.round(f * 100)}%`; };
  try { await readHandwritingAI(items, prog); prog('Done.', 1); }
  catch (e) { prog(`Stopped: ${e.message}. Click "Read remaining handwriting" to try again.`); }
  S.busy = false; renderAll();
}
function wire() {
  document.querySelectorAll('input[name=reader]').forEach((r) => r.addEventListener('change', () => { settings.reader = r.value; saveSettings(); renderSettings(); }));
  $('listBarangays').addEventListener('change', (e) => { settings.barangays = e.target.value; saveSettings(); });
  $('listSurveyors').addEventListener('change', (e) => { settings.surveyors = e.target.value; saveSettings(); });
  $('btnHelper').addEventListener('click', checkHelper);
  $('helperCmd').addEventListener('change', (e) => { settings.helperCmd = e.target.value.trim() || defaultHelperCmd(); saveSettings(); renderSettings(); });
  $('btnResetCmd').addEventListener('click', () => { settings.helperCmd = defaultHelperCmd(); saveSettings(); renderSettings(); });
  $('btnCopyCmd').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('helperCmd').value); } catch (e) { $('helperCmd').select(); document.execCommand('copy'); }
    flash($('btnCopyCmd'), 'Copied ✓'); setTimeout(checkHelper, 4000);
  });
  $('btnRetry').addEventListener('click', retryRemaining);
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => addFiles(ev.dataTransfer.files));
  $('fileInput').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });
  $('btnProcess').addEventListener('click', processAll);
  $('showAll').addEventListener('change', renderReview);
  $('review').addEventListener('change', (ev) => {
    const id = ev.target.dataset.item; if (!id || !S.items[id]) return;
    S.items[id].value = ev.target.value; S.items[id].flag = false;
    ev.target.style.borderColor = '#1a7f37'; renderResults();
  });
  $('btnXlsx').addEventListener('click', () => {
    const { resp, dev, review } = buildRows(); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resp), 'Respondents');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dev.length ? dev : [{ note: 'no device rows' }]), 'Devices');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(review.length ? review : [{ note: 'nothing to review' }]), 'Review');
    XLSX.writeFile(wb, `ewacs-responses-${stamp()}.xlsx`);
  });
  $('btnCsvR').addEventListener('click', () => download(`ewacs-respondents-${stamp()}.csv`, new Blob(['﻿' + toCsv(buildRows().resp)], { type: 'text/csv' })));
  $('btnCsvD').addEventListener('click', () => download(`ewacs-devices-${stamp()}.csv`, new Blob(['﻿' + toCsv(buildRows().dev)], { type: 'text/csv' })));
  window.addEventListener('beforeunload', (e) => { if (S.surveys.length) { e.preventDefault(); e.returnValue = ''; } });
}

wire();
renderSettings();
boot();
