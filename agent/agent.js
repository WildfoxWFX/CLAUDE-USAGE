#!/usr/bin/env node
'use strict';
/* Claude usage agent: a stdio MCP server that Claude Code starts on this PC.
   It reads this PC's own Claude Code conversation logs (the files ccusage reads), keeps per-day, per-model
   totals and per-session totals, and sends what changed to the collector on your server: on start, every minute
   while Claude Code runs, and when Claude Code exits. The collector replaces what it holds for the days sent, so
   sending twice never counts twice and a lost state file only costs a full re-send.
   Counting follows ccusage (one API response = one record, the streamed chunk with the largest usage wins,
   fast-mode requests are priced as <model>-fast), plus Claude Code's own per-session ledger (the cost-state
   records), which also counts the subagent output tokens the per-message records understate.
   It also forwards the account's rate-limit usage (the 5-hour and weekly windows, as percentages) that Claude Code
   hands to its status line after every reply: `node agent.js --setup` registers `node agent.js --statusline` as the
   status line (keeping any status line that was there, which it keeps running), the status line saves the figures
   to a file, and the agent sends them to the collector. No login token is read and no undocumented endpoint is
   called. USAGE_LIMITS=0 switches the forwarding off.
   Tools offered to Claude: usage_sync_now, usage_status, usage_summary.
   Also runs by hand: node agent.js --once (scan, send, print a summary), --once --everything, --status, --summary,
   --limits (send the last status-line reading), --setup (register the status line).
   Node 18+, no dependencies. Everything on stdout is MCP; logs go to stderr. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VERSION = '1.3.0';
const env = process.env;
const URL_BASE = (env.USAGE_URL || '').trim().replace(/\/+$/, '');
const KEY = (env.USAGE_KEY || '').trim();
const READ_KEY = (env.USAGE_READ_KEY || '').trim() || KEY;
/* names arrive percent-encoded from the install command (no quoting trouble in PowerShell or bash); decode them */
function pct(s) { if (!/%[0-9a-f]{2}/i.test(s)) return s; try { return decodeURIComponent(s); } catch (e) { return s; } }
const MEMBER = pct(env.USAGE_MEMBER || '').replace(/\s+/g, ' ').trim().slice(0, 60) || safeUser();
const HOST = pct(env.USAGE_HOST || '').replace(/\s+/g, ' ').trim().slice(0, 60) || os.hostname().split('.')[0];
/* where the logs are: USAGE_CLAUDE_DIR or CLAUDE_CONFIG_DIR (comma-separated), else ~/.claude and ~/.config/claude like ccusage */
const ROOTS_GIVEN = (env.USAGE_CLAUDE_DIR || env.CLAUDE_CONFIG_DIR || '').split(',').map((s) => s.trim()).filter(Boolean);
const CLAUDE_ROOTS = ROOTS_GIVEN.length ? ROOTS_GIVEN : [path.join(os.homedir(), '.claude'), path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude')];
const CLAUDE_DIR = CLAUDE_ROOTS.join(', ');
const STATE_DIR = env.USAGE_STATE_DIR || path.join(os.homedir(), '.claude-usage');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const INTERVAL = Math.max(10000, Number(env.USAGE_INTERVAL_MS) || 60000);
const TZ_OVERRIDE = (env.USAGE_TZ || '').trim();
const USE_LEDGER = env.USAGE_LEDGER !== '0';
const LIMITS_ON = env.USAGE_LIMITS !== '0';
const LIMITS_FILE = path.join(STATE_DIR, 'limits.json'); /* written by the status line, read by the agent */
const PREV_STATUSLINE_FILE = path.join(STATE_DIR, 'statusline.json'); /* the status line that was there before --setup */
const LIMITS_EVERY = Math.max(10000, Number(env.USAGE_LIMITS_INTERVAL_MS) || 60000);
const MAX_SESSIONS = 1000, TAIL = 16, MIN_DATE = '2024-01-01', FREEZE_AFTER_DAYS = 2;

function safeUser() { try { return os.userInfo().username; } catch (e) { return 'unknown'; } }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member'; }
const MEMBER_ID = slug(MEMBER) + '@' + HOST.toLowerCase();
const LABEL = MEMBER.toLowerCase() === HOST.toLowerCase() ? MEMBER : MEMBER + ' · ' + HOST; /* as the dashboard shows it */
function log() { process.stderr.write(new Date().toISOString() + ' claude-usage: ' + Array.prototype.join.call(arguments, ' ') + '\n'); }

/* ---------- time ---------- */
function validTZ(name) { if (!name) return ''; try { new Intl.DateTimeFormat('en', { timeZone: name }); return name; } catch (e) { return ''; } }
let dayFmt = null, dayFmtZone = null;
function dayOf(ms, zone) {
  if (!dayFmt || dayFmtZone !== zone) { dayFmt = new Intl.DateTimeFormat('en', Object.assign({ year: 'numeric', month: '2-digit', day: '2-digit' }, zone ? { timeZone: zone } : {})); dayFmtZone = zone; }
  const p = {};
  dayFmt.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
}
function daysAgo(n, zone) { return dayOf(Date.now() - n * 86400000, zone); }

/* ---------- state ---------- */
function emptyState() {
  return { v: 2, url: URL_BASE, member: MEMBER_ID, token: '', tz: '', files: {}, days: {}, sessions: {}, sessDays: {}, ledgers: {}, frozenDays: [], retract: null, zeroRows: [], limitsSentFor: '',
    dirtyDays: [], dirtySessions: [], full: true, lastActivity: '', lastScan: '', lastSync: '', lastSyncOk: '', lastError: '', fails: 0, nextTry: 0, sent: 0 };
}
let state = emptyState();
let keySet = new Map(); /* message key -> { out: output tokens counted so far, day, file } */
function rebuildKeys() {
  keySet = new Map();
  Object.keys(state.files).forEach((f) => { (state.files[f].tail || []).forEach((k) => { keySet.set(k[0], { out: k[1], day: k[2], file: f }); }); });
}
function markAllDirty() {
  state.dirtyDays = Object.keys(state.days).filter((d) => state.frozenDays.indexOf(d) < 0);
  state.dirtySessions = Object.keys(state.sessions);
  state.full = true;
}
function loadState() {
  let loaded = false;
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (o && o.v === 2 && o.days && o.files) { state = Object.assign(emptyState(), o); loaded = true; }
    else if (o && o.v === 1) { log('state file from an older agent, counting again'); }
  } catch (e) { if (e.code !== 'ENOENT') log('state file unreadable, starting over:', e.message); }
  if (!loaded) state = emptyState();
  rebuildKeys();
  /* data sent under another name or to another collector must go again in full */
  if (state.url !== URL_BASE || state.member !== MEMBER_ID) {
    if (loaded) log('collector or name changed: everything will be sent again');
    state.url = URL_BASE; state.member = MEMBER_ID; state.token = ''; markAllDirty();
  }
  if (!state.token) state.token = makeToken();
  return loaded;
}
/* a secret only this PC knows, so no other PC with the shared ingest key can post as this one:
   derived from Claude Code's anonymous install id when available, else random and kept in the state file */
function makeToken() {
  let seed = '';
  for (const root of CLAUDE_ROOTS) {
    try { const j = JSON.parse(fs.readFileSync(path.join(path.basename(root) === 'projects' ? path.dirname(root) : root, '.claude.json'), 'utf8')); if (j && typeof j.userID === 'string' && j.userID) { seed = j.userID; break; } } catch (e) {}
  }
  if (!seed) { try { seed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).userID || ''; } catch (e) {} }
  if (seed) return crypto.createHash('sha256').update('claude-usage:' + seed + ':' + MEMBER_ID).digest('hex');
  return crypto.randomBytes(24).toString('hex');
}
function saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log('could not save state:', e.message); }
}
function pairsNow() { const out = []; Object.keys(state.days).forEach((d) => { Object.keys(state.days[d]).forEach((m) => out.push(d + '|' + m)); }); return out; }
function resetTotals() {
  state.files = {}; state.days = {}; state.sessions = {}; state.sessDays = {}; state.ledgers = {}; keySet = new Map();
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
function listLogs() {
  const out = [];
  CLAUDE_ROOTS.forEach((root) => { walk(path.basename(root) === 'projects' ? root : path.join(root, 'projects'), out); });
  return out;
}
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
  let model = typeof m.model === 'string' ? m.model.trim().toLowerCase() : '';
  if (!/^claude-/.test(model)) return null;
  if (u.speed === 'fast') model += '-fast'; /* fast mode is billed as a dearer model */
  const ms = Date.parse(o.timestamp);
  if (!Number.isFinite(ms) || ms < Date.parse(MIN_DATE)) return null;
  /* a real message id is unique per API response (and shared by every streamed chunk of it); anything else is scoped by request */
  const id = typeof m.id === 'string' && m.id ? m.id : '';
  const key = /^msg_/.test(id) ? id : (id || 'u:' + o.uuid) + ':' + (typeof o.requestId === 'string' ? o.requestId : '');
  const cw = num(u.cache_creation_input_tokens), cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  return {
    key, ms, model, in: num(u.input_tokens), out: num(u.output_tokens), cw, cr: num(u.cache_read_input_tokens),
    cw1h: Math.min(cw, cc ? num(cc.ephemeral_1h_input_tokens) : 0),
    session: typeof o.sessionId === 'string' && o.sessionId ? o.sessionId.slice(0, 80) : '',
  };
}
/* Claude Code's own running total for a session (type "cost-state"): per model, input/output/cache tokens including
   the subagents' work. The per-message records understate subagent output tokens, so this ledger lifts them. */
function parseLedger(line) {
  if (line.indexOf('"cost-state"') < 0) return null;
  let o;
  try { o = JSON.parse(line); } catch (e) { return null; }
  if (!o || o.type !== 'cost-state' || typeof o.sessionId !== 'string' || !o.sessionId || !o.modelUsage || typeof o.modelUsage !== 'object') return null;
  const models = {};
  Object.keys(o.modelUsage).forEach((k) => {
    const v = o.modelUsage[k], model = String(k).trim().toLowerCase();
    if (!/^claude-/.test(model) || !v || typeof v !== 'object') return;
    models[model] = [num(v.inputTokens), num(v.outputTokens), num(v.cacheCreationInputTokens), num(v.cacheReadInputTokens)];
  });
  return Object.keys(models).length ? { session: o.sessionId.slice(0, 80), models } : null;
}
/* the keys of a file's last messages: chunks of one response are always in the same file, in order */
function remember(fe, file, key, out, day) {
  const prev = keySet.get(key);
  if (prev) { prev.out = out; const t = (state.files[prev.file] || {}).tail || []; const i = t.findIndex((k) => k[0] === key); if (i >= 0) t[i][1] = out; return; }
  keySet.set(key, { out, day, file }); fe.tail.push([key, out, day]);
  if (fe.tail.length > TAIL) { const drop = fe.tail.shift(); const cur = keySet.get(drop[0]); if (cur && cur.file === file) keySet.delete(drop[0]); }
}
function markDirty(list, v) { if (list.indexOf(v) < 0) list.push(v); }
/* extra: true when r is a later chunk of a message already counted; then only the additional output tokens count,
   on the day of the first chunk (one response can stream for minutes) */
function applyRecord(r, day, extra, fe) {
  const byModel = state.days[day] || (state.days[day] = {});
  const c = byModel[r.model] || (byModel[r.model] = [0, 0, 0, 0, 0, 0]); /* in, out, cw, cr, n, cw1h */
  if (extra) c[1] += r.out; else { c[0] += r.in; c[1] += r.out; c[2] += r.cw; c[3] += r.cr; c[4] += 1; c[5] += r.cw1h; }
  markDirty(state.dirtyDays, day);
  if (fe && fe.days.indexOf(day) < 0) fe.days.push(day);
  const at = new Date(r.ms).toISOString();
  if (!state.lastActivity || at > state.lastActivity) state.lastActivity = at;
  if (r.session) {
    const s = state.sessions[r.session] || (state.sessions[r.session] = { first: at, last: at, models: {}, n: 0 });
    if (at > s.last) s.last = at; if (at < s.first) s.first = at;
    const sm = s.models[r.model] || (s.models[r.model] = [0, 0, 0, 0, 0]);
    if (extra) sm[1] += r.out; else { sm[0] += r.in; sm[1] += r.out; sm[2] += r.cw; sm[3] += r.cr; sm[4] += r.cw1h; s.n++; }
    const sd = state.sessDays[r.session] || (state.sessDays[r.session] = {});
    const sdd = sd[day] || (sd[day] = {});
    const sdm = sdd[r.model] || (sdd[r.model] = [0, 0, 0, 0]);
    if (extra) sdm[1] += r.out; else { sdm[0] += r.in; sdm[1] += r.out; sdm[2] += r.cw; sdm[3] += r.cr; }
    markDirty(state.dirtySessions, r.session);
    if (state.ledgers[r.session]) Object.keys(sd).forEach((d) => markDirty(state.dirtyDays, d)); /* the ledger's lift is shared across the session's days */
    trimSessions();
  }
}
function trimSessions() {
  const ids = Object.keys(state.sessions);
  if (ids.length <= MAX_SESSIONS) return;
  ids.sort((a, b) => (state.sessions[a].last < state.sessions[b].last ? -1 : 1)).slice(0, ids.length - MAX_SESSIONS).forEach((id) => { delete state.sessions[id]; delete state.sessDays[id]; delete state.ledgers[id]; });
}
function applyLedger(l) {
  if (!USE_LEDGER) return;
  const prev = state.ledgers[l.session];
  if (prev && JSON.stringify(prev.models) === JSON.stringify(l.models)) return;
  state.ledgers[l.session] = { models: l.models };
  const sd = state.sessDays[l.session];
  if (sd) Object.keys(sd).forEach((d) => markDirty(state.dirtyDays, d));
  if (state.sessions[l.session]) markDirty(state.dirtySessions, l.session);
}
/* per session and model, how much the ledger has above what the records gave; shared out over the session's days in
   proportion to what each day had. Never subtracts: a ledger written before the latest records simply lifts nothing. */
function ledgerLift() {
  const lift = {}; /* day -> model -> [in, out, cw, cr] */
  if (!USE_LEDGER) return lift;
  Object.keys(state.ledgers).forEach((sid) => {
    const sd = state.sessDays[sid]; if (!sd) return;
    const days = Object.keys(sd);
    Object.keys(state.ledgers[sid].models).forEach((model) => {
      const L = state.ledgers[sid].models[model], tot = [0, 0, 0, 0], have = days.filter((d) => sd[d][model]);
      if (!have.length) return;
      have.forEach((d) => { for (let k = 0; k < 4; k++) tot[k] += sd[d][model][k]; });
      for (let k = 0; k < 4; k++) {
        const deficit = L[k] - tot[k];
        if (deficit <= 0) continue;
        let given = 0;
        have.forEach((d, i) => {
          const share = i === have.length - 1 ? deficit - given : Math.round(deficit * (tot[k] ? sd[d][model][k] / tot[k] : 1 / have.length));
          given += share;
          const dl = lift[d] || (lift[d] = {}), ml = dl[model] || (dl[model] = [0, 0, 0, 0]);
          ml[k] += share;
        });
      }
    });
  });
  return lift;
}
function dayRow(day, model, lift) {
  const c = state.days[day][model], l = lift[day] && lift[day][model] ? lift[day][model] : [0, 0, 0, 0];
  return [day, model, c[0] + l[0], c[1] + l[1], c[2] + l[2], c[3] + l[3], c[4], c[5]];
}
function sessionRow(id) {
  const s = state.sessions[id], L = state.ledgers[id], byModel = {};
  Object.keys(s.models).forEach((m) => {
    const v = s.models[m].slice(), lv = L && L.models[m];
    if (lv) for (let k = 0; k < 4; k++) v[k] = Math.max(v[k], lv[k]);
    byModel[m] = v;
  });
  if (L) Object.keys(L.models).forEach((m) => { if (!byModel[m]) byModel[m] = L.models[m].concat([0]); });
  return { id, first: s.first, last: s.last, n: s.n, byModel };
}
/* scan the logs; incremental unless a file shrank or vanished or the day zone changed, then from scratch.
   Days that a vanished file covered can only shrink (Claude Code deletes logs older than its retention), so old ones
   are frozen: never sent again, the collector keeps what it has. */
function scan(reason) {
  const zone = state.tz || '';
  let files = listLogs(), records = 0, restarted = false;
  const seen = new Set(files);
  const gone = Object.keys(state.files).filter((f) => !seen.has(f));
  if (gone.length) {
    const cutoff = daysAgo(FREEZE_AFTER_DAYS, zone);
    gone.forEach((f) => { (state.files[f].days || []).forEach((d) => { if (d < cutoff) markDirty(state.frozenDays, d); }); });
    log(gone.length + ' log file(s) gone, recounting everything' + (state.frozenDays.length ? ' (' + state.frozenDays.length + ' old day(s) kept as the collector has them)' : ''));
    resetTotals(); restarted = true;
  }
  for (let pass = 0; pass < 2; pass++) {
    let again = false;
    for (const f of files) {
      let st;
      try { st = fs.statSync(f); } catch (e) { continue; }
      const fe = state.files[f] || (state.files[f] = { offset: 0, size: 0, mtime: 0, tail: [], days: [] });
      if (fe.size === st.size && fe.mtime === st.mtimeMs && fe.offset) continue;
      let r;
      try { r = readFrom(f, fe.offset); } catch (e) { log('cannot read', f, e.message); continue; }
      if (r.shrunk) { log(path.basename(f) + ' shrank, recounting everything'); resetTotals(); again = true; break; }
      for (const line of r.lines) {
        const rec = parseLine(line);
        if (!rec) { const l = parseLedger(line); if (l) applyLedger(l); continue; }
        const seenRec = keySet.get(rec.key);
        if (seenRec) {
          /* streamed chunks repeat the message with the same input and cache counts; the output count only grows */
          if (rec.out > seenRec.out) { const was = seenRec.out; remember(fe, f, rec.key, rec.out, seenRec.day); applyRecord(Object.assign({}, rec, { out: rec.out - was }), seenRec.day, true, fe); }
          continue;
        }
        const day = dayOf(rec.ms, zone);
        remember(fe, f, rec.key, rec.out, day); applyRecord(rec, day, false, fe); records++;
      }
      fe.offset = r.nextOffset; fe.size = st.size; fe.mtime = st.mtimeMs;
    }
    if (!again) break;
    restarted = true; records = 0; files = listLogs();
  }
  /* after a zone change: the (day, model) rows that no longer exist must be removed on the collector */
  if (state.retract) {
    const now = new Set(pairsNow());
    state.retract.forEach((p) => { if (!now.has(p) && state.frozenDays.indexOf(p.split('|')[0]) < 0 && state.zeroRows.indexOf(p) < 0) state.zeroRows.push(p); });
    state.retract = null;
  }
  state.dirtyDays = state.dirtyDays.filter((d) => state.frozenDays.indexOf(d) < 0);
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
  const o = Object.assign({ signal: AbortSignal.timeout(timeoutMs || 20000) }, opts || {});
  o.headers = Object.assign({ connection: 'close' }, o.headers || {}); /* no lingering socket, so a one-shot run ends by itself */
  const r = await fetch(url, o);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, ok: r.ok, json, text };
}
async function learnZone() {
  if (TZ_OVERRIDE) { setZone(validTZ(TZ_OVERRIDE) || ''); return true; }
  if (!URL_BASE) return false;
  try {
    const r = await fetchJSON(URL_BASE + '/healthz', {}, 8000);
    if (r.ok && r.json && typeof r.json.tz === 'string' && validTZ(r.json.tz)) { setZone(r.json.tz); return true; }
  } catch (e) { /* keep the zone we have */ }
  return false;
}
function setZone(zone) {
  if (zone === state.tz) return;
  const had = Object.keys(state.files).length > 0;
  log('day boundaries follow ' + (zone || 'this PC’s zone') + (had ? ', recounting' : ''));
  state.tz = zone;
  if (had) { state.retract = (state.retract || []).concat(pairsNow()); resetTotals(); }
}
function sendableDays() { return Object.keys(state.days).filter((d) => state.frozenDays.indexOf(d) < 0).sort(); }
function payload(everything) {
  const lift = ledgerLift(), days = [];
  const dayList = everything ? sendableDays() : state.dirtyDays.filter((d) => state.days[d] && state.frozenDays.indexOf(d) < 0);
  dayList.forEach((day) => { const bm = state.days[day]; Object.keys(bm).sort().forEach((m) => days.push(dayRow(day, m, lift))); });
  state.zeroRows.forEach((p) => { const i = p.indexOf('|'); days.push([p.slice(0, i), p.slice(i + 1), 0, 0, 0, 0, 0, 0]); });
  const sessionIds = everything ? Object.keys(state.sessions) : state.dirtySessions.filter((id) => state.sessions[id]);
  return { agent: { version: VERSION, node: process.version }, member: { id: MEMBER_ID, name: MEMBER, host: HOST, system: systemString(), lastActivity: state.lastActivity, token: state.token },
    tz: state.tz, full: !!(everything || state.full), days, sessions: sessionIds.map(sessionRow) };
}
async function sync(force) {
  if (!URL_BASE || !KEY) return { sent: false, error: 'USAGE_URL and USAGE_KEY are not set' };
  if (!state.dirtyDays.length && !state.dirtySessions.length && !state.zeroRows.length && !force) return { sent: false, upToDate: true };
  if (!force && state.nextTry && Date.now() < state.nextTry) return { sent: false, waiting: true, error: state.lastError };
  const body = payload(!!force);
  state.lastSync = new Date().toISOString();
  try {
    const r = await fetchJSON(URL_BASE + '/v1/usage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body) }, 30000);
    if (!r.ok) throw new Error('the collector answered ' + r.status + (r.json && r.json.error ? ': ' + r.json.error : ''));
    state.dirtyDays = []; state.dirtySessions = []; state.zeroRows = []; state.full = false; state.fails = 0; state.nextTry = 0; state.lastError = ''; state.lastSyncOk = state.lastSync; state.sent++;
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
    try {
      let s = scan(reason), r = await sync(force);
      if (state.retract) { s = scan('zone'); r = await sync(force); } /* the reply changed the zone: recount and send again now */
      const l = await syncLimits(force);
      return { scan: s, sync: r, limits: l };
    } finally { busy = null; }
  })();
  return busy;
}

/* ---------- the account's rate-limit meter, from Claude Code's status line ---------- */
/* Claude Code pipes a JSON document to its status-line command after each reply; for a claude.ai subscription it
   includes rate_limits.five_hour / seven_day with used_percentage (0-100) and resets_at (epoch seconds). */
const limitsState = { at: 0, windows: null, error: '', lastLogged: '' }; /* which reading was sent last lives in the state file */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function parseStatusWindows(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const names = { five_hour: 'fiveHour', seven_day: 'sevenDay', seven_day_opus: 'sevenDayOpus', seven_day_sonnet: 'sevenDaySonnet' };
  const out = {};
  Object.keys(names).forEach((k) => {
    const w = rl[k];
    if (!w || typeof w !== 'object') return;
    const u = Number(w.used_percentage !== undefined ? w.used_percentage : w.utilization);
    if (!Number.isFinite(u)) return;
    const ra = w.resets_at !== undefined ? w.resets_at : w.resetsAt;
    let resetsAt = '';
    if (typeof ra === 'number' && Number.isFinite(ra) && ra > 0) resetsAt = new Date(ra < 1e12 ? ra * 1000 : ra).toISOString();
    else if (typeof ra === 'string' && Number.isFinite(Date.parse(ra))) resetsAt = new Date(Date.parse(ra)).toISOString();
    out[names[k]] = { pct: Math.max(0, Math.min(100, Math.round(u * 10) / 10)), resetsAt };
  });
  return Object.keys(out).length ? out : null;
}
function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { text += c; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
    setTimeout(() => resolve(text), 3000).unref();
  });
}
function readPrevStatusLine() {
  try { const j = JSON.parse(fs.readFileSync(PREV_STATUSLINE_FILE, 'utf8')); return j && typeof j.command === 'string' && j.command.trim() ? j.command : ''; } catch (e) { return ''; }
}
function shortReset(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? d + 'd ' + h + 'h' : (h ? h + 'h ' + mm + 'm' : mm + 'm');
}
/* the status line itself: save the figures, then show the previous status line's output, or a short line of our own */
async function statusLine() {
  const text = await readStdin();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  const windows = j ? parseStatusWindows(j.rate_limits) : null;
  if (windows) { try { writeAtomic(LIMITS_FILE, JSON.stringify({ at: new Date().toISOString(), windows, model: j.model && typeof j.model.display_name === 'string' ? j.model.display_name.slice(0, 40) : '' })); } catch (e) {} }
  const prev = readPrevStatusLine();
  if (prev) {
    const { spawn } = require('child_process');
    const child = spawn(prev, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
    child.on('error', () => { process.exitCode = 0; });
    child.on('exit', (code) => { process.exitCode = code || 0; });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
    return;
  }
  if (!windows) return; /* nothing to say yet */
  const parts = [];
  if (windows.fiveHour) parts.push('5h ' + Math.round(windows.fiveHour.pct) + '%' + (windows.fiveHour.resetsAt ? ' (' + shortReset(windows.fiveHour.resetsAt) + ')' : ''));
  if (windows.sevenDay) parts.push('week ' + Math.round(windows.sevenDay.pct) + '%' + (windows.sevenDay.resetsAt ? ' (' + shortReset(windows.sevenDay.resetsAt) + ')' : ''));
  process.stdout.write('Claude limits: ' + parts.join(' · ') + '\n');
}
/* register the status line in the user-level settings file, keeping whatever other settings and status line exist */
function settingsFile() {
  const root = CLAUDE_ROOTS[0];
  return path.join(path.basename(root) === 'projects' ? path.dirname(root) : root, 'settings.json');
}
function ourStatusCommand() { return 'node "' + __filename + '" --statusline'; }
function setupStatusLine() {
  const file = settingsFile();
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('could not read ' + file + ': ' + e.message); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  const cur = s.statusLine, ours = ourStatusCommand();
  let kept = '';
  if (cur && typeof cur === 'object' && cur.type === 'command' && typeof cur.command === 'string' && cur.command.trim() && cur.command.indexOf('--statusline') < 0) {
    kept = cur.command;
    writeAtomic(PREV_STATUSLINE_FILE, JSON.stringify({ command: kept, savedAt: new Date().toISOString() }));
  }
  const next = { type: 'command', command: ours };
  if (cur && typeof cur === 'object' && cur.padding !== undefined) next.padding = cur.padding;
  s.statusLine = next;
  writeAtomic(file, JSON.stringify(s, null, 2) + '\n');
  return { file, kept, previous: readPrevStatusLine() };
}
function readLimitsFile() {
  try {
    const j = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'));
    if (j && j.windows && typeof j.windows === 'object' && typeof j.at === 'string' && Number.isFinite(Date.parse(j.at))) return j;
  } catch (e) {}
  return null;
}
function limitsLog(msg) { if (msg !== limitsState.lastLogged) { log(msg); limitsState.lastLogged = msg; } }
/* send the status line's latest reading when it is new; force sends it again */
async function syncLimits(force) {
  if (!LIMITS_ON || !URL_BASE || !KEY) return { skipped: true };
  const f = readLimitsFile();
  if (!f) { limitsState.error = 'no reading yet: Claude Code gives one to the status line after its first reply in a session (run node agent.js --setup once)'; return { error: limitsState.error }; }
  limitsState.windows = f.windows; limitsState.readAt = f.at;
  if (!force && (f.at === state.limitsSentFor || Date.now() - limitsState.at < LIMITS_EVERY)) return { skipped: true };
  limitsState.at = Date.now();
  try {
    const sent = await fetchJSON(URL_BASE + '/v1/limits', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ member: { id: MEMBER_ID, token: state.token }, limits: { plan: '', checkedAt: f.at, windows: f.windows } }) }, 20000);
    if (!sent.ok) throw new Error('the collector answered ' + sent.status + (sent.json && sent.json.error ? ': ' + sent.json.error : ''));
    state.limitsSentFor = f.at; limitsState.error = ''; saveState();
    limitsLog('account limits: ' + Object.keys(f.windows).map((k) => k + ' ' + f.windows[k].pct + '%').join(', ') + ' (read ' + f.at + ')');
    return { sent: true, windows: f.windows };
  } catch (e) { limitsState.error = e.message; limitsLog('account limits: ' + e.message); return { error: e.message }; }
}
function limitsText() {
  if (!LIMITS_ON) return 'Account limits: off (USAGE_LIMITS=0).';
  const f = readLimitsFile();
  if (f) {
    const names = { fiveHour: '5-hour window', sevenDay: 'weekly', sevenDayOpus: 'weekly Opus', sevenDaySonnet: 'weekly Sonnet' };
    return 'Account limits (from the status line, read ' + when(f.at) + '): ' + Object.keys(f.windows).map((k) => (names[k] || k) + ' ' + f.windows[k].pct + '% used' + (f.windows[k].resetsAt ? ', resets ' + when(f.windows[k].resetsAt) : '')).join('; ') + '.' + (limitsState.error ? ' Last send: ' + limitsState.error : '');
  }
  return 'Account limits: ' + (limitsState.error || 'no status-line reading yet (run node agent.js --setup once, then use Claude Code)') + '.';
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
  const lim = r.limits && r.limits.sent ? ' Account limits sent too.' : (r.limits && r.limits.error ? ' Account limits: ' + r.limits.error + '.' : '');
  if (!r.sync.sent) return 'Scanned ' + r.scan.files + ' log files (' + r.scan.records + ' new API calls). Not sent: ' + String(r.sync.error || 'nothing new').replace(/\.$/, '') + '.' + lim;
  return 'Scanned ' + r.scan.files + ' log files, ' + r.scan.records + ' new API calls. Sent ' + r.sync.days + ' day-and-model rows and ' + r.sync.sessions + ' sessions' + (r.sync.full ? ' (everything this PC has)' : '') + ' to ' + URL_BASE + ' as \u201C' + LABEL + '\u201D.' + lim;
}
async function toolSyncNow(args) { return describe(await cycle(!!(args && args.everything), 'tool')); }
function toolStatus() {
  const daysN = Object.keys(state.days).length, pend = state.dirtyDays.length;
  return ['Reporting as “' + LABEL + '” (id ' + MEMBER_ID + ') to ' + (URL_BASE || '(USAGE_URL not set)') + '.',
    'Logs: ' + CLAUDE_DIR + ' (' + Object.keys(state.files).length + ' files, ' + daysN + ' days with usage, last activity ' + when(state.lastActivity) + '; ' + Object.keys(state.ledgers).length + ' session ledgers' + (USE_LEDGER ? '' : ', ignored') + (state.frozenDays.length ? '; ' + state.frozenDays.length + ' old day(s) only on the collector' : '') + ').',
    'Day boundaries: ' + (state.tz || 'this PC’s time zone') + '.',
    'Last scan ' + when(state.lastScan) + '; last successful send ' + when(state.lastSyncOk) + '; ' + (pend ? pend + ' day(s) waiting to be sent' : 'nothing waiting') + '.',
    state.lastError ? 'Last error: ' + state.lastError + (state.nextTry > Date.now() ? ' (next try in ' + Math.ceil((state.nextTry - Date.now()) / 60000) + ' min)' : '') : 'No errors.',
    limitsText(),
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
  const acc = r.json.account;
  if (acc && acc.windows && typeof acc.windows === 'object') {
    const names = { fiveHour: '5-hour window', sevenDay: 'weekly', sevenDayOpus: 'weekly Opus', sevenDaySonnet: 'weekly Sonnet' };
    const parts = Object.keys(names).filter((k) => acc.windows[k] && typeof acc.windows[k].pct === 'number').map((k) => names[k] + ' ' + acc.windows[k].pct + '% used' + (acc.windows[k].resetsAt ? ' (resets ' + when(acc.windows[k].resetsAt) + ')' : ''));
    if (parts.length) lines.push('Account limits' + (acc.plan ? ', ' + acc.plan + ' plan' : '') + ', for the whole account including claude.ai chats: ' + parts.join('; ') + '. Checked ' + when(acc.checkedAt) + (acc.byLabel ? ' on ' + acc.byLabel : '') + '.');
  }
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
  /* the first snapshot must already use the collector's day zone, so ask for it first (8 s at most) */
  setTimeout(() => {
    learnZone().then(() => cycle(false, 'start')).then((r) => { if (r && (r.scan.records || r.sync.sent)) log('start: ' + r.scan.records + ' new API calls, ' + (r.sync.sent ? 'sent ' + r.sync.days + ' rows' : (r.sync.error || 'nothing to send'))); }, (e) => log('start failed:', e && e.message));
  }, 300);
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
    process.exitCode = 0;
    try { process.stdin.destroy(); } catch (e) {}
    setTimeout(() => process.exit(0), 1500).unref(); /* only if something still holds the loop open */
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
  if (argv.indexOf('--statusline') >= 0) { await statusLine(); return; } /* the status line must stay quick: no state, no network */
  loadState();
  if (argv.indexOf('--status') >= 0) { console.log(toolStatus()); return; }
  if (argv.indexOf('--once') >= 0) {
    if (!URL_BASE || !KEY) { console.error('Set USAGE_URL and USAGE_KEY (and USAGE_MEMBER).'); process.exitCode = 2; return; }
    await learnZone();
    const r = await cycle(argv.indexOf('--everything') >= 0, 'once');
    console.log(describe(r));
    /* set the code and let the process end on its own: process.exit() right after a request crashes Node on Windows */
    process.exitCode = r.sync.sent || r.sync.upToDate ? 0 : 1;
    return;
  }
  if (argv.indexOf('--summary') >= 0) { console.log(await toolSummary({ days: 7 })); return; }
  if (argv.indexOf('--limits') >= 0) { const r = await syncLimits(true); console.log((r.sent ? 'Sent to the collector. ' : (r.error ? 'Not sent: ' + r.error + '. ' : '')) + limitsText()); process.exitCode = r.sent ? 0 : 1; return; }
  if (argv.indexOf('--setup') >= 0) {
    const r = setupStatusLine();
    console.log('Status line set in ' + r.file + ': ' + ourStatusCommand() + (r.previous ? ' (your previous status line, ' + r.previous + ', keeps running inside it)' : '') + '. Claude Code reads it when it starts.');
    return;
  }
  if (!URL_BASE || !KEY) log('USAGE_URL or USAGE_KEY is not set: usage is counted but cannot be sent');
  serve();
}
if (require.main === module) main().catch((e) => { log('fatal:', e && e.stack || e); process.exitCode = 1; });
module.exports = { parseLine, parseLedger, parseStatusWindows, readFrom, dayOf, slug, systemString, TOOLS, VERSION };
