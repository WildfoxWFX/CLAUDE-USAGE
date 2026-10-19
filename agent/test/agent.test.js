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
  assert.deepEqual(r, { key: 'msg_1:req_1', ms: Date.parse('2026-10-18T10:00:00.000Z'), model: 'claude-sonnet-5-5', in: 5, out: 6, cw: 7, cr: 8, cw1h: 3, session: 'sess-A' });
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
    /* a log file disappears (Claude Code cleans old logs): everything is recounted, totals shrink accordingly */
    fs.unlinkSync(fx.sub);
    r = once(col, fx, st);
    assert.match(r.stderr, /log file\(s\) gone, recounting/);
    u = (await H.get(col.url + '/api/usage' + K)).json;
    assert.equal(u.members[0].rows.length, 3, 'the server keeps the day the PC no longer has');
    assert.deepEqual(u.members[0].rows.find((x) => x[1] === 'claude-haiku-5-5').slice(2, 4), [1, 2]);
    /* --everything re-sends it all */
    r = once(col, fx, st, {}, ['--everything']);
    assert.match(r.stdout, /Sent 2 day-and-model rows and 1 sessions \(everything this PC has\)/);
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

/* drive the agent as Claude Code would: JSON-RPC over stdio */
function mcp(col, fx, st) {
  const proc = spawn(process.execPath, [AGENT], { env: env(col, { USAGE_CLAUDE_DIR: fx.dir, USAGE_STATE_DIR: st, USAGE_INTERVAL_MS: '10000' }), stdio: ['pipe', 'pipe', 'pipe'] });
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
