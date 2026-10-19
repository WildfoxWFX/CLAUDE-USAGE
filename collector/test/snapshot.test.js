'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, tmpdir, otlp, apiReq, post, get, until } = require('./helpers');
const K = '?key=read-secret-1234';

const snap = (o) => Object.assign({ agent: { version: '1.0.0', node: 'v22' }, member: { id: 'harsh@desktop-1', name: 'harsh', host: 'DESKTOP-1', system: 'Windows 11 (10.0.22631) x64 | Ryzen 7, 16 threads | 32 GB RAM | Claude Code 2.1.303', lastActivity: '2026-10-18T09:30:00Z' }, tz: 'UTC', full: true, days: [], sessions: [] }, o || {});

test('snapshots replace per-day totals, price them, and never double count', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    const body = snap({ days: [
      ['2026-10-17', 'claude-sonnet-5-5', 1000, 200, 500000, 2000000, 12, 100000],
      ['2026-10-18', 'claude-sonnet-5-5', 10, 20, 0, 0, 1, 0],
      ['2026-10-18', 'claude-opus-4-1-20250805', 100, 300, 0, 0, 2, 0] ],
      sessions: [{ id: 'S1', first: '2026-10-17T08:00:00Z', last: '2026-10-18T09:30:00Z', n: 13, byModel: { 'claude-sonnet-5-5': [1010, 220, 500000, 2000000, 100000] } }] });
    const r = await post(s.url + '/v1/usage', body, { headers: { 'x-forwarded-for': '192.168.1.20' } });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, tz: 'UTC', days: 3, sessions: 1, rejected: 0, removed: 0 });
    let u = (await get(s.url + '/api/usage' + K)).json;
    assert.equal(u.members.length, 1);
    const m = u.members[0];
    assert.equal(m.label, 'harsh · DESKTOP-1'); assert.equal(m.source, 'agent');
    assert.equal(m.system, 'Windows 11 (10.0.22631) x64 | Ryzen 7, 16 threads | 32 GB RAM | Claude Code 2.1.303 | IP 192.168.1.20');
    assert.equal(m.lastSeen, '2026-10-18T09:30:00.000Z'); assert.equal(m.events, 15);
    /* sonnet 5.5: in 2, out 10, cw 2.5 (5 min) / 4 (1 h), cr 0.1 per million */
    const row = m.rows.find((x) => x[0] === '2026-10-17');
    assert.deepEqual(row.slice(0, 6), ['2026-10-17', 'claude-sonnet-5-5', 1000, 200, 500000, 2000000]);
    assert.equal(row[6], (1000 * 2 + 200 * 10 + 400000 * 2.5 + 100000 * 4 + 2000000 * 0.1) / 1e6);
    assert.equal(m.rows.find((x) => x[1] === 'claude-opus-4-1-20250805')[6], (100 * 15 + 300 * 75) / 1e6);
    assert.equal(u.sessions.length, 1); assert.equal(u.sessions[0].pc, 'harsh · DESKTOP-1'); assert.equal(u.sessions[0].all, 1010 + 220 + 500000 + 2000000);
    assert.deepEqual(u.pricing, { 'claude-opus-4-1-20250805': 'table', 'claude-sonnet-5-5': 'table' });
    /* the same snapshot again, and a corrected day: replaced, not added */
    await post(s.url + '/v1/usage', body);
    await post(s.url + '/v1/usage', snap({ full: false, days: [['2026-10-18', 'claude-sonnet-5-5', 11, 25, 0, 0, 2, 0]] }));
    u = (await get(s.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members[0].rows.map((x) => [x[0], x[1], x[2], x[3]]), [['2026-10-17', 'claude-sonnet-5-5', 1000, 200], ['2026-10-18', 'claude-opus-4-1-20250805', 100, 300], ['2026-10-18', 'claude-sonnet-5-5', 11, 25]]);
    assert.equal(u.members[0].events, 16);
    assert.equal(u.stats.snapshots, 3);
  } finally { await s.stop(); }
});

test('bad snapshots are refused or trimmed; the agent wins over telemetry for the same PC', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    assert.equal((await post(s.url + '/v1/usage', snap(), { key: 'nope' })).status, 401);
    assert.equal((await post(s.url + '/v1/usage', { days: [] })).status, 400);
    assert.equal((await post(s.url + '/v1/usage', snap({ member: { name: 'x' } }))).status, 400);
    assert.equal((await post(s.url + '/v1/usage', '[1]')).status, 400);
    const r = await post(s.url + '/v1/usage', snap({ days: [
      ['2026-10-18', 'claude-sonnet-5-5', 1, 1, 0, 0, 1, 0],
      ['2026-13-40', 'claude-sonnet-5-5', 1, 1, 0, 0, 1, 0],
      ['2026-10-18', 'gpt-4', 1, 1, 0, 0, 1, 0],
      ['2026-10-18', 'claude-haiku-5-5', 'x', 1, 0, 0, 1, 0],
      'junk', [1, 2] ],
      sessions: [{ id: '', last: '2026-10-18T00:00:00Z', byModel: { 'claude-sonnet-5-5': [1, 1, 0, 0, 0] } }, { id: 'ok', last: 'never', byModel: {} }, { id: 'ok2', last: '2026-10-18T00:00:00Z', byModel: { 'gpt-4': [1, 1, 0, 0, 0] } }, 5] }));
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, tz: 'UTC', days: 1, sessions: 0, rejected: 9, removed: 0 });
    /* telemetry events for a PC the agent reports are dropped */
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'harsh', 'member.id': 'harsh@desktop-1', 'member.host': 'DESKTOP-1' }, [apiReq({ in: 999, time: '2026-10-18T10:00:00Z' })]));
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members[0].rows.map((x) => x.slice(0, 4)), [['2026-10-18', 'claude-sonnet-5-5', 1, 1]]);
    assert.equal(u.stats.otelSkipped, 1);
    /* a different PC still comes in over telemetry */
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'priya', 'member.id': 'priya@lap' }, [apiReq({ in: 5, time: '2026-10-18T10:00:00Z' })]));
    const u2 = (await get(s.url + '/api/usage' + K)).json;
    assert.equal(u2.members.length, 2); assert.equal(u2.members.find((m) => m.id === 'priya@lap').source, 'otel');
  } finally { await s.stop(); }
});

test('snapshots survive a restart; a price file overrides the table; the ingest key reads the feed', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify({ 'claude-zed-9': { in: 1, out: 2 }, 'claude-sonnet-5-5': { in: 100, out: 100, cw: 100, cr: 100, cw1h: 100 } }));
  let s = await start({ DATA_DIR: dir });
  try {
    assert.match(s.out.join(''), /prices: 2 entries from/);
    await post(s.url + '/v1/usage', snap({ days: [['2026-10-18', 'claude-sonnet-5-5', 1000000, 0, 0, 0, 1, 0], ['2026-10-18', 'claude-zed-9-20260101', 1000000, 1000000, 0, 0, 1, 0]] }));
    const u = (await get(s.url + '/api/usage', { 'x-api-key': 'ingest-secret-1234' }));
    assert.equal(u.status, 401, 'x-api-key is not a read header');
    const u2 = (await get(s.url + '/api/usage', { 'x-read-key': 'ingest-secret-1234' })).json;
    assert.equal(u2.members[0].rows.find((x) => x[1] === 'claude-sonnet-5-5')[6], 100);
    assert.equal(u2.members[0].rows.find((x) => x[1] === 'claude-zed-9-20260101')[6], 3);
    assert.equal(u2.pricing['claude-zed-9-20260101'], 'file');
    assert.ok(await until(() => fs.existsSync(path.join(dir, 'store.json'))));
  } finally { await s.stop(); }
  s = await start({ DATA_DIR: dir });
  try {
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.equal(u.members[0].source, 'agent'); assert.equal(u.members[0].rows.length, 2);
  } finally { await s.stop(); }
});

test('the agent script is served for the install command', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    const a = await get(s.url + '/agent.js');
    assert.equal(a.status, 200); assert.match(a.headers.get('content-type'), /javascript/); assert.match(a.text, /^#!\/usr\/bin\/env node/); assert.match(a.text, /usage_sync_now/);
    assert.match(a.headers.get('x-agent-version'), /^\d+\.\d+\.\d+$/);
    const v = await get(s.url + '/agent/version');
    assert.equal(v.json.version, a.headers.get('x-agent-version'));
  } finally { await s.stop(); }
  const s2 = await start({ DATA_DIR: tmpdir(), AGENT_FILE: '/nonexistent/agent.js' });
  try { assert.equal((await get(s2.url + '/agent.js')).status, 404); assert.match(s2.out.join(''), /agent file not found/); } finally { await s2.stop(); }
});

test('an unknown model is priced by family and reported so', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    await post(s.url + '/v1/usage', snap({ days: [['2026-10-18', 'claude-opus-9-9-20270101', 1000000, 0, 0, 0, 1, 0], ['2026-10-18', 'claude-zork-1', 1000000, 0, 0, 0, 1, 0]] }));
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.equal(u.members[0].rows.find((x) => x[1] === 'claude-opus-9-9-20270101')[6], 15, 'opus family price');
    assert.equal(u.members[0].rows.find((x) => x[1] === 'claude-zork-1')[6], 0);
    assert.equal(u.pricing['claude-opus-9-9-20270101'], 'family:claude-opus-4-1'); assert.equal(u.pricing['claude-zork-1'], 'unknown');
  } finally { await s.stop(); }
});

const zlib = require('zlib');

test('all-zero rows retract a cell: a PC whose day zone changed cleans up after itself', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    await post(s.url + '/v1/usage', snap({ days: [['2026-10-18', 'claude-sonnet-5-5', 1, 1, 0, 0, 1, 0], ['2026-10-19', 'claude-opus-4-1', 7, 3, 0, 0, 1, 0]] }));
    const r = await post(s.url + '/v1/usage', snap({ full: false, days: [['2026-10-18', 'claude-opus-4-1', 7, 3, 0, 0, 1, 0], ['2026-10-19', 'claude-opus-4-1', 0, 0, 0, 0, 0, 0], ['2026-10-20', 'claude-opus-4-1', 0, 0, 0, 0, 0, 0]] }));
    assert.deepEqual(r.json, { ok: true, tz: 'UTC', days: 1, sessions: 0, rejected: 0, removed: 1 });
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members[0].rows.map((x) => [x[0], x[1], x[3]]), [['2026-10-18', 'claude-opus-4-1', 3], ['2026-10-18', 'claude-sonnet-5-5', 1]]);
    assert.equal(u.members[0].events, 2);
  } finally { await s.stop(); }
});

test('ids that are special property names are refused everywhere', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      const r = await post(s.url + '/v1/usage', snap({ member: { id: bad, name: 'x' }, days: [['2026-10-19', 'claude-opus-4-1', 1, 1, 0, 0, 1, 0]] }));
      assert.equal(r.status, 400, bad); assert.match(r.json.error, /not allowed/);
    }
    const r2 = await post(s.url + '/v1/usage', snap({ sessions: [{ id: '__proto__', last: '2026-10-18T00:00:00Z', byModel: { 'claude-sonnet-5-5': [1, 1, 0, 0, 0] } }, { id: 'constructor', last: '2026-10-18T00:00:00Z', byModel: { 'claude-sonnet-5-5': [1, 1, 0, 0, 0] } }] }));
    assert.equal(r2.json.rejected, 2); assert.equal(r2.json.sessions, 0);
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'p', 'member.id': '__proto__' }, [apiReq({ time: '2026-10-18T10:00:00Z' })]));
    /* nothing leaked onto Object.prototype: a fresh member still behaves normally */
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'priya', 'member.id': 'priya@lap' }, [apiReq({ time: '2026-10-18T10:00:00Z', in: 5 }), apiReq({ time: '2026-10-18T11:00:00Z', in: 6 })]));
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members.map((m) => m.id), ['harsh@desktop-1', 'priya@lap']);
    assert.equal(u.members.find((m) => m.id === 'priya@lap').rows[0][2], 11);
    assert.equal(u.members.find((m) => m.id === 'priya@lap').source, 'otel');
  } finally { await s.stop(); }
});

test('a compressed body that inflates past the limit is refused, not inflated', async () => {
  const s = await start({ DATA_DIR: tmpdir(), MAX_BODY_BYTES: '200000' });
  try {
    const big = JSON.stringify(snap({ days: Array.from({ length: 6000 }, (_, i) => ['2026-10-18', 'claude-sonnet-5-5', i, 1, 0, 0, 1, 0]) }));
    assert.ok(big.length > 200000);
    const r = await post(s.url + '/v1/usage', big, { gzip: true });
    assert.equal(r.status, 413); assert.match(r.json.error, /once decompressed/);
    const ok = await post(s.url + '/v1/usage', JSON.stringify(snap({ days: [['2026-10-18', 'claude-sonnet-5-5', 1, 1, 0, 0, 1, 0]] })), { gzip: true });
    assert.equal(ok.status, 200);
    const broken = await fetch(s.url + '/v1/usage', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-api-key': 'ingest-secret-1234' }, body: Buffer.from('not gzip at all') });
    assert.equal(broken.status, 400);
  } finally { await s.stop(); }
});

test('a member id is bound to the first agent that reports it; the read key can remove a member', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    const mine = snap({ member: { id: 'boss@desk', name: 'boss', host: 'DESK', token: 'tok-A' }, days: [['2026-10-18', 'claude-sonnet-5-5', 100, 100, 0, 0, 1, 0]] });
    assert.equal((await post(s.url + '/v1/usage', mine)).status, 200);
    const spoof = await post(s.url + '/v1/usage', snap({ member: { id: 'boss@desk', name: 'nobody', host: 'pwned', token: 'tok-B', lastActivity: '2999-01-01T00:00:00Z' }, days: [['2026-10-18', 'claude-sonnet-5-5', 0, 0, 0, 0, 0, 0]] }));
    assert.equal(spoof.status, 403); assert.match(spoof.json.error, /another installation already reports as/); assert.match(spoof.json.error, /DELETE \/api\/members\/boss%40desk/);
    const noTok = await post(s.url + '/v1/usage', snap({ member: { id: 'boss@desk', name: 'nobody' }, days: [] }));
    assert.equal(noTok.status, 403);
    let u = (await get(s.url + '/api/usage' + K)).json;
    let m = u.members.find((x) => x.id === 'boss@desk');
    assert.equal(m.label, 'boss · DESK'); assert.equal(m.rows[0][2], 100); assert.equal(m.bound, true);
    assert.equal((await post(s.url + '/v1/usage', Object.assign({}, mine, { days: [['2026-10-18', 'claude-sonnet-5-5', 101, 100, 0, 0, 1, 0]] }))).status, 200, 'the same token keeps working');
    /* members without a token (telemetry, older agents) are unbound until an agent claims them */
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'priya', 'member.id': 'priya@lap' }, [apiReq({ time: '2026-10-18T10:00:00Z' })]));
    assert.equal((await post(s.url + '/v1/usage', snap({ member: { id: 'priya@lap', name: 'priya', token: 'tok-P' }, days: [] }))).status, 200);
    assert.equal((await post(s.url + '/v1/usage', snap({ member: { id: 'priya@lap', name: 'priya', token: 'tok-Q' }, days: [] }))).status, 403);
    /* removal needs the read key */
    assert.equal((await fetch(s.url + '/api/members/boss%40desk', { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(s.url + '/api/members/nobody%40here' + K, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(s.url + '/api/members/__proto__' + K, { method: 'DELETE' })).status, 404);
    const del = await fetch(s.url + '/api/members/boss%40desk' + K, { method: 'DELETE' });
    assert.equal(del.status, 200);
    u = (await get(s.url + '/api/usage' + K)).json;
    assert.ok(!u.members.some((x) => x.id === 'boss@desk'));
    assert.equal((await post(s.url + '/v1/usage', snap({ member: { id: 'boss@desk', name: 'boss2', token: 'tok-B' }, days: [['2026-10-19', 'claude-sonnet-5-5', 1, 1, 0, 0, 1, 0]] }))).status, 200, 'after removal a new installation can take the id');
    assert.equal((await fetch(s.url + '/api/usage' + K, { method: 'DELETE' })).status, 404);
  } finally { await s.stop(); }
});

test('timestamps from the future are clamped and one member cannot push another’s sessions out', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    await post(s.url + '/v1/usage', snap({ member: { id: 'a@a', name: 'a', lastActivity: '2999-01-01T00:00:00Z' }, sessions: [{ id: 'real', last: '2026-10-18T09:00:00Z', byModel: { 'claude-sonnet-5-5': [1, 1, 0, 0, 0] } }] }));
    const flood = Array.from({ length: 450 }, (_, i) => ({ id: 'f' + i, last: '2999-01-01T00:00:00Z', byModel: { 'claude-sonnet-5-5': [1, 1, 0, 0, 0] } }));
    await post(s.url + '/v1/usage', snap({ member: { id: 'b@b', name: 'b' }, sessions: flood }));
    const u = (await get(s.url + '/api/usage' + K)).json;
    const a = u.members.find((m) => m.id === 'a@a');
    assert.ok(Date.parse(a.lastSeen) <= Date.now() + 3600e3 + 5000, a.lastSeen);
    assert.ok(Date.parse(u.stats.lastEvent) <= Date.now() + 3600e3 + 5000, u.stats.lastEvent);
    const health = (await get(s.url + '/healthz')).json;
    assert.ok(Date.parse(health.lastEvent) <= Date.now() + 3600e3 + 5000);
    assert.ok(u.sessions.some((x) => x.id === 'real' && x.pc === 'a'), 'the other member’s session is still there');
    /* a session id reported by one PC cannot be rewritten by another */
    const steal = await post(s.url + '/v1/usage', snap({ member: { id: 'b@b', name: 'b' }, sessions: [{ id: 'real', last: '2026-10-18T09:00:00Z', byModel: { 'claude-sonnet-5-5': [999, 999, 0, 0, 0] } }] }));
    assert.equal(steal.json.rejected, 1);
  } finally { await s.stop(); }
});
