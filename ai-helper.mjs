#!/usr/bin/env node
// E-WACS Survey Encoder — AI helper.
// Lets the web tool use YOUR AI subscription through the official command-line tools on this computer:
//   • Claude  → Claude Code  (log in once with `claude`  using your Claude Pro/Max account)
//   • Gemini  → Gemini CLI   (log in once with `gemini` using your Google AI Pro/Ultra account)
// Run:  node ai-helper.mjs   and keep the window open while the web tool processes PDFs.
// Only the small handwriting sheet images are sent to the AI; nothing else leaves your computer.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const PORT = Number(process.env.EWACS_PORT || 8787);
const ALLOWED_ORIGINS = [/^https:\/\/[a-z0-9-]+\.github\.io$/i, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const IS_WIN = process.platform === 'win32';

const ENGINES = {
  claude: { bin: process.env.EWACS_CLAUDE_BIN || 'claude', pkg: '@anthropic-ai/claude-code', model: process.env.EWACS_CLAUDE_MODEL || '', cli: null, version: null },
  gemini: { bin: process.env.EWACS_GEMINI_BIN || 'gemini', pkg: '@google/gemini-cli', model: process.env.EWACS_GEMINI_MODEL || '', cli: null, version: null },
};

// Use the subscription login, never a pay-per-use API key that happens to be set in the environment.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI']) delete env[k];
  return env;
}

function run(cmd, args, cwd, opts = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { cwd, env: cleanEnv(), shell: !!opts.shell, windowsHide: true }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e) }); }
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    if (opts.stdin !== undefined) { p.stdin.end(opts.stdin); } else { p.stdin.end(); }
    p.on('error', (e) => resolve({ code: -1, out, err: String(e.message || e) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// Find how to start a CLI. On Windows, npm installs .cmd shims that Node can't start safely,
// so we start the package's JavaScript entry file with this same Node instead.
async function resolveCli(name) {
  const e = ENGINES[name];
  if (e.cli) return e.cli;
  const direct = await run(e.bin, ['--version'], tmpdir());
  if (direct.code === 0) { e.version = direct.out.trim().split('\n').pop(); return (e.cli = { cmd: e.bin, pre: [] }); }
  if (IS_WIN) {
    const root = (await run('npm root -g', [], tmpdir(), { shell: true })).out.trim();
    const pj = join(root, ...e.pkg.split('/'), 'package.json');
    if (root && existsSync(pj)) {
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      const rel = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
      const entry = join(dirname(pj), rel);
      const v = await run(process.execPath, [entry, '--version'], tmpdir());
      if (v.code === 0) { e.version = v.out.trim().split('\n').pop(); return (e.cli = { cmd: process.execPath, pre: [entry] }); }
    }
  }
  return null;
}

function extractJson(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

async function readSheets({ engine, images, prompt, schema }) {
  const cli = await resolveCli(engine);
  if (!cli) throw new Error(`${engine === 'claude' ? 'Claude Code' : 'Gemini CLI'} is not installed or not on PATH`);
  const E = ENGINES[engine];
  const dir = mkdtempSync(join(tmpdir(), 'ewacs-'));
  try {
    const names = images.map((b64, i) => {
      const n = `sheet-${String(i + 1).padStart(2, '0')}.png`;
      writeFileSync(join(dir, n), Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      return n;
    });
    let args;
    if (engine === 'claude') {
      const p = `${prompt}\n\nRead these image files in this folder, every one of them: ${names.join(', ')}`;
      args = ['-p', p, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--allowedTools', 'Read',
        '--system-prompt', 'You transcribe handwriting from cropped survey images. Read each image file you are given with the Read tool, then answer only with the requested JSON. Mark unsure readings.'];
    } else {
      const p = `${prompt}\n\nDo not use any tools and do not write files. Reply with ONLY one JSON object, no markdown, in exactly this shape:\n{"values":[{"id":"12n","value":"3","unsure":false}]}\n\nImages: ${names.map((n) => '@' + n).join(' ')}`;
      args = ['-p', p, '-o', 'json', '--skip-trust'];
    }
    if (E.model) args.push(engine === 'claude' ? '--model' : '-m', E.model);
    const t0 = Date.now();
    const r = await run(cli.cmd, [...cli.pre, ...args], dir);
    let j = null; try { j = JSON.parse(r.out); } catch (_) { j = extractJson(r.out); }
    if (!j) throw new Error((r.err || r.out || 'no output').trim().slice(-600));
    let result;
    if (engine === 'claude') {
      if (j.is_error || !j.structured_output) throw new Error(String(j.result || j.subtype || 'Claude returned no structured output').slice(0, 600));
      result = j.structured_output;
    } else {
      if (j.error) throw new Error(String(j.error.message || JSON.stringify(j.error)).slice(0, 600));
      result = extractJson(j.response);
      if (!result || !Array.isArray(result.values)) throw new Error('Gemini did not return the expected JSON: ' + String(j.response || '').slice(0, 300));
    }
    console.log(`  ${engine}: read ${images.length} sheet(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function cors(req, res) {
  const o = req.headers.origin || '';
  if (ALLOWED_ORIGINS.some((r) => r.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.headers.origin && !ALLOWED_ORIGINS.some((r) => r.test(req.headers.origin))) return send(res, 403, { error: 'origin not allowed' });
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const engines = {};
      for (const k of Object.keys(ENGINES)) engines[k] = (await resolveCli(k)) ? ENGINES[k].version || 'installed' : null;
      return send(res, 200, { ok: true, version: 2, engines });
    }
    if (req.method === 'POST' && req.url === '/read') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 60e6) throw new Error('request too large'); }
      const data = JSON.parse(body);
      if (!ENGINES[data.engine]) throw new Error('unknown engine');
      console.log(`Reading ${data.images.length} sheet(s) with ${data.engine}…`);
      return send(res, 200, await readSheets(data));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('  error:', e.message);
    send(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`The helper is already running on port ${PORT} (another window). You can close this one.`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`E-WACS AI helper running on http://127.0.0.1:${PORT}`);
  for (const k of Object.keys(ENGINES)) {
    const ok = await resolveCli(k);
    console.log(`  ${k === 'claude' ? 'Claude Code' : 'Gemini CLI '}: ${ok ? 'found ' + (ENGINES[k].version || '') : 'not found'}`);
  }
  console.log('Keep this window open while the web tool processes PDFs. Press Ctrl+C to stop.');
});
