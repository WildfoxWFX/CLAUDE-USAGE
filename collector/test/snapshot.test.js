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
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, tz: 'UTC', days: 3, sessions: 1, rejected: 0 });
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
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, tz: 'UTC', days: 1, sessions: 0, rejected: 9 });
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
