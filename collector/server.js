'use strict';
/* Claude usage collector.
   Every PC's Claude Code posts its OpenTelemetry log events here (OTLP over HTTP, JSON). The collector keeps
   per-member daily totals by model, plus the largest sessions, and serves them to the Claude Usage Ledger:
     POST /v1/logs            OTLP logs from Claude Code (x-api-key must equal INGEST_KEY)
     POST /v1/metrics|traces  accepted and dropped, so enabling those exporters does no harm
     GET  /api/usage?key=     the usage feed the ledger reads (READ_KEY, if set)
     GET  /?key=              the ledger itself, live
     GET  /setup?key=         per-PC settings generator
     GET  /healthz            liveness, no secrets
   Node 18.17+, no dependencies. Storage is one JSON file (DATA_DIR/store.json), optionally mirrored to a
   GitHub repository so a host without a persistent disk keeps its history. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const env = process.env;
const PORT = env.PORT === undefined || env.PORT === '' ? 4318 : Number(env.PORT);
const INGEST_KEY = (env.INGEST_KEY || '').trim();
const READ_KEY = (env.READ_KEY || '').trim();
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_BODY = Number(env.MAX_BODY_BYTES) || 8 * 1024 * 1024;
const TEMPLATE = env.LEDGER_TEMPLATE || path.join(__dirname, '..', 'ledger', 'ledger.tpl.html');
const SETUP_FILE = path.join(__dirname, 'setup.html');
const SAVE_DELAY = env.SAVE_DELAY_MS === undefined ? 1500 : Number(env.SAVE_DELAY_MS);
const GH = {
  repo: (env.GITHUB_BACKUP || '').trim(),
  token: (env.GITHUB_TOKEN || '').trim(),
  path: (env.GITHUB_BACKUP_PATH || 'data/usage-store.json').replace(/^\/+/, ''),
  branch: (env.GITHUB_BACKUP_BRANCH || '').trim(),
  api: (env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
  every: Number(env.GITHUB_BACKUP_INTERVAL_MS) || 5 * 60 * 1000,
};
const MAX_SEEN = 60000, MAX_SESSIONS = 400, MAX_MEMBERS = 500, MIN_DATE = '2024-01-01';

function log() { console.log.apply(console, [new Date().toISOString()].concat(Array.prototype.slice.call(arguments))); }

/* ---------- time ---------- */
function pickTZ(name) { if (!name) return null; try { new Intl.DateTimeFormat('en-CA', { timeZone: name }); return name; } catch (e) { return null; } }
const TZ = pickTZ(env.REPORT_TZ) || pickTZ(env.TZ) || 'UTC';
if (env.REPORT_TZ && TZ !== env.REPORT_TZ) log('REPORT_TZ "' + env.REPORT_TZ + '" is not a valid time zone, using ' + TZ);
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function dayOf(ms) { return DAY_FMT.format(new Date(ms)); } /* en-CA formats as YYYY-MM-DD */
function iso(ms) { return new Date(ms).toISOString(); }

/* ---------- store ---------- */
const store = { version: 1, members: {}, days: {}, sessions: {}, seen: [], stats: { events: 0, duplicates: 0, other: 0, skipped: 0, lastEvent: '', lastBatch: '' } };
let seenSet = new Set(), seenList = [];
function adopt(o) {
  if (!o || typeof o !== 'object' || o.version !== 1) return false;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  store.members = obj(o.members); store.days = obj(o.days); store.sessions = obj(o.sessions);
  store.stats = Object.assign(store.stats, obj(o.stats));
  seenList = Array.isArray(o.seen) ? o.seen.filter((x) => typeof x === 'string').slice(-MAX_SEEN) : [];
  seenSet = new Set(seenList);
  return true;
}
function snapshot() { return JSON.stringify(Object.assign({}, store, { seen: seenList })); }
function loadLocal() {
  try { return adopt(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') log('could not read ' + STORE_FILE + ': ' + e.message); return false; }
}
let saveTimer = 0, dirty = false, ghDirty = false;
function saveNow() {
  dirty = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, snapshot());
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) { log('could not save ' + STORE_FILE + ': ' + e.message); }
}
function markDirty() {
  dirty = true; ghDirty = true;
  if (!saveTimer) saveTimer = setTimeout(saveNow, SAVE_DELAY);
}
function remember(key) {
  seenSet.add(key); seenList.push(key);
  if (seenList.length > MAX_SEEN) { const drop = seenList.splice(0, seenList.length - MAX_SEEN); drop.forEach((k) => seenSet.delete(k)); }
}

/* ---------- GitHub mirror (optional) ---------- */
function ghOn() { return !!(GH.repo && GH.token && /^[\w.-]+\/[\w.-]+$/.test(GH.repo)); }
function ghUrl() { return GH.api + '/repos/' + GH.repo + '/contents/' + GH.path.split('/').map(encodeURIComponent).join('/'); }
async function ghFetch(method, body) {
  const headers = { authorization: 'Bearer ' + GH.token, accept: 'application/vnd.github+json', 'user-agent': 'claude-usage-collector', 'x-github-api-version': '2022-11-28' };
  if (body) headers['content-type'] = 'application/json';
  const q = method === 'GET' && GH.branch ? '?ref=' + encodeURIComponent(GH.branch) : '';
  return fetch(ghUrl() + q, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
}
async function ghLoad() {
  const r = await ghFetch('GET');
  if (r.status === 404) return false;
  if (!r.ok) throw new Error('GitHub answered ' + r.status);
  const j = await r.json();
  const text = Buffer.from(String(j.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  if (!adopt(JSON.parse(text))) throw new Error('the file in GitHub is not a usage store');
  return true;
}
let ghBusy = false;
async function ghSave(reason) {
  if (!ghOn() || ghBusy || !ghDirty) return false;
  ghBusy = true;
  try {
    let sha;
    const cur = await ghFetch('GET');
    if (cur.ok) sha = (await cur.json()).sha; else if (cur.status !== 404) throw new Error('GitHub answered ' + cur.status);
    const body = { message: 'usage store ' + new Date().toISOString() + (reason ? ' (' + reason + ')' : ''), content: Buffer.from(snapshot()).toString('base64') };
    if (sha) body.sha = sha;
    if (GH.branch) body.branch = GH.branch;
    const put = await ghFetch('PUT', body);
    if (!put.ok) throw new Error('GitHub answered ' + put.status + ' to the upload');
    ghDirty = false;
    log('mirrored the store to github.com/' + GH.repo + '/' + GH.path);
    return true;
  } catch (e) { log('GitHub mirror failed: ' + e.message); return false; } finally { ghBusy = false; }
}

/* ---------- OTLP parsing ---------- */
function anyVal(v) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return !!v.boolValue;
  if ('arrayValue' in v) return (v.arrayValue && Array.isArray(v.arrayValue.values) ? v.arrayValue.values : []).map(anyVal);
  if ('kvlistValue' in v) return attrs(v.kvlistValue && v.kvlistValue.values);
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}
function attrs(list) {
  const o = {};
  if (Array.isArray(list)) list.forEach((kv) => { if (kv && typeof kv.key === 'string') o[kv.key] = anyVal(kv.value); });
  return o;
}
function str(v, max) { return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max); }
function num(v) { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'number' ? v : Number(String(v).trim()); return Number.isFinite(n) && n >= 0 && n <= 1e15 ? n : null; }
function pct(s) { if (!/%[0-9a-f]{2}/i.test(s)) return s; try { return decodeURIComponent(s); } catch (e) { return s; } }
function sha(s) { return crypto.createHash('sha1').update(s).digest('base64url').slice(0, 20); }
function eventName(rec, a) {
  let n = str(a['event.name'], 80);
  if (!n && rec.body) { const b = anyVal(rec.body); if (typeof b === 'string') n = str(b, 80); }
  return n.replace(/^claude_code\./, '');
}
function normModel(v) {
  let m = str(v, 120).toLowerCase();
  m = m.replace(/^(?:[a-z]{2,3}(?:-[a-z0-9]+)*\.)?anthropic\./, '').replace(/-v\d+:\d+$/, '').replace(/@/g, '-');
  return /^claude-[a-z0-9.-]+$/.test(m) ? m : '';
}
function whenMs(rec, all) {
  const raw = rec.timeUnixNano !== undefined ? rec.timeUnixNano : (rec.time_unix_nano !== undefined ? rec.time_unix_nano : rec.observedTimeUnixNano);
  let ms = NaN;
  if (raw !== undefined && raw !== null && String(raw).length > 6 && /^\d+$/.test(String(raw))) ms = Number(String(raw).slice(0, -6));
  if (!Number.isFinite(ms) || ms <= 0) ms = Date.parse(String(all['event.timestamp'] || ''));
  const now = Date.now();
  if (!Number.isFinite(ms) || ms < Date.parse(MIN_DATE) || ms > now + 36e5) ms = now; /* a clock that is wrong gets today */
  return ms;
}
function memberOf(all) {
  const name = pct(str(all['member.name'], 60)), host = pct(str(all['member.host'], 60)), given = pct(str(all['member.id'], 120));
  const id = given || (name ? 'name:' + name.toLowerCase() : '') || (str(all['user.account_uuid'], 80) ? 'account:' + str(all['user.account_uuid'], 80) : '') || 'user:' + (str(all['user.id'], 80) || 'unknown');
  return {
    id, name, host, email: str(all['user.email'], 120), os: str(all['os.type'], 30), osVersion: str(all['os.version'], 60), arch: str(all['host.arch'], 20),
    version: str(all['service.version'], 30) || str(all['app.version'], 30), terminal: str(all['terminal.type'], 30), wsl: str(all['wsl.version'], 20),
  };
}
function apiRequest(rec, a, res, ip) {
  const all = Object.assign({}, res, a);
  const model = normModel(all.model);
  if (!model) return null;
  const tin = num(all.input_tokens), tout = num(all.output_tokens), cw = num(all.cache_creation_tokens), cr = num(all.cache_read_tokens);
  if ([tin, tout, cw, cr].some((x) => x === null)) return null;
  let cost = num(all.cost_usd_micros);
  cost = cost === null ? num(all.cost_usd) : cost / 1e6;
  if (cost === null) cost = 0;
  const ms = whenMs(rec, all), session = str(all['session.id'], 80);
  const rid = str(all.request_id, 120) || str(all.client_request_id, 120);
  const key = rid ? 'r:' + rid : 'h:' + sha([session, rec.timeUnixNano || rec.time_unix_nano || all['event.timestamp'] || '', model, tin, tout, cw, cr, cost].join('|'));
  return { key, member: memberOf(all), model, tin, tout, cw, cr, cost, ms, day: dayOf(ms), session, ip };
}
function apply(r) {
  let m = store.members[r.member.id];
  if (!m) {
    if (Object.keys(store.members).length >= MAX_MEMBERS) return false;
    m = store.members[r.member.id] = { id: r.member.id, firstSeen: iso(r.ms), events: 0 };
  }
  ['name', 'host', 'email', 'os', 'osVersion', 'arch', 'version', 'terminal', 'wsl'].forEach((k) => { if (r.member[k]) m[k] = r.member[k]; else if (m[k] === undefined) m[k] = ''; });
  const at = iso(r.ms);
  if (!m.lastSeen || at > m.lastSeen) m.lastSeen = at;
  if (r.ip) m.ip = r.ip;
  m.events++;
  const byDay = store.days[r.member.id] || (store.days[r.member.id] = {});
  const byModel = byDay[r.day] || (byDay[r.day] = {});
  const cell = byModel[r.model] || (byModel[r.model] = [0, 0, 0, 0, 0, 0]);
  cell[0] += r.tin; cell[1] += r.tout; cell[2] += r.cw; cell[3] += r.cr; cell[4] += r.cost; cell[5] += 1;
  if (r.session) {
    const s = store.sessions[r.session] || (store.sessions[r.session] = { member: r.member.id, first: at, last: at, models: {}, in: 0, out: 0, cw: 0, cr: 0, cost: 0, n: 0 });
    if (at > s.last) s.last = at; if (at < s.first) s.first = at;
    s.models[r.model] = 1; s.in += r.tin; s.out += r.tout; s.cw += r.cw; s.cr += r.cr; s.cost += r.cost; s.n++;
    const ids = Object.keys(store.sessions);
    if (ids.length > MAX_SESSIONS) ids.sort((a, b) => (store.sessions[a].last < store.sessions[b].last ? -1 : 1)).slice(0, ids.length - MAX_SESSIONS).forEach((id) => { delete store.sessions[id]; });
  }
  store.stats.lastEvent = at;
  return true;
}
function ingest(body, ip) {
  const sum = { records: 0, accepted: 0, duplicates: 0, other: 0, skipped: 0 };
  const rls = Array.isArray(body.resourceLogs) ? body.resourceLogs : (Array.isArray(body.resource_logs) ? body.resource_logs : []);
  rls.forEach((rl) => {
    if (!rl || typeof rl !== 'object') return;
    const res = attrs(rl.resource && rl.resource.attributes);
    const sls = Array.isArray(rl.scopeLogs) ? rl.scopeLogs : (Array.isArray(rl.scope_logs) ? rl.scope_logs : []);
    sls.forEach((sl) => {
      const recs = sl && (Array.isArray(sl.logRecords) ? sl.logRecords : (Array.isArray(sl.log_records) ? sl.log_records : []));
      (recs || []).forEach((rec) => {
        if (!rec || typeof rec !== 'object') return;
        sum.records++;
        const a = attrs(rec.attributes);
        if (eventName(rec, a) !== 'api_request') { sum.other++; return; }
        const r = apiRequest(rec, a, res, ip);
        if (!r) { sum.skipped++; return; }
        if (seenSet.has(r.key)) { sum.duplicates++; return; }
        if (!apply(r)) { sum.skipped++; return; }
        remember(r.key); sum.accepted++;
      });
    });
  });
  store.stats.events += sum.accepted; store.stats.duplicates += sum.duplicates; store.stats.other += sum.other; store.stats.skipped += sum.skipped;
  store.stats.lastBatch = new Date().toISOString();
  markDirty();
  return sum;
}

/* ---------- the usage feed ---------- */
const OS_NAMES = { windows: 'Windows', win32: 'Windows', linux: 'Linux', darwin: 'macOS', macos: 'macOS' };
function labelOf(m) {
  const name = m.name || '', host = m.host || '';
  if (name && host && name.toLowerCase() !== host.toLowerCase()) return name + ' · ' + host;
  return name || host || m.email || 'Unnamed device';
}
function systemOf(m) {
  const os = m.os ? (OS_NAMES[m.os.toLowerCase()] || m.os) + (m.osVersion ? ' ' + m.osVersion : '') : (m.osVersion || '');
  return [os, m.arch, m.wsl ? 'WSL ' + m.wsl : '', m.version ? 'Claude Code ' + m.version : '', m.terminal, m.ip ? 'IP ' + m.ip : ''].filter(Boolean).join(' | ');
}
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function usagePayload() {
  const members = Object.values(store.members).sort((a, b) => labelOf(a).localeCompare(labelOf(b)) || a.id.localeCompare(b.id));
  const used = new Map(), labelById = {};
  const out = members.map((m) => {
    let label = labelOf(m), low = label.toLowerCase(), n = used.get(low) || 0;
    used.set(low, n + 1);
    if (n) label += ' #' + (n + 1);
    labelById[m.id] = label;
    const rows = [];
    const byDay = store.days[m.id] || {};
    Object.keys(byDay).sort().forEach((day) => {
      const byModel = byDay[day];
      Object.keys(byModel).sort().forEach((model) => { const c = byModel[model]; rows.push([day, model, c[0], c[1], c[2], c[3], round6(c[4])]); });
    });
    return { id: m.id, label, name: m.name || '', host: m.host || '', system: systemOf(m), lastSeen: m.lastSeen || '', events: m.events || 0, rows };
  });
  const sessions = Object.keys(store.sessions).map((id) => {
    const s = store.sessions[id];
    return { pc: labelById[s.member] || '', id, last: s.last, models: Object.keys(s.models).sort(), out: s.out, all: s.in + s.out + s.cw + s.cr, cost: round6(s.cost) };
  }).filter((s) => s.pc).sort((a, b) => b.cost - a.cost).slice(0, 50);
  return { ok: true, generated: new Date().toISOString(), tz: TZ, members: out, sessions, stats: store.stats };
}

/* ---------- pages ---------- */
let tplCache = null, tplMtime = 0;
function template() {
  const st = fs.statSync(TEMPLATE);
  if (!tplCache || st.mtimeMs !== tplMtime) { tplCache = fs.readFileSync(TEMPLATE, 'utf8'); tplMtime = st.mtimeMs; }
  if (tplCache.indexOf('/*__SEED__*/null') < 0 || tplCache.indexOf('/*__LIVE__*/null') < 0) throw new Error('template placeholders missing');
  return tplCache;
}
function dashboardHTML() {
  const seed = JSON.stringify({ generated: dayOf(Date.now()), pcs: [], sessions: [] }).replace(/</g, '\\u003c');
  const live = JSON.stringify({ embedded: true, tz: TZ });
  const page = template().replace('/*__SEED__*/null', () => seed).replace('/*__LIVE__*/null', () => live);
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' + page + '\n</html>\n';
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function keyPage(what) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Read key needed</title>' +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40em;margin:12vh auto;padding:0 16px;color:#222;background:#fff}code{background:#f2f2f2;padding:2px 5px;border-radius:3px}@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}code{background:#2a2a2a}}</style></head>' +
    '<body><h1>Read key needed</h1><p>' + esc(what) + ' opens only with the collector’s read key. Add it to the address, like <code>/?key=READ_KEY</code>. The key is the <code>READ_KEY</code> value in the collector’s environment.</p></body></html>';
}

/* ---------- http ---------- */
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function bearer(h) { const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(String(h || '')); return m ? m[1] : ''; }
function ingestOK(req) {
  const k = req.headers['x-api-key'] || bearer(req.headers.authorization) || '';
  return !!k && safeEq(k, INGEST_KEY);
}
function readOK(req, u) {
  if (!READ_KEY) return true;
  const k = u.searchParams.get('key') || req.headers['x-read-key'] || bearer(req.headers.authorization) || '';
  return !!k && safeEq(k, READ_KEY);
}
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : '';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => {
      size += c.length;
      if (over) { if (size > 4 * MAX_BODY) req.destroy(); return; } /* drain a little so the 413 can be delivered, cut off a flood */
      if (size > MAX_BODY) { over = true; chunks.length = 0; const e = new Error('body larger than ' + MAX_BODY + ' bytes'); e.code = 'too_large'; reject(e); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let buf = Buffer.concat(chunks);
      const enc = String(req.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc.includes('gzip')) buf = zlib.gunzipSync(buf); else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
      } catch (e) { reject(new Error('could not decompress the body')); return; }
      resolve(buf.toString('utf8'));
    });
    req.on('error', reject);
  });
}
function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, content-encoding, x-api-key, x-read-key, authorization');
  res.setHeader('access-control-max-age', '600');
}
function send(res, code, body, headers) {
  const h = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {});
  res.writeHead(code, h); res.end(JSON.stringify(body));
}
function html(res, code, text) { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(text); }

async function handle(req, res) {
  cors(res);
  let u;
  try { u = new URL(req.url, 'http://local'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (method === 'GET' && p === '/healthz') {
    return send(res, 200, { ok: true, members: Object.keys(store.members).length, events: store.stats.events, lastEvent: store.stats.lastEvent, tz: TZ, uptimeSeconds: Math.round(process.uptime()), mirror: ghOn() ? GH.repo : '' });
  }
  if (method === 'POST' && /^\/v1\/(logs|metrics|traces)$/.test(p)) {
    if (!ingestOK(req)) return send(res, 401, { error: 'The x-api-key header does not match the collector’s INGEST_KEY.' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('protobuf') || ct.includes('grpc')) return send(res, 415, { error: 'This collector reads OTLP JSON. Set OTEL_EXPORTER_OTLP_PROTOCOL to http/json.' });
    let text;
    try { text = await readBody(req); } catch (e) { return send(res, e.code === 'too_large' ? 413 : 400, { error: e.message }, { connection: 'close' }); }
    let body;
    try { body = JSON.parse(text); } catch (e) { return send(res, 400, { error: 'The body is not JSON.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'The body is not an OTLP export request.' });
    if (p !== '/v1/logs') return send(res, 200, {});
    const sum = ingest(body, clientIp(req));
    if (sum.records) log('logs from ' + (clientIp(req) || '?') + ': ' + sum.records + ' records, ' + sum.accepted + ' api requests kept' + (sum.duplicates ? ', ' + sum.duplicates + ' duplicates' : '') + (sum.skipped ? ', ' + sum.skipped + ' unusable' : ''));
    return send(res, 200, {});
  }
  if (method === 'GET' && p === '/api/usage') {
    if (!readOK(req, u)) return send(res, 401, { error: 'A read key is needed: add ?key=READ_KEY.' });
    return send(res, 200, usagePayload());
  }
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    if (!readOK(req, u)) return html(res, 401, keyPage('The dashboard'));
    try { return html(res, 200, dashboardHTML()); } catch (e) { log('dashboard unavailable: ' + e.message); return html(res, 503, '<!doctype html><meta charset="utf-8"><title>Dashboard unavailable</title><p>The ledger template is missing on this server (' + esc(TEMPLATE) + '). The usage feed at /api/usage still works.'); }
  }
  if (method === 'GET' && p === '/setup') {
    if (!readOK(req, u)) return html(res, 401, keyPage('The setup page'));
    try { return html(res, 200, fs.readFileSync(SETUP_FILE, 'utf8')); } catch (e) { return html(res, 503, '<!doctype html><meta charset="utf-8"><title>Setup page missing</title><p>setup.html is missing on this server.'); }
  }
  if (method === 'GET' && p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
  if (method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  return send(res, 404, { error: 'not found' });
}

/* ---------- start ---------- */
async function main() {
  if (!INGEST_KEY) { console.error('INGEST_KEY is not set. Every PC sends this key in the x-api-key header; choose a long random value.'); process.exit(1); }
  if (!READ_KEY) log('READ_KEY is empty, so the dashboard and /api/usage are open to anyone who knows the address.');
  if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) { console.error('PORT must be a number between 0 and 65535'); process.exit(1); }
  const local = loadLocal();
  if (local) log('loaded ' + Object.keys(store.members).length + ' members from ' + STORE_FILE);
  else if (ghOn()) {
    try { if (await ghLoad()) { log('loaded ' + Object.keys(store.members).length + ' members from github.com/' + GH.repo + '/' + GH.path); saveNow(); } else log('no store in GitHub yet, starting empty'); }
    catch (e) { log('could not load the store from GitHub: ' + e.message + '. Starting empty; nothing is uploaded until new usage arrives.'); }
  } else log('starting with an empty store');
  if (GH.repo && !ghOn()) log('GITHUB_BACKUP is set but GITHUB_TOKEN is missing or the repo is not owner/name: the mirror is off');
  try { template(); } catch (e) { log('ledger template not found at ' + TEMPLATE + ': the dashboard page is off, the usage feed still works'); }
  if (ghOn()) setInterval(() => { ghSave('scheduled'); }, GH.every).unref();

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { log('error: ' + (e && e.stack || e)); if (!res.headersSent) send(res, 500, { error: 'internal error' }); else res.end(); }); });
  server.requestTimeout = 30000;
  server.listen(PORT, () => {
    log('collector listening on port ' + server.address().port + ' (zone ' + TZ + ', data in ' + DATA_DIR + (ghOn() ? ', mirrored to github.com/' + GH.repo : '') + ')');
  });
  let stopping = false;
  async function stop(sig) {
    if (stopping) return; stopping = true;
    log(sig + ': saving and shutting down');
    server.close();
    if (dirty) saveNow();
    if (ghDirty) await Promise.race([ghSave('shutdown'), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(0);
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
if (require.main === module) main();
module.exports = { ingest, usagePayload, normModel, memberOf, anyVal, attrs };
