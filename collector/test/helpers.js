'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const SERVER = path.join(__dirname, '..', 'server.js');

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'collector-')); }

/* start the collector on a free port with the given environment; resolves with { port, url, proc, stop, out } */
function start(extraEnv) {
  const env = Object.assign({}, process.env, { PORT: '0', INGEST_KEY: 'ingest-secret-1234', READ_KEY: 'read-secret-1234', SAVE_DELAY_MS: '20', PRICES_URL: 'off' }, extraEnv || {});
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; proc.kill(); reject(new Error('server did not start: ' + out.join(''))); } }, 8000);
    const onData = (d) => {
      const s = d.toString(); out.push(s);
      const m = /listening on port (\d+)/.exec(s);
      if (m && !done) {
        done = true; clearTimeout(timer);
        const port = Number(m[1]);
        resolve({ port, url: 'http://127.0.0.1:' + port, proc, out, stop: () => stop(proc) });
      }
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error('server exited with ' + code + ': ' + out.join(''))); } });
  });
}
/* on Windows a signal is a plain kill (no graceful shutdown), and a killed process has exitCode null with signalCode set */
const gone = (proc) => proc.exitCode !== null || proc.signalCode !== null;
function stop(proc) {
  return new Promise((resolve) => {
    if (gone(proc)) return resolve();
    const done = () => resolve();
    proc.once('exit', done);
    proc.kill('SIGTERM');
    setTimeout(() => { if (!gone(proc)) proc.kill('SIGKILL'); }, 10000).unref();
    setTimeout(done, 20000).unref();
  });
}
const WINDOWS = process.platform === 'win32';

function kv(key, value) {
  let v;
  if (typeof value === 'number') v = Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  else if (typeof value === 'boolean') v = { boolValue: value };
  else v = { stringValue: String(value) };
  return { key, value: v };
}
function toAttrs(o) { return Object.keys(o).map((k) => kv(k, o[k])); }

/* build an OTLP ExportLogsServiceRequest with one resource and the given records ({attrs, time, body}) */
function otlp(resourceAttrs, records) {
  return {
    resourceLogs: [{
      resource: { attributes: toAttrs(Object.assign({ 'service.name': 'claude-code', 'service.version': '2.1.0', 'os.type': 'windows', 'os.version': '10.0.22631', 'host.arch': 'x64' }, resourceAttrs)) },
      scopeLogs: [{ scope: { name: 'com.anthropic.claude_code' }, logRecords: records.map((r) => ({
        timeUnixNano: String(BigInt(Date.parse(r.time || '2026-10-18T10:00:00Z')) * 1000000n),
        severityNumber: 9, severityText: 'INFO', body: { stringValue: r.body || 'claude_code.' + (r.attrs['event.name'] || 'api_request') },
        attributes: toAttrs(r.attrs),
      })) }],
    }],
  };
}
/* a typical api_request record; values are strings, as Claude Code sends them */
function apiReq(o) {
  const a = Object.assign({ 'event.name': 'api_request', 'event.timestamp': o.time || '2026-10-18T10:00:00Z', 'session.id': o.session || 'sess-1', 'user.id': 'u1', 'user.email': 'team@example.com',
    model: o.model || 'claude-sonnet-4-5-20250929', input_tokens: String(o.in == null ? 100 : o.in), output_tokens: String(o.out == null ? 50 : o.out),
    cache_read_tokens: String(o.cr == null ? 1000 : o.cr), cache_creation_tokens: String(o.cw == null ? 200 : o.cw), cost_usd: String(o.cost == null ? 0.0123 : o.cost), duration_ms: '1500' }, o.extra || {});
  if (o.rid !== null) a.request_id = o.rid || ('req_' + Math.random().toString(36).slice(2));
  return { attrs: a, time: o.time, body: o.body };
}
function multi(resources) {
  return { resourceLogs: resources.map((r) => otlp(r.attrs, r.records).resourceLogs[0]) };
}

async function post(url, body, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.key !== null) headers['x-api-key'] = opts.key || 'ingest-secret-1234';
  let payload = typeof body === 'string' ? body : JSON.stringify(body);
  if (opts.gzip) { payload = zlib.gzipSync(Buffer.from(payload)); headers['content-encoding'] = 'gzip'; }
  const r = await fetch(url, { method: 'POST', headers, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text, headers: r.headers };
}
async function get(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text, headers: r.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 4000)) { if (await fn()) return true; await sleep(30); } return false; }

module.exports = { start, stop, gone, WINDOWS, tmpdir, otlp, multi, apiReq, kv, toAttrs, post, get, sleep, until };
