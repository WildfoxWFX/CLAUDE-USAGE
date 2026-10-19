'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('../../collector/test/helpers');
const A = require('../agent');
const AGENT = path.join(__dirname, '..', 'agent.js');
const K = '?key=read-secret-1234';

/* an assistant line as Claude Code writes it (content left out) */
function line(o) {
  const u = Object.assign({ input_tokens: 2, cache_creation_input_tokens: 24025, cache_read_input_tokens: 47089, output_tokens: 620, cache_creation: { ephemeral_1h_input_tokens: o.cw1h === undefined ? 24025 : o.cw1h, ephemeral_5m_input_tokens: 0 } }, o.usage || {});
  const rec = { parentUuid: 'p', isSidechain: !!o.side, message: { model: o.model === undefined ? 'claude-sonnet-5-5' : o.model, id: o.id === undefined ? 'msg_1' : o.id, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: o.noUsage ? undefined : u },
    requestId: o.rid === undefined ? 'req_1' : o.rid, type: o.type || 'assistant', uuid: o.uuid || 'uuid-' + Math.random().toString(36).slice(2), timestamp: o.ts || '2026-10-18T10:00:00.000Z', sessionId: o.session === undefined ? 'sess-A' : o.session, cwd: '/w' };
  if (o.err) rec.isApiErrorMessage = true;
  return JSON.stringify(rec);
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'));
  const p = path.join(dir, 'projects', '-home-me-proj'); fs.mkdirSync(p, { recursive: true });
  const sub = path.join(p, 'sess-A', 'subagents', 'workflows', 'wf1'); fs.mkdirSync(sub, { recursive: true });
  const main = [
    line({ id: 'msg_1', rid: 'req_1', usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }, cw1h: 400 }), /* first streamed chunk: partial output count */
    line({ id: 'msg_1', rid: 'req_1', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }, cw1h: 400 }), /* last chunk: the full count, as ccusage keeps it */
    line({ id: 'msg_1', rid: 'req_1', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }, cw1h: 400 }),
    line({ id: 'msg_2', rid: 'req_2', ts: '2026-10-18T11:00:00.000Z', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }),
    line({ id: 'msg_3', rid: 'req_3', ts: '2026-10-18T22:30:00.000Z', model: 'claude-opus-4-1-20250805', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }),
    line({ id: 'msg_4', rid: 'req_4', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } }),
    line({ id: 'msg_5', rid: 'req_5', err: true, usage: { input_tokens: 999, output_tokens: 999 } }),
    line({ id: 'msg_6', rid: 'req_6', model: 'gpt-4o', usage: { input_tokens: 999, output_tokens: 999 } }),
    line({ id: 'msg_7', rid: 'req_7', noUsage: true }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-10-18T10:00:00.000Z', uuid: 'u1', sessionId: 'sess-A' }),
    JSON.stringify({ type: 'summary', summary: 'x', leafUuid: 'u1' }),
    'not json at all',
  ];
  fs.writeFileSync(path.join(p, 'sess-A.jsonl'), main.join('\n') + '\n');
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), line({ id: 'msg_s1', rid: 'req_s1', side: true, ts: '2026-10-19T03:00:00.000Z', model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, cw1h: 0 }) + '\n');
  fs.writeFileSync(path.join(p, 'notes.txt'), 'ignored');
  return { dir, main: path.join(p, 'sess-A.jsonl'), sub: path.join(sub, 'agent-1.jsonl') };
}
function env(col, extra) {
  return Object.assign({}, process.env, { USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'Harsh Patel', USAGE_HOST: 'DESKTOP-1', USAGE_INTERVAL_MS: '10000' }, extra || {});
}
function once(col, fx, stateDir, extra, args) {
  return spawnSync(process.execPath, [AGENT, '--once'].concat(args || []), { env: env(col, Object.assign({ USAGE_CLAUDE_DIR: fx.dir, USAGE_STATE_DIR: stateDir }, extra || {})), encoding: 'utf8', timeout: 30000 });
}

test('parseLine keeps usage lines of Claude models and nothing else', () => {
  const r = A.parseLine(line({ usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7, cache_read_input_tokens: 8 }, cw1h: 3 }));
  assert.deepEqual(r, { key: 'msg_1', ms: Date.parse('2026-10-18T10:00:00.000Z'), model: 'claude-sonnet-5-5', in: 5, out: 6, cw: 7, cr: 8, cw1h: 3, session: 'sess-A' });
  assert.equal(A.parseLine(line({ id: 'gw-1', rid: 'r9' })).key, 'gw-1:r9', 'a gateway id is scoped by request');
  assert.equal(A.parseLine(line({ usage: { speed: 'fast' } })).model, 'claude-sonnet-5-5-fast');
  assert.equal(A.parseLine(line({ usage: { speed: 'standard' } })).model, 'claude-sonnet-5-5');
  assert.equal(A.parseLine(line({ model: '<synthetic>' })), null);
  assert.equal(A.parseLine(line({ model: 'gpt-4o' })), null);
  assert.equal(A.parseLine(line({ err: true })), null);
  assert.equal(A.parseLine(line({ noUsage: true })), null);
  assert.equal(A.parseLine(line({ type: 'user' })), null);
  assert.equal(A.parseLine(line({ ts: 'yesterday' })), null);
  assert.equal(A.parseLine(line({ ts: '2019-01-01T00:00:00Z' })), null);
  assert.equal(A.parseLine('{"type":"assistant","usage":'), null);
  assert.equal(A.parseLine('{"type":"assistant","message":{"usage":5,"model":"claude-x"}}'), null);
  assert.equal(A.parseLine(line({ cw1h: 999999 })).cw1h, 24025, 'the 1h share never exceeds the cache write total');
  assert.equal(A.parseLine(line({ id: null, uuid: 'abc' })).key, 'u:abc:req_1');
  assert.equal(A.parseLine(line({ model: 'CLAUDE-OPUS-4-1-20250805' })).model, 'claude-opus-4-1-20250805');
  assert.equal(A.parseLine(line({ usage: { input_tokens: '12' } })).in, 12, 'numbers in strings are accepted');
  assert.equal(A.parseLine(line({ usage: { input_tokens: -4 } })).in, 0);
  assert.equal(A.parseLine(line({ session: '' })).session, '');
  /* the session ledger */
  const ledger = JSON.stringify({ type: 'cost-state', sessionId: 'sess-A', totalCostUSD: 1.5, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 5000, thinkingTokens: 100, cacheReadInputTokens: 300, cacheCreationInputTokens: 200, costUSD: 1.4 }, 'claude-haiku-5-5': { inputTokens: '7', outputTokens: 8 }, 'gpt-4': { inputTokens: 1, outputTokens: 1 } } });
  assert.deepEqual(A.parseLedger(ledger), { session: 'sess-A', models: { 'claude-sonnet-5-5': [10, 5000, 200, 300], 'claude-haiku-5-5': [7, 8, 0, 0] } });
  assert.equal(A.parseLedger(JSON.stringify({ type: 'cost-state', sessionId: 's', modelUsage: {} })), null);
  assert.equal(A.parseLedger(JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-x': {} } })), null);
  assert.equal(A.parseLedger('{"type":"cost-state"'), null);
  assert.equal(A.parseLedger(line({})), null);
});

test('readFrom reads complete lines from an offset and leaves a partial line for later', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')), 'a.jsonl');
  fs.writeFileSync(f, 'one\ntwö\nthree\npart');
  let r = A.readFrom(f, 0);
  assert.deepEqual(r.lines, ['one', 'twö', 'three']); assert.equal(r.nextOffset, Buffer.byteLength('one\ntwö\nthree\n'));
  fs.appendFileSync(f, 'ial\nfive\n');
  r = A.readFrom(f, r.nextOffset);
  assert.deepEqual(r.lines, ['partial', 'five']); assert.equal(r.nextOffset, r.size);
  assert.deepEqual(A.readFrom(f, r.nextOffset).lines, []);
  fs.writeFileSync(f, 'x\n');
  assert.equal(A.readFrom(f, r.nextOffset).shrunk, true);
  /* a multi-byte character split across the 1 MiB read chunk is decoded whole */
  const big = 'a'.repeat((1 << 20) - 1) + '€\n' + 'b\n';
  fs.writeFileSync(f, big);
  r = A.readFrom(f, 0);
  assert.equal(r.lines.length, 2); assert.equal(r.lines[0].slice(-1), '€'); assert.equal(r.lines[0].length, 1 << 20);
});

test('dayOf follows the zone; systemString and slug are sane', () => {
  const ms = Date.parse('2026-10-18T20:30:00Z');
  assert.equal(A.dayOf(ms, 'UTC'), '2026-10-18'); assert.equal(A.dayOf(ms, 'Asia/Kolkata'), '2026-10-19'); assert.equal(A.dayOf(ms, 'America/Los_Angeles'), '2026-10-18');
  assert.match(A.systemString(), /^(Windows 1[01] \(|macOS \(Darwin |Linux )[^|]*\| .*threads \| \d+ GB RAM$/);
  assert.equal(A.slug('Harsh Patel'), 'harsh-patel'); assert.equal(A.slug('***'), 'member');
  assert.deepEqual(A.TOOLS.map((t) => t.name), ['usage_sync_now', 'usage_status', 'usage_summary']);
});

test('--once scans the logs, sends a snapshot, and later runs send only what changed', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const fx = fixture(), st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  try {
    let r = once(col, fx, st);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Scanned 2 log files, 4 new API calls\. Sent 3 day-and-model rows and 1 sessions \(everything this PC has\) to .* as “Harsh Patel · DESKTOP-1”\./);
    let u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.equal(u.members.length, 1);
    const m = u.members[0];
    assert.equal(m.id, 'harsh-patel@desktop-1'); assert.equal(m.label, 'Harsh Patel · DESKTOP-1'); assert.equal(m.source, 'agent');
    assert.match(m.system, /threads \| \d+ GB RAM \| IP 127\.0\.0\.1$/);
    assert.deepEqual(m.rows.map((x) => x.slice(0, 6)), [
      ['2026-10-18', 'claude-opus-4-1-20250805', 7, 3, 0, 0],
      ['2026-10-18', 'claude-sonnet-5-5', 110, 70, 1000, 5000],
      ['2026-10-19', 'claude-haiku-5-5', 1, 2, 3, 4] ]);
    /* sonnet: 100 in, 50 out, 1000 cw of which 400 at the 1 h rate, 5000 cr; plus 10 in, 20 out */
    assert.equal(m.rows[1][6], (110 * 2 + 70 * 10 + 600 * 2.5 + 400 * 4 + 5000 * 0.1) / 1e6);
    assert.equal(m.events, 4); assert.equal(m.lastSeen, '2026-10-19T03:00:00.000Z');
    assert.equal(u.sessions.length, 1); assert.equal(u.sessions[0].id, 'sess-A'); assert.deepEqual(u.sessions[0].models, ['claude-haiku-5-5', 'claude-opus-4-1-20250805', 'claude-sonnet-5-5']);
    assert.equal(u.sessions[0].all, 110 + 70 + 1000 + 5000 + 7 + 3 + 1 + 2 + 3 + 4);
    const state = JSON.parse(fs.readFileSync(path.join(st, 'state.json'), 'utf8'));
    assert.equal(state.tz, 'UTC'); assert.deepEqual(state.dirtyDays, []); assert.equal(state.full, false); assert.equal(Object.keys(state.files).length, 2);
    assert.equal(state.v, 2); assert.equal(state.member, 'harsh-patel@desktop-1'); assert.equal(state.url, col.url); assert.match(state.token, /^[0-9a-f]{48,64}$/);
    assert.ok(Object.values(state.files).every((f) => Array.isArray(f.tail) && Array.isArray(f.days)));
    /* nothing new: nothing sent */
    r = once(col, fx, st);
    assert.equal(r.status, 0); assert.match(r.stdout, /0 new API calls\)\. Not sent: nothing new\./);
    assert.equal((await H.get(col.url + '/api/usage' + K)).json.stats.snapshots, 1);
    /* a new call appended to the main log: only its day is re-sent, and the day is replaced, not doubled */
    fs.appendFileSync(fx.main, line({ id: 'msg_8', rid: 'req_8', ts: '2026-10-18T12:00:00.000Z', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n');
    r = once(col, fx, st);
    assert.match(r.stdout, /1 new API calls\. Sent 2 day-and-model rows and 1 sessions to/);
    u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members[0].rows.find((x) => x[1] === 'claude-sonnet-5-5').slice(2, 4), [111, 71]);
    assert.equal(u.members[0].rows.length, 3);
    /* the last chunk of an already counted message arrives in a later scan: only the extra output counts */
    fs.appendFileSync(fx.main, line({ id: 'msg_8', rid: 'req_8', ts: '2026-10-18T12:00:00.000Z', usage: { input_tokens: 1, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n');
    r = once(col, fx, st);
    assert.match(r.stdout, /0 new API calls\. Sent 2 day-and-model rows and 1 sessions to/);
    assert.deepEqual((await H.get(col.url + '/api/usage' + K)).json.members[0].rows.find((x) => x[1] === 'claude-sonnet-5-5').slice(2, 4), [111, 79]);
    /* a partial line is not counted until it is complete */
    const half = line({ id: 'msg_9', rid: 'req_9', usage: { input_tokens: 50, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 });
    fs.appendFileSync(fx.main, half.slice(0, 40));
    r = once(col, fx, st); assert.match(r.stdout, /0 new API calls/);
    fs.appendFileSync(fx.main, half.slice(40) + '\n');
    r = once(col, fx, st); assert.match(r.stdout, /1 new API calls/);
    assert.deepEqual((await H.get(col.url + '/api/usage' + K)).json.members[0].rows.find((x) => x[1] === 'claude-sonnet-5-5').slice(2, 4), [161, 129]);
    /* a log file disappears: everything is recounted; its day is old, so the collector keeps what it has */
    fs.unlinkSync(fx.sub);
    r = once(col, fx, st);
    assert.match(r.stderr, /log file\(s\) gone, recounting everything/); /* its day is recent, so nothing is frozen; the day simply has nothing left to send */
    u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.equal(u.members[0].rows.length, 3, 'the server keeps the day the PC no longer has');
    assert.deepEqual(u.members[0].rows.find((x) => x[1] === 'claude-haiku-5-5').slice(2, 4), [1, 2]);
    /* --everything re-sends every day the PC still has, even with nothing new pending */
    r = once(col, fx, st, {}, ['--everything']);
    assert.match(r.stdout, /Sent 2 day-and-model rows and 1 sessions \(everything this PC has\)/);
    /* and also when something new is pending (the collector was rebuilt, say) */
    fs.appendFileSync(fx.main, line({ id: 'msg_12', rid: 'req_12', ts: '2026-10-17T12:00:00.000Z', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n');
    r = once(col, fx, st, {}, ['--everything']);
    assert.match(r.stdout, /1 new API calls\. Sent 3 day-and-model rows and 1 sessions \(everything this PC has\)/);
  } finally { await col.stop(); }
});

test('the day boundary follows the collector’s zone', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'Asia/Kolkata' });
  const fx = fixture(), st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  try {
    const r = once(col, fx, st);
    assert.equal(r.status, 0, r.stderr);
    const u = (await H.get(col.url + '/api/usage' + K)).json;
    /* msg_3 at 22:30Z is already the 19th in Kolkata */
    assert.deepEqual(u.members[0].rows.map((x) => [x[0], x[1]]), [['2026-10-18', 'claude-sonnet-5-5'], ['2026-10-19', 'claude-haiku-5-5'], ['2026-10-19', 'claude-opus-4-1-20250805']]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(st, 'state.json'), 'utf8')).tz, 'Asia/Kolkata');
  } finally { await col.stop(); }
});

test('--once fails clearly without a collector and keeps the data for the next try', async () => {
  const fx = fixture(), st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const r = spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, { USAGE_URL: 'http://127.0.0.1:1', USAGE_KEY: 'k', USAGE_MEMBER: 'x', USAGE_CLAUDE_DIR: fx.dir, USAGE_STATE_DIR: st }), encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /Not sent: fetch failed/);
  const state = JSON.parse(fs.readFileSync(path.join(st, 'state.json'), 'utf8'));
  assert.equal(state.dirtyDays.length, 2); assert.equal(state.fails, 1); assert.ok(state.nextTry > Date.now());
  const r2 = spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, { USAGE_KEY: 'k', USAGE_CLAUDE_DIR: fx.dir, USAGE_STATE_DIR: st }), encoding: 'utf8' });
  assert.equal(r2.status, 2); assert.match(r2.stderr, /Set USAGE_URL and USAGE_KEY/);
});

test('logs are read from every root like ccusage: ~/.claude, ~/.config/claude, or a comma-separated list', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const mk = (sub, name, out) => { const d = path.join(home, sub, 'projects', 'p'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 's.jsonl'), line({ id: 'msg_' + name, rid: 'r' + name, usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n'); };
  mk('.claude', 'a', 10); mk(path.join('.config', 'claude'), 'b', 20); mk('other1', 'c', 30); mk('other2', 'd', 40);
  try {
    let r = spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', USAGE_CLAUDE_DIR: '', USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'x', USAGE_HOST: 'H', USAGE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')) }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Scanned 2 log files, 2 new API calls/);
    let u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.equal(u.members[0].rows[0][3], 30, 'both default roots counted');
    r = spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, { HOME: home, USAGE_CLAUDE_DIR: path.join(home, 'other1') + ', ' + path.join(home, 'other2', 'projects'), USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'y', USAGE_HOST: 'H', USAGE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')) }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.equal(u.members.find((m) => m.id === 'y@h').rows[0][3], 70, 'a root may be the config dir or the projects dir itself');
  } finally { await col.stop(); }
});

test('a response that streams past midnight is counted on the day it started; fast mode is its own model', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), p = path.join(dir, 'projects', 'p'); fs.mkdirSync(p, { recursive: true });
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const first = line({ id: 'msg_x', rid: 'req_x', ts: '2026-10-17T23:59:50.000Z', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 });
  const last = line({ id: 'msg_x', rid: 'req_x', ts: '2026-10-18T00:00:40.000Z', usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 });
  const fast = line({ id: 'msg_f', rid: 'req_f', ts: '2026-10-18T01:00:00.000Z', model: 'claude-opus-5-5', usage: { input_tokens: 1000000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, speed: 'fast' }, cw1h: 0 });
  fs.writeFileSync(path.join(p, 's.jsonl'), first + '\n');
  try {
    const env2 = Object.assign({}, process.env, { USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'z', USAGE_HOST: 'H', USAGE_CLAUDE_DIR: dir, USAGE_STATE_DIR: st });
    assert.equal(spawnSync(process.execPath, [AGENT, '--once'], { env: env2, encoding: 'utf8' }).status, 0);
    fs.appendFileSync(path.join(p, 's.jsonl'), last + '\n' + fast + '\n');
    assert.equal(spawnSync(process.execPath, [AGENT, '--once'], { env: env2, encoding: 'utf8' }).status, 0);
    const rows = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows;
    assert.deepEqual(rows.map((x) => [x[0], x[1], x[2], x[3], x[6]]), [['2026-10-17', 'claude-sonnet-5-5', 10, 50, (10 * 2 + 50 * 10) / 1e6], ['2026-10-18', 'claude-opus-5-5-fast', 1000000, 0, 8]]);
  } finally { await col.stop(); }
});

test('Claude Code\u2019s session ledger lifts the understated output tokens, shared over the session\u2019s days', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), p = path.join(dir, 'projects', 'p'); fs.mkdirSync(p, { recursive: true });
  const rec = (id, ts, out) => line({ id: 'msg_' + id, rid: 'req_' + id, ts, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }, cw1h: 0 });
  const ledger = (out, cr) => JSON.stringify({ type: 'cost-state', sessionId: 'sess-A', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 30, outputTokens: out, cacheReadInputTokens: cr, cacheCreationInputTokens: 300, costUSD: 1 } } });
  /* 3 records: 10 output on the 17th, 20 + 10 on the 18th; the ledger says 3000 output and 3300 cache reads */
  fs.writeFileSync(path.join(p, 's.jsonl'), [rec('a', '2026-10-17T10:00:00.000Z', 10), rec('b', '2026-10-18T10:00:00.000Z', 20), rec('c', '2026-10-18T11:00:00.000Z', 10), ledger(3000, 3300)].join('\n') + '\n');
  const run = (extra) => spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, { USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'l', USAGE_HOST: 'H', USAGE_CLAUDE_DIR: dir, USAGE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')) }, extra || {}), encoding: 'utf8' });
  try {
    let r = run(); assert.equal(r.status, 0, r.stdout + r.stderr);
    let u = (await H.get(col.url + '/api/usage' + K)).json;
    const rows = u.members.find((m) => m.id === 'l@h').rows;
    /* output deficit 2960 shared 10:30 -> 740 to the 17th, 2220 to the 18th; cache-read deficit 300 shared 1:2 */
    assert.deepEqual(rows.map((x) => x.slice(0, 6)), [['2026-10-17', 'claude-sonnet-5-5', 10, 750, 100, 1100], ['2026-10-18', 'claude-sonnet-5-5', 20, 2250, 200, 2200]]);
    const s = u.sessions.find((x) => x.id === 'sess-A');
    assert.equal(s.out, 3000); assert.equal(s.all, 30 + 3000 + 300 + 3300);
    /* a ledger older than the records lifts nothing; cache writes already matched */
    fs.appendFileSync(path.join(p, 's.jsonl'), rec('d', '2026-10-18T12:00:00.000Z', 5000) + '\n');
    r = run({ USAGE_MEMBER: 'l2' }); assert.equal(r.status, 0, r.stderr);
    u = (await H.get(col.url + '/api/usage' + K)).json;
    const rows2 = u.members.find((m) => m.id === 'l2@h').rows;
    assert.deepEqual(rows2.map((x) => [x[0], x[3], x[5]]), [['2026-10-17', 10, 1000], ['2026-10-18', 5030, 3000]], 'counted output already above the ledger: no lift; cache reads: 4000 counted > 3300');
    /* switched off: exactly the records, like ccusage */
    r = run({ USAGE_MEMBER: 'l3', USAGE_LEDGER: '0' }); assert.equal(r.status, 0, r.stderr);
    u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members.find((m) => m.id === 'l3@h').rows.map((x) => [x[0], x[3]]), [['2026-10-17', 10], ['2026-10-18', 5030]]);
    assert.match(spawnSync(process.execPath, [AGENT, '--status'], { env: Object.assign({}, process.env, { USAGE_CLAUDE_DIR: dir, USAGE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')) }), encoding: 'utf8' }).stdout, /0 session ledgers/);
  } finally { await col.stop(); }
});

test('a zone change retracts the rows that moved: the collector never double counts', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), p = path.join(dir, 'projects', 'p'); fs.mkdirSync(p, { recursive: true });
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(p, 's.jsonl'), line({ id: 'msg_o', rid: 'req_o', ts: '2026-10-18T22:30:00.000Z', model: 'claude-opus-4-1-20250805', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n' +
    line({ id: 'msg_s', rid: 'req_s', ts: '2026-10-18T10:00:00.000Z', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n');
  const base = { USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'z', USAGE_HOST: 'H', USAGE_CLAUDE_DIR: dir, USAGE_STATE_DIR: st };
  try {
    /* first in Kolkata (the opus call lands on the 19th), then the collector's UTC */
    let r = spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, base, { USAGE_TZ: 'Asia/Kolkata' }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    let rows = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows;
    assert.deepEqual(rows.map((x) => [x[0], x[1]]), [['2026-10-18', 'claude-sonnet-5-5'], ['2026-10-19', 'claude-opus-4-1-20250805']]);
    r = spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, base), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /day boundaries follow UTC, recounting/);
    rows = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows;
    assert.deepEqual(rows.map((x) => [x[0], x[1], x[3]]), [['2026-10-18', 'claude-opus-4-1-20250805', 3], ['2026-10-18', 'claude-sonnet-5-5', 1]], 'the 19th is gone');
    assert.equal((await H.get(col.url + '/api/usage' + K)).json.members[0].events, 2);
    /* the collector's zone changes later: same outcome the other way */
    await col.stop();
    const col2 = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'Asia/Kolkata' });
    try {
      const base2 = Object.assign({}, base, { USAGE_URL: col2.url });
      r = spawnSync(process.execPath, [AGENT, '--once'], { env: Object.assign({}, process.env, base2), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /collector or name changed: everything will be sent again/);
      rows = (await H.get(col2.url + '/api/usage' + K)).json.members[0].rows;
      assert.deepEqual(rows.map((x) => [x[0], x[1]]), [['2026-10-18', 'claude-sonnet-5-5'], ['2026-10-19', 'claude-opus-4-1-20250805']]);
    } finally { await col2.stop(); }
  } finally { if (col.proc.exitCode === null) await col.stop(); }
});

test('a renamed person or a new collector gets the whole history, not only new days', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const fx = fixture(), st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  try {
    let r = once(col, fx, st, { USAGE_MEMBER: 'Harsh Patle' }); assert.equal(r.status, 0, r.stderr);
    r = once(col, fx, st, { USAGE_MEMBER: 'Harsh Patel' }); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /collector or name changed/); assert.match(r.stdout, /Sent 3 day-and-model rows and 1 sessions \(everything this PC has\)/);
    const u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.equal(u.members.find((m) => m.id === 'harsh-patel@desktop-1').rows.length, 3);
    assert.equal(u.members.find((m) => m.id === 'harsh-patle@desktop-1').rows.length, 3, 'the old name stays until removed on the collector');
    const del = await fetch(col.url + '/api/members/harsh-patle%40desktop-1' + K, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await H.get(col.url + '/api/usage' + K)).json.members.length, 1);
  } finally { await col.stop(); }
});

test('two installations with the same name and PC: the second is refused with a clear message', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const fx = fixture(), st1 = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), st2 = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  try {
    assert.equal(once(col, fx, st1).status, 0);
    /* the same PC again (same Claude Code install id) derives the same token and is fine */
    const same = once(col, fx, st2);
    assert.equal(same.status, 0, same.stdout + same.stderr);
    /* another PC: no shared install id, so its token differs */
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-home-'));
    const r = once(col, fx, fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), { HOME: other, USERPROFILE: other });
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /answered 403: another installation already reports as “harsh-patel@desktop-1”/); assert.ok(!/\.\.$/.test(r.stdout.trim()), r.stdout);
    assert.match(r.stdout, /DELETE \/api\/members\/harsh-patel%40desktop-1/);
    assert.equal(once(col, fx, st1).status, 0, 'the first keeps working');
  } finally { await col.stop(); }
});

test('days an old deleted log covered are frozen, recent ones are recounted', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), p = path.join(dir, 'projects', 'p'); fs.mkdirSync(p, { recursive: true });
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const today = new Date().toISOString().slice(0, 10), rec = (id, ts, inTok) => line({ id: 'msg_' + id, rid: 'req_' + id, ts, usage: { input_tokens: inTok, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 });
  fs.writeFileSync(path.join(p, 'old.jsonl'), rec('a', '2026-09-15T10:00:00.000Z', 100) + '\n');
  fs.writeFileSync(path.join(p, 'long.jsonl'), rec('b', '2026-09-15T11:00:00.000Z', 10) + '\n' + rec('c', today + 'T01:00:00.000Z', 5) + '\n');
  fs.writeFileSync(path.join(p, 'fresh.jsonl'), rec('d', today + 'T02:00:00.000Z', 50) + '\n');
  const env2 = Object.assign({}, process.env, { USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'f', USAGE_HOST: 'H', USAGE_CLAUDE_DIR: dir, USAGE_STATE_DIR: st });
  try {
    assert.equal(spawnSync(process.execPath, [AGENT, '--once'], { env: env2, encoding: 'utf8' }).status, 0);
    let rows = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows;
    assert.deepEqual(rows.map((x) => [x[0], x[2]]), [['2026-09-15', 110], [today, 55]]);
    /* Claude Code's cleanup removes the old file: September keeps its 110 on the collector */
    fs.unlinkSync(path.join(p, 'old.jsonl'));
    let r = spawnSync(process.execPath, [AGENT, '--once'], { env: env2, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /1 old day\(s\) kept as the collector has them/);
    rows = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows;
    assert.deepEqual(rows.map((x) => [x[0], x[2]]), [['2026-09-15', 110], [today, 55]]);
    /* a file for today is deleted by hand: today is recent, so it is recounted and shrinks */
    fs.unlinkSync(path.join(p, 'fresh.jsonl'));
    r = spawnSync(process.execPath, [AGENT, '--once'], { env: env2, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    rows = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows;
    assert.deepEqual(rows.map((x) => [x[0], x[2]]), [['2026-09-15', 110], [today, 5]]);
    assert.match(spawnSync(process.execPath, [AGENT, '--status'], { env: env2, encoding: 'utf8' }).stdout, /1 old day\(s\) only on the collector/);
  } finally { await col.stop(); }
});

test('messages keep their key across scans even with many later messages in the file', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), p = path.join(dir, 'projects', 'p'); fs.mkdirSync(p, { recursive: true });
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const rec = (id, out) => line({ id: 'msg_' + id, rid: 'req_' + id, usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 });
  /* first chunk of M, then 12 other messages, then the last chunk of M in a later scan */
  fs.writeFileSync(path.join(p, 's.jsonl'), [rec('M', 5)].concat(Array.from({ length: 12 }, (_, i) => rec('x' + i, 1))).join('\n') + '\n');
  const env2 = Object.assign({}, process.env, { USAGE_URL: col.url, USAGE_KEY: 'ingest-secret-1234', USAGE_MEMBER: 'k', USAGE_HOST: 'H', USAGE_CLAUDE_DIR: dir, USAGE_STATE_DIR: st });
  try {
    assert.equal(spawnSync(process.execPath, [AGENT, '--once'], { env: env2, encoding: 'utf8' }).status, 0);
    fs.appendFileSync(path.join(p, 's.jsonl'), rec('M', 50) + '\n');
    const r = spawnSync(process.execPath, [AGENT, '--once'], { env: env2, encoding: 'utf8' });
    assert.match(r.stdout, /0 new API calls\. Sent 1 day-and-model rows/);
    const row = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows[0];
    assert.deepEqual([row[2], row[3]], [13, 62], '13 calls; M counts 50 output, not 55 and not 2 calls');
    /* a 17th message pushes M out of the file's tail: a late duplicate of M would then count again, which is why the tail is sized for one response */
    const state = JSON.parse(fs.readFileSync(path.join(st, 'state.json'), 'utf8'));
    assert.equal(Object.values(state.files)[0].tail.length, 13);
  } finally { await col.stop(); }
});

/* a stand-in for a far-away collector: /healthz answers slowly, everything else is passed through */
function slowProxy(target, delayMs) {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const forward = () => {
      const u = new URL(req.url, target);
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
        fetch(u, { method: req.method, headers: Object.assign({}, req.headers, { host: new URL(target).host }), body: chunks.length ? Buffer.concat(chunks) : undefined }).then(async (r) => { res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await r.arrayBuffer())); }, () => { res.writeHead(502); res.end(); });
      });
    };
    if (req.url.startsWith('/healthz')) setTimeout(forward, delayMs); else forward();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise((r) => srv.close(r)) })));
}

test('as an MCP server the first snapshot waits for the collector’s zone', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'Asia/Kolkata' });
  const proxy = await slowProxy(col.url, 2500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), p = path.join(dir, 'projects', 'p'); fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 's.jsonl'), line({ id: 'msg_o', rid: 'req_o', ts: '2026-10-18T22:30:00.000Z', model: 'claude-opus-4-1-20250805', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n');
  const a = mcp({ url: proxy.url }, { dir }, fs.mkdtempSync(path.join(os.tmpdir(), 'st-')));
  try {
    await a.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.303' } });
    a.notify('notifications/initialized');
    assert.ok(await H.until(async () => (await H.get(col.url + '/api/usage' + K)).json.members.length === 1, 12000), 'sent after the zone arrived');
    const rows = (await H.get(col.url + '/api/usage' + K)).json.members[0].rows;
    assert.deepEqual(rows.map((x) => [x[0], x[1]]), [['2026-10-19', 'claude-opus-4-1-20250805']], 'bucketed in the collector’s zone, nothing stale');
    assert.ok(a.stderr.join('').indexOf('recounting') < 0, a.stderr.join(''));
  } finally { if (a.proc.exitCode === null) a.proc.kill(); await proxy.close(); await col.stop(); }
});

/* drive the agent as Claude Code would: JSON-RPC over stdio */
function mcp(col, fx, st) {
  const proc = spawn(process.execPath, [AGENT], { env: env(col, { USAGE_CLAUDE_DIR: fx.dir, USAGE_STATE_DIR: st, USAGE_INTERVAL_MS: '10000' }), stdio: ['pipe', 'pipe', 'pipe'] });
  proc.on('error', () => {});
  const pending = new Map(), stderr = [], raw = [];
  let buf = '';
  proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); raw.push(l); try { const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch (e) { raw.push('UNPARSEABLE:' + l); } } });
  proc.stderr.on('data', (d) => stderr.push(String(d)));
  let n = 0;
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('no answer to ' + method)); } }, 20000); });
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const exited = new Promise((r) => proc.on('exit', (code, sig) => r({ code, sig })));
  return { proc, call, notify, stderr, raw, exited };
}

test('as an MCP server: handshake, tools, sync on start, final send on exit', async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const fx = fixture(), st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const a = mcp(col, fx, st);
  try {
    const init = await a.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.303' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, 'claude-usage'); assert.match(init.result.instructions, /usage_summary/);
    a.notify('notifications/initialized');
    const list = await a.call('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['usage_sync_now', 'usage_status', 'usage_summary']);
    list.result.tools.forEach((t) => { assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 20); });
    assert.deepEqual((await a.call('ping', {})).result, {});
    assert.equal((await a.call('nope/method', {})).error.code, -32601);
    assert.equal((await a.call('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
    assert.deepEqual((await a.call('resources/list', {})).result, { resources: [] });
    assert.deepEqual((await a.call('prompts/list', {})).result, { prompts: [] });
    /* the start-up sync runs on its own */
    assert.ok(await H.until(async () => (await H.get(col.url + '/api/usage' + K)).json.members.length === 1, 8000), 'sent on start');
    const status = await a.call('tools/call', { name: 'usage_status', arguments: {} });
    assert.equal(status.result.isError, false);
    assert.match(status.result.content[0].text, /Reporting as “Harsh Patel · DESKTOP-1” \(id harsh-patel@desktop-1\) to http:\/\/127\.0\.0\.1:\d+\./);
    assert.match(status.result.content[0].text, /2 files, 2 days with usage/); assert.match(status.result.content[0].text, /nothing waiting/); assert.match(status.result.content[0].text, /No errors/);
    const sys = (await H.get(col.url + '/api/usage' + K)).json.members[0].system;
    assert.match(sys, /\| Claude Code 2\.1\.303 \| IP 127\.0\.0\.1$/, sys);
    /* a new call lands in the log, then the tool pushes it */
    fs.appendFileSync(fx.main, line({ id: 'msg_10', rid: 'req_10', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n');
    const sync = await a.call('tools/call', { name: 'usage_sync_now', arguments: {} });
    assert.match(sync.result.content[0].text, /1 new API calls\. Sent/);
    assert.deepEqual((await H.get(col.url + '/api/usage' + K)).json.members[0].rows.find((x) => x[1] === 'claude-sonnet-5-5').slice(2, 4), [111, 71]);
    const sum = await a.call('tools/call', { name: 'usage_summary', arguments: { days: 3000 } });
    const txt = sum.result.content[0].text;
    assert.match(txt, /^Claude Code usage, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(UTC\), 1 PC:/); assert.match(txt, /Estimated cost \$0\.0\d/); assert.match(txt, /Harsh Patel · DESKTOP-1: \$0\.0\d, 76 output tokens, 2 active days/); assert.match(txt, /claude-sonnet-5-5: \$/);
    const me = await a.call('tools/call', { name: 'usage_summary', arguments: { days: 3000, scope: 'me' } });
    assert.match(me.result.content[0].text, /this PC:/);
    /* another call written, then Claude Code exits: the agent sends what is left and stops */
    fs.appendFileSync(fx.main, line({ id: 'msg_11', rid: 'req_11', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cw1h: 0 }) + '\n');
    a.proc.stdin.end();
    const ex = await Promise.race([a.exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 10000))]);
    assert.equal(ex.code, 0, 'exits cleanly: ' + JSON.stringify(ex));
    assert.deepEqual((await H.get(col.url + '/api/usage' + K)).json.members[0].rows.find((x) => x[1] === 'claude-sonnet-5-5').slice(2, 4), [112, 72]);
    assert.ok(a.raw.every((l) => !l.startsWith('UNPARSEABLE')), 'stdout carried only JSON-RPC: ' + a.raw.filter((l) => l.startsWith('UNPARSEABLE')).join(' | '));
  } finally { if (a.proc.exitCode === null) a.proc.kill(); await col.stop(); }
});

test('as an MCP server without a reachable collector: tools still answer, nothing crashes', async () => {
  const fx = fixture(), st = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const a = mcp({ url: 'http://127.0.0.1:1' }, fx, st);
  try {
    await a.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
    a.notify('notifications/initialized');
    const s = await a.call('tools/call', { name: 'usage_sync_now', arguments: {} });
    assert.match(s.result.content[0].text, /Not sent: fetch failed/);
    const st2 = await a.call('tools/call', { name: 'usage_status', arguments: {} });
    assert.match(st2.result.content[0].text, /Last error: fetch failed/); assert.match(st2.result.content[0].text, /2 day\(s\) waiting/);
    const sum = await a.call('tools/call', { name: 'usage_summary', arguments: {} });
    assert.match(sum.result.content[0].text, /Could not reach the collector/);
    a.proc.stdin.end();
    const ex = await Promise.race([a.exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 10000))]);
    assert.equal(ex.code, 0);
  } finally { if (a.proc.exitCode === null) a.proc.kill(); }
});
