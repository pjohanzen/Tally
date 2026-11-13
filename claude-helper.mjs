#!/usr/bin/env node
// E-WACS Survey Encoder — Claude helper.
// Lets the web tool use YOUR Claude subscription (Pro/Max) through Claude Code on this computer.
// Run:  node claude-helper.mjs        (keep this Terminal window open while processing)
// Needs: Claude Code installed and logged in with your Claude account (run `claude` once to log in).
// Only the small handwriting sheet images are sent to Claude; nothing else leaves your computer.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.EWACS_PORT || 8787);
const MODEL = process.env.EWACS_MODEL || ''; // e.g. "sonnet"; empty = Claude Code default
const ALLOWED_ORIGINS = [/^https:\/\/[a-z0-9-]+\.github\.io$/i, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const CLAUDE = process.env.EWACS_CLAUDE_BIN || 'claude';

const SYSTEM = 'You transcribe handwriting from cropped survey images. Read each image file you are given with the Read tool, then answer only with the requested JSON. Never guess silently: mark unsure readings.';

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

function run(args, cwd) {
  return new Promise((resolve) => {
    // make sure Claude Code uses the subscription login, not a pay-per-use API key
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
    const p = spawn(CLAUDE, args, { cwd, env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: String(e.message || e) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

let version = null;
async function claudeVersion() {
  if (version) return version;
  const r = await run(['--version'], tmpdir());
  if (r.code === 0) version = r.out.trim();
  return version;
}

async function readSheets({ images, prompt, schema }) {
  const dir = mkdtempSync(join(tmpdir(), 'ewacs-'));
  try {
    const names = images.map((b64, i) => {
      const n = `sheet-${String(i + 1).padStart(2, '0')}.png`;
      writeFileSync(join(dir, n), Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      return n;
    });
    const fullPrompt = `${prompt}\n\nRead these image files in this folder, every one of them: ${names.join(', ')}`;
    const args = ['-p', fullPrompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--allowedTools', 'Read', '--system-prompt', SYSTEM];
    if (MODEL) args.push('--model', MODEL);
    const t0 = Date.now();
    const r = await run(args, dir);
    let j = null; try { j = JSON.parse(r.out); } catch (_) {}
    if (!j) throw new Error((r.err || r.out || 'no output from claude').slice(0, 500));
    if (j.is_error || !j.structured_output) throw new Error(String(j.result || j.subtype || 'Claude returned no structured output').slice(0, 500));
    console.log(`  read ${images.length} sheet(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return j.structured_output;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!ALLOWED_ORIGINS.some((r) => r.test(req.headers.origin || '')) && req.headers.origin) return send(res, 403, { error: 'origin not allowed' });
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const v = await claudeVersion();
      return send(res, v ? 200 : 500, v ? { ok: true, claude: v, model: MODEL || 'default' } : { ok: false, error: `Could not run "${CLAUDE}". Is Claude Code installed?` });
    }
    if (req.method === 'POST' && req.url === '/read') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 60e6) throw new Error('request too large'); }
      const data = JSON.parse(body);
      console.log(`Reading ${data.images.length} sheet(s)…`);
      return send(res, 200, await readSheets(data));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('  error:', e.message);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const v = await claudeVersion();
  console.log(`E-WACS Claude helper running on http://127.0.0.1:${PORT}`);
  console.log(v ? `Using Claude Code ${v}${MODEL ? ` (model: ${MODEL})` : ''}` : `WARNING: could not run "${CLAUDE}". Install Claude Code and log in first.`);
  console.log('Keep this window open while the web tool processes PDFs. Press Ctrl+C to stop.');
});
