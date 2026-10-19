#!/usr/bin/env node
'use strict';
/* Claude usage agent: a stdio MCP server that Claude Code starts on this PC.
   It reads this PC's own Claude Code conversation logs (the files ccusage reads), keeps per-day, per-model
   totals and per-session totals, and sends what changed to the collector on your server: on start, every minute
   while Claude Code runs, and when Claude Code exits. The collector replaces what it holds for the days sent, so
   sending twice never counts twice and a lost state file only costs a full re-send.
   Tools offered to Claude: usage_sync_now, usage_status, usage_summary.
   Also runs by hand: node agent.js --once (scan, send, print a summary) or --status.
   Node 18+, no dependencies. Everything on stdout is MCP; logs go to stderr. */
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '1.0.0';
const env = process.env;
const URL_BASE = (env.USAGE_URL || '').trim().replace(/\/+$/, '');
const KEY = (env.USAGE_KEY || '').trim();
const READ_KEY = (env.USAGE_READ_KEY || '').trim() || KEY;
/* names arrive percent-encoded from the install command (no quoting trouble in PowerShell or bash); decode them */
function pct(s) { if (!/%[0-9a-f]{2}/i.test(s)) return s; try { return decodeURIComponent(s); } catch (e) { return s; } }
const MEMBER = pct(env.USAGE_MEMBER || '').replace(/\s+/g, ' ').trim().slice(0, 60) || safeUser();
const HOST = pct(env.USAGE_HOST || '').replace(/\s+/g, ' ').trim().slice(0, 60) || os.hostname().split('.')[0];
const CLAUDE_DIR = env.USAGE_CLAUDE_DIR || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = env.USAGE_STATE_DIR || path.join(os.homedir(), '.claude-usage');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const INTERVAL = Math.max(10000, Number(env.USAGE_INTERVAL_MS) || 60000);
const TZ_OVERRIDE = (env.USAGE_TZ || '').trim();
const MAX_SESSIONS = 1000, MAX_KEYS = 30000, MIN_DATE = '2024-01-01';

function safeUser() { try { return os.userInfo().username; } catch (e) { return 'unknown'; } }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member'; }
const MEMBER_ID = slug(MEMBER) + '@' + HOST.toLowerCase();
const LABEL = MEMBER.toLowerCase() === HOST.toLowerCase() ? MEMBER : MEMBER + ' \u00B7 ' + HOST; /* as the dashboard shows it */
function log() { process.stderr.write(new Date().toISOString() + ' claude-usage: ' + Array.prototype.join.call(arguments, ' ') + '\n'); }

/* ---------- time ---------- */
function validTZ(name) { if (!name) return ''; try { new Intl.DateTimeFormat('en-CA', { timeZone: name }); return name; } catch (e) { return ''; } }
let dayFmt = null, dayFmtZone = null;
function dayOf(ms, zone) {
  if (!dayFmt || dayFmtZone !== zone) { dayFmt = new Intl.DateTimeFormat('en-CA', Object.assign({ year: 'numeric', month: '2-digit', day: '2-digit' }, zone ? { timeZone: zone } : {})); dayFmtZone = zone; }
  return dayFmt.format(new Date(ms));
}

/* ---------- state ---------- */
function emptyState() { return { v: 1, tz: '', files: {}, days: {}, sessions: {}, keys: [], dirtyDays: [], dirtySessions: [], full: true, lastActivity: '', lastScan: '', lastSync: '', lastSyncOk: '', lastError: '', fails: 0, nextTry: 0, sent: 0 }; }
let state = emptyState(), keySet = new Map(); /* message key -> output tokens counted so far */
function loadState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (o && o.v === 1 && o.days && o.files) { state = Object.assign(emptyState(), o); state.keys = state.keys.filter((k) => Array.isArray(k) && k.length === 2); keySet = new Map(state.keys); return true; }
  } catch (e) { if (e.code !== 'ENOENT') log('state file unreadable, starting over:', e.message); }
  state = emptyState(); keySet = new Map();
  return false;
}
function saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log('could not save state:', e.message); }
}
function resetTotals() {
  state.files = {}; state.days = {}; state.sessions = {}; state.keys = []; keySet = new Map();
  state.dirtyDays = []; state.dirtySessions = []; state.full = true;
}

/* ---------- the logs ---------- */
function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
function listLogs() { return walk(path.join(CLAUDE_DIR, 'projects'), []); }
/* read complete lines from a byte offset; a partial last line waits for the next round */
function readFrom(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) return { shrunk: true, size };
    const lines = [], buf = Buffer.allocUnsafe(1 << 20);
    let pos = offset, rem = Buffer.alloc(0);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      const chunk = rem.length ? Buffer.concat([rem, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      pos += n;
      let start = 0, i;
      while ((i = chunk.indexOf(10, start)) >= 0) { lines.push(chunk.subarray(start, i).toString('utf8')); start = i + 1; }
      rem = Buffer.from(chunk.subarray(start));
    }
    return { lines, nextOffset: size - rem.length, size };
  } finally { fs.closeSync(fd); }
}
function num(v) { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : 0; }
/* one assistant line with usage -> a record, or null */
function parseLine(line) {
  if (line.indexOf('"assistant"') < 0 || line.indexOf('"usage"') < 0) return null;
  let o;
  try { o = JSON.parse(line); } catch (e) { return null; }
  if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return null;
  if (o.isApiErrorMessage) return null;
  const m = o.message, u = m.usage;
  if (!u || typeof u !== 'object') return null;
  const model = typeof m.model === 'string' ? m.model.trim().toLowerCase() : '';
  if (!/^claude-/.test(model)) return null;
  const ms = Date.parse(o.timestamp);
  if (!Number.isFinite(ms) || ms < Date.parse(MIN_DATE)) return null;
  const key = (typeof m.id === 'string' && m.id ? m.id : 'u:' + o.uuid) + ':' + (typeof o.requestId === 'string' ? o.requestId : '');
  const cw = num(u.cache_creation_input_tokens), cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  return {
    key, ms, model, in: num(u.input_tokens), out: num(u.output_tokens), cw, cr: num(u.cache_read_input_tokens),
    cw1h: Math.min(cw, cc ? num(cc.ephemeral_1h_input_tokens) : 0),
    session: typeof o.sessionId === 'string' && o.sessionId ? o.sessionId.slice(0, 80) : '',
  };
}
function remember(key, out) {
  if (keySet.has(key)) { keySet.set(key, out); const i = state.keys.findIndex((k) => k[0] === key); if (i >= 0) state.keys[i][1] = out; return; }
  keySet.set(key, out); state.keys.push([key, out]);
  if (state.keys.length > MAX_KEYS) { const drop = state.keys.splice(0, state.keys.length - MAX_KEYS); drop.forEach((k) => keySet.delete(k[0])); }
}
function markDirty(list, v) { if (list.indexOf(v) < 0) list.push(v); }
/* extra: true when r is a later chunk of a message already counted; then only the additional output tokens count */
function applyRecord(r, zone, extra) {
  const day = dayOf(r.ms, zone);
  const byModel = state.days[day] || (state.days[day] = {});
  const c = byModel[r.model] || (byModel[r.model] = [0, 0, 0, 0, 0, 0]); /* in, out, cw, cr, n, cw1h */
  if (extra) c[1] += r.out; else { c[0] += r.in; c[1] += r.out; c[2] += r.cw; c[3] += r.cr; c[4] += 1; c[5] += r.cw1h; }
  markDirty(state.dirtyDays, day);
  const at = new Date(r.ms).toISOString();
  if (!state.lastActivity || at > state.lastActivity) state.lastActivity = at;
  if (r.session) {
    const s = state.sessions[r.session] || (state.sessions[r.session] = { first: at, last: at, models: {}, n: 0 });
    if (at > s.last) s.last = at; if (at < s.first) s.first = at;
    const sm = s.models[r.model] || (s.models[r.model] = [0, 0, 0, 0, 0]);
    if (extra) sm[1] += r.out; else { sm[0] += r.in; sm[1] += r.out; sm[2] += r.cw; sm[3] += r.cr; sm[4] += r.cw1h; s.n++; }
    markDirty(state.dirtySessions, r.session);
    const ids = Object.keys(state.sessions);
    if (ids.length > MAX_SESSIONS) ids.sort((a, b) => (state.sessions[a].last < state.sessions[b].last ? -1 : 1)).slice(0, ids.length - MAX_SESSIONS).forEach((id) => { delete state.sessions[id]; });
  }
}
/* scan the logs; incremental unless a file shrank or vanished or the day zone changed, then from scratch */
function scan(reason) {
  const zone = state.tz || '';
  let files = listLogs(), records = 0, restarted = false;
  const seen = new Set(files);
  const gone = Object.keys(state.files).filter((f) => !seen.has(f));
  if (gone.length && Object.keys(state.files).length) { log(gone.length + ' log file(s) gone, recounting everything'); resetTotals(); restarted = true; }
  for (let pass = 0; pass < 2; pass++) {
    let again = false;
    for (const f of files) {
      let st;
      try { st = fs.statSync(f); } catch (e) { continue; }
      const prev = state.files[f];
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
      const offset = prev ? prev.offset : 0;
      let r;
      try { r = readFrom(f, offset); } catch (e) { log('cannot read', f, e.message); continue; }
      if (r.shrunk) { log(path.basename(f) + ' shrank, recounting everything'); resetTotals(); again = true; break; }
      for (const line of r.lines) {
        const rec = parseLine(line);
        if (!rec) continue;
        if (keySet.has(rec.key)) {
          /* streamed chunks repeat the message with the same input and cache counts; the output count only grows */
          const counted = keySet.get(rec.key);
          if (rec.out > counted) { remember(rec.key, rec.out); applyRecord(Object.assign({}, rec, { out: rec.out - counted }), zone, true); }
          continue;
        }
        remember(rec.key, rec.out); applyRecord(rec, zone); records++;
      }
      state.files[f] = { offset: r.nextOffset, size: st.size, mtime: st.mtimeMs };
    }
    if (!again) break;
    restarted = true; records = 0; files = listLogs();
  }
  state.lastScan = new Date().toISOString();
  saveState();
  return { files: files.length, records, restarted, reason: reason || '' };
}

/* ---------- the collector ---------- */
function systemString() {
  const type = os.type(), rel = os.release();
  let name;
  if (type === 'Windows_NT') { const build = Number(rel.split('.')[2] || 0); name = (build >= 22000 ? 'Windows 11' : 'Windows 10') + ' (' + rel + ')'; }
  else if (type === 'Darwin') name = 'macOS (Darwin ' + rel + ')';
  else name = type + ' ' + rel;
  const cpus = os.cpus() || [], cpu = ((cpus[0] || {}).model || '').replace(/\s+/g, ' ').trim();
  const parts = [name + ' ' + os.arch(), (cpu ? cpu + ', ' : '') + cpus.length + ' threads', Math.round(os.totalmem() / 1073741824) + ' GB RAM'];
  if (client.name) parts.push((client.name === 'claude-code' ? 'Claude Code' : client.name) + (client.version ? ' ' + client.version : ''));
  return parts.join(' | ').slice(0, 200);
}
const client = { name: '', version: '' };
async function fetchJSON(url, opts, timeoutMs) {
  const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(timeoutMs || 20000) }, opts || {}));
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, ok: r.ok, json, text };
}
async function learnZone() {
  if (TZ_OVERRIDE) { setZone(validTZ(TZ_OVERRIDE) || ''); return; }
  if (!URL_BASE) return;
  try {
    const r = await fetchJSON(URL_BASE + '/healthz', {}, 8000);
    if (r.ok && r.json && typeof r.json.tz === 'string' && validTZ(r.json.tz)) setZone(r.json.tz);
  } catch (e) { /* keep the zone we have */ }
}
function setZone(zone) {
  if (zone === state.tz) return;
  log('day boundaries follow ' + (zone || 'this PC’s zone') + (state.tz || Object.keys(state.days).length ? ', recounting' : ''));
  state.tz = zone;
  if (Object.keys(state.files).length) resetTotals();
}
function payload() {
  const days = [];
  state.dirtyDays.forEach((day) => { const bm = state.days[day]; if (!bm) return; Object.keys(bm).sort().forEach((m) => { const c = bm[m]; days.push([day, m, c[0], c[1], c[2], c[3], c[4], c[5]]); }); });
  const sessions = state.dirtySessions.filter((id) => state.sessions[id]).map((id) => { const s = state.sessions[id]; return { id, first: s.first, last: s.last, n: s.n, byModel: s.models }; });
  return { agent: { version: VERSION, node: process.version }, member: { id: MEMBER_ID, name: MEMBER, host: HOST, system: systemString(), lastActivity: state.lastActivity },
    tz: state.tz, full: state.full, days, sessions };
}
async function sync(force) {
  if (!URL_BASE || !KEY) return { sent: false, error: 'USAGE_URL and USAGE_KEY are not set' };
  if (!state.dirtyDays.length && !state.dirtySessions.length && !force) return { sent: false, upToDate: true };
  if (!force && state.nextTry && Date.now() < state.nextTry) return { sent: false, waiting: true, error: state.lastError };
  const body = payload();
  if (force && !body.days.length) { /* a forced send with nothing new still re-sends everything, so the server can be rebuilt */
    body.full = true;
    Object.keys(state.days).sort().forEach((day) => { const bm = state.days[day]; Object.keys(bm).sort().forEach((m) => { const c = bm[m]; body.days.push([day, m, c[0], c[1], c[2], c[3], c[4], c[5]]); }); });
    body.sessions = Object.keys(state.sessions).map((id) => { const s = state.sessions[id]; return { id, first: s.first, last: s.last, n: s.n, byModel: s.models }; });
  }
  state.lastSync = new Date().toISOString();
  try {
    const r = await fetchJSON(URL_BASE + '/v1/usage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body) }, 30000);
    if (!r.ok) throw new Error('the collector answered ' + r.status + (r.json && r.json.error ? ': ' + r.json.error : ''));
    state.dirtyDays = []; state.dirtySessions = []; state.full = false; state.fails = 0; state.nextTry = 0; state.lastError = ''; state.lastSyncOk = state.lastSync; state.sent++;
    if (r.json && typeof r.json.tz === 'string' && validTZ(r.json.tz) && !TZ_OVERRIDE) setZone(r.json.tz);
    saveState();
    return { sent: true, days: body.days.length, sessions: body.sessions.length, full: body.full };
  } catch (e) {
    state.fails++; state.lastError = e && e.message ? e.message : String(e);
    state.nextTry = Date.now() + Math.min(30 * 60000, 60000 * Math.pow(2, Math.min(state.fails - 1, 5)));
    saveState();
    log('send failed:', state.lastError);
    return { sent: false, error: state.lastError };
  }
}
let busy = null;
function cycle(force, reason) {
  if (busy) return busy;
  busy = (async () => {
    try { const s = scan(reason); const r = await sync(force); return { scan: s, sync: r }; }
    finally { busy = null; }
  })();
  return busy;
}

/* ---------- tools ---------- */
const TOOLS = [
  { name: 'usage_sync_now', description: 'Read this PC’s Claude Code usage logs now and send the new totals to the team’s usage collector. Use when asked to sync, refresh or push usage. Returns what was sent.', inputSchema: { type: 'object', properties: { everything: { type: 'boolean', description: 'Re-send every day this PC has, not only what changed (use after the collector was reset)' } } } },
  { name: 'usage_status', description: 'How this PC’s usage reporting is doing: who it reports as, which collector, when it last synced, and any error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'usage_summary', description: 'Claude Code usage across the team from the collector: estimated cost and tokens by PC and by model for the last N days. Use when asked how much Claude was used or what it cost.', inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 366, description: 'How many days back, default 7' }, scope: { type: 'string', enum: ['all', 'me'], description: 'all PCs (default) or only this PC' } } } },
];
function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
function fmtUsd(v) { return v >= 100 ? '$' + Math.round(v).toLocaleString('en-US') : '$' + v.toFixed(2); }
function when(iso) { return iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : 'never'; }
function describe(r) {
  if (!r.sync.sent) return 'Scanned ' + r.scan.files + ' log files (' + r.scan.records + ' new API calls). Not sent: ' + (r.sync.error || 'nothing new') + '.';
  return 'Scanned ' + r.scan.files + ' log files, ' + r.scan.records + ' new API calls. Sent ' + r.sync.days + ' day-and-model rows and ' + r.sync.sessions + ' sessions' + (r.sync.full ? ' (everything this PC has)' : '') + ' to ' + URL_BASE + ' as \u201C' + LABEL + '\u201D.';
}
async function toolSyncNow(args) { return describe(await cycle(!!(args && args.everything), 'tool')); }
function toolStatus() {
  const daysN = Object.keys(state.days).length, pend = state.dirtyDays.length;
  return ['Reporting as “' + LABEL + '” (id ' + MEMBER_ID + ') to ' + (URL_BASE || '(USAGE_URL not set)') + '.',
    'Logs: ' + CLAUDE_DIR + ' (' + Object.keys(state.files).length + ' files, ' + daysN + ' days with usage, last activity ' + when(state.lastActivity) + ').',
    'Day boundaries: ' + (state.tz || 'this PC’s time zone') + '.',
    'Last scan ' + when(state.lastScan) + '; last successful send ' + when(state.lastSyncOk) + '; ' + (pend ? pend + ' day(s) waiting to be sent' : 'nothing waiting') + '.',
    state.lastError ? 'Last error: ' + state.lastError + (state.nextTry > Date.now() ? ' (next try in ' + Math.ceil((state.nextTry - Date.now()) / 60000) + ' min)' : '') : 'No errors.',
    'Agent ' + VERSION + ' on Node ' + process.version + '.'].join('\n');
}
async function toolSummary(args) {
  if (!URL_BASE) return 'USAGE_URL is not set.';
  const days = Math.min(366, Math.max(1, Number(args && args.days) || 7)), scope = args && args.scope === 'me' ? 'me' : 'all';
  let r;
  try { r = await fetchJSON(URL_BASE + '/api/usage', { headers: { 'x-read-key': READ_KEY } }, 20000); } catch (e) { return 'Could not reach the collector: ' + e.message; }
  if (r.status === 401) return 'The collector refused the key. Set USAGE_READ_KEY to its READ_KEY (or INGEST_KEY) in this MCP server’s environment.';
  if (!r.ok || !r.json || !Array.isArray(r.json.members)) return 'The collector answered ' + r.status + ' without a usage feed.';
  const zone = validTZ(r.json.tz) || '';
  const today = dayOf(Date.now(), zone), fromMs = Date.now() - (days - 1) * 86400000, from = dayOf(fromMs, zone);
  const members = r.json.members.filter((m) => scope === 'all' || m.id === MEMBER_ID);
  if (!members.length) return scope === 'me' ? 'The collector has nothing from this PC yet. Run usage_sync_now.' : 'The collector has no usage yet.';
  const byPc = [], byModel = new Map(); let tot = { cost: 0, in: 0, out: 0, cw: 0, cr: 0 };
  members.forEach((m) => {
    const t = { label: m.label, cost: 0, in: 0, out: 0, cw: 0, cr: 0, days: new Set() };
    (m.rows || []).forEach((row) => {
      if (row[0] < from || row[0] > today) return;
      t.cost += row[6]; t.in += row[2]; t.out += row[3]; t.cw += row[4]; t.cr += row[5]; t.days.add(row[0]);
      const mm = byModel.get(row[1]) || { cost: 0, out: 0 }; mm.cost += row[6]; mm.out += row[3]; byModel.set(row[1], mm);
    });
    tot.cost += t.cost; tot.in += t.in; tot.out += t.out; tot.cw += t.cw; tot.cr += t.cr;
    byPc.push(t);
  });
  byPc.sort((a, b) => b.cost - a.cost);
  const lines = ['Claude Code usage, ' + from + ' to ' + today + (zone ? ' (' + zone + ')' : '') + ', ' + (scope === 'me' ? 'this PC' : byPc.length + ' PC' + (byPc.length === 1 ? '' : 's')) + ':',
    'Estimated cost ' + fmtUsd(tot.cost) + ' (API list prices; a Max plan is not billed per token). Tokens: ' + fmtInt(tot.in) + ' input, ' + fmtInt(tot.out) + ' output, ' + fmtInt(tot.cw) + ' cache write, ' + fmtInt(tot.cr) + ' cache read.'];
  if (scope === 'all') { lines.push('By PC:'); byPc.forEach((t) => lines.push('  ' + t.label + ': ' + fmtUsd(t.cost) + ', ' + fmtInt(t.out) + ' output tokens, ' + t.days.size + ' active day' + (t.days.size === 1 ? '' : 's'))); }
  lines.push('By model:');
  Array.from(byModel.entries()).sort((a, b) => b[1].cost - a[1].cost).forEach(([m, v]) => lines.push('  ' + m + ': ' + fmtUsd(v.cost) + ', ' + fmtInt(v.out) + ' output tokens'));
  if (r.json.stats && r.json.stats.lastEvent) lines.push('Last usage received by the collector: ' + when(r.json.stats.lastEvent) + '.');
  return lines.join('\n');
}
async function callTool(name, args) {
  if (name === 'usage_sync_now') return toolSyncNow(args || {});
  if (name === 'usage_status') return toolStatus();
  if (name === 'usage_summary') return toolSummary(args || {});
  throw Object.assign(new Error('Unknown tool: ' + name), { code: -32602 });
}

/* ---------- MCP over stdio ---------- */
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
let timer = 0, started = false;
function startBackground() {
  if (started) return; started = true;
  setTimeout(() => { cycle(false, 'start').then((r) => { if (r.scan.records || r.sync.sent) log('start: ' + r.scan.records + ' new API calls, ' + (r.sync.sent ? 'sent ' + r.sync.days + ' rows' : (r.sync.error || 'nothing to send'))); }); }, 1500);
  timer = setInterval(() => { cycle(false, 'timer'); }, INTERVAL);
  setInterval(() => { learnZone(); }, 6 * 3600000).unref();
}
async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
  const id = msg.id, method = msg.method, params = msg.params || {};
  if (method === undefined) return; /* a response to something we never sent */
  if (id === undefined || id === null) { /* notification */
    if (method === 'notifications/initialized') startBackground();
    return;
  }
  try {
    if (method === 'initialize') {
      if (params.clientInfo && typeof params.clientInfo === 'object') { client.name = String(params.clientInfo.name || '').slice(0, 40); client.version = String(params.clientInfo.version || '').slice(0, 20); }
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply(id, { protocolVersion: PROTOCOLS.indexOf(asked) >= 0 ? asked : PROTOCOLS[1], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'claude-usage', version: VERSION },
        instructions: 'Reports this PC’s Claude Code usage to the team collector by itself. Call usage_summary when asked about Claude usage or cost, usage_status when asked whether reporting works, usage_sync_now to push right away.' });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params.name, args = params.arguments;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, 'Unknown tool: ' + name);
      try { const text = await callTool(name, args); return reply(id, { content: [{ type: 'text', text: String(text) }], isError: false }); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: 'The tool failed: ' + (e && e.message ? e.message : String(e)) }], isError: true }); }
    }
    if (method === 'resources/list') return reply(id, { resources: [] });
    if (method === 'resources/templates/list') return reply(id, { resourceTemplates: [] });
    if (method === 'prompts/list') return reply(id, { prompts: [] });
    if (method === 'logging/setLevel') return reply(id, {});
    if (method === 'completion/complete') return reply(id, { completion: { values: [] } });
    return fail(id, -32601, 'Method not found: ' + method);
  } catch (e) { return fail(id, -32603, 'Internal error: ' + (e && e.message ? e.message : String(e))); }
}
function serve() {
  let rem = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    rem += chunk;
    let i;
    while ((i = rem.indexOf('\n')) >= 0) {
      const line = rem.slice(0, i).trim(); rem = rem.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (Array.isArray(msg)) msg.forEach((m) => { handle(m); }); else handle(msg);
    }
  });
  let stopping = false;
  async function stop(why) {
    if (stopping) return; stopping = true;
    if (timer) clearInterval(timer);
    log(why + ': final send');
    try { await Promise.race([cycle(false, 'exit'), new Promise((r) => setTimeout(r, 4000))]); } catch (e) {}
    process.exit(0);
  }
  process.stdin.on('end', () => stop('Claude Code closed the connection'));
  process.stdin.on('close', () => stop('stdin closed'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGHUP', () => stop('SIGHUP'));
  process.stdout.on('error', () => process.exit(0));
}

/* ---------- main ---------- */
async function main() {
  const argv = process.argv.slice(2);
  loadState();
  if (argv.indexOf('--status') >= 0) { console.log(toolStatus()); return; }
  if (argv.indexOf('--once') >= 0) {
    if (!URL_BASE || !KEY) { console.error('Set USAGE_URL and USAGE_KEY (and USAGE_MEMBER).'); process.exit(2); }
    await learnZone();
    const r = await cycle(argv.indexOf('--everything') >= 0, 'once');
    console.log(describe(r));
    process.exit(r.sync.sent || r.sync.upToDate ? 0 : 1);
  }
  if (argv.indexOf('--summary') >= 0) { console.log(await toolSummary({ days: 7 })); return; }
  if (!URL_BASE || !KEY) log('USAGE_URL or USAGE_KEY is not set: usage is counted but cannot be sent');
  serve();
  learnZone();
}
if (require.main === module) main().catch((e) => { log('fatal:', e && e.stack || e); process.exit(1); });
module.exports = { parseLine, readFrom, dayOf, slug, systemString, TOOLS, VERSION };
