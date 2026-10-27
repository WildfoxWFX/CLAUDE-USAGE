'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { start, tmpdir, otlp, multi, apiReq, post, get, sleep, until } = require('./helpers');

const K = '?key=read-secret-1234';
const sum = (rows, i) => rows.reduce((a, r) => a + r[i], 0);

test('health is open, the feed and pages need the read key', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    const h = await get(s.url + '/healthz');
    assert.equal(h.status, 200); assert.equal(h.json.ok, true); assert.equal(h.json.members, 0);
    assert.equal((await get(s.url + '/api/usage')).status, 401);
    assert.equal((await get(s.url + '/api/usage?key=wrong')).status, 401);
    const ok = await get(s.url + '/api/usage' + K);
    assert.equal(ok.status, 200); assert.deepEqual(ok.json.members, []); assert.deepEqual(ok.json.sessions, []); assert.equal(ok.json.tz, 'UTC');
    assert.equal((await get(s.url + '/api/usage', { 'x-read-key': 'read-secret-1234' })).status, 200);
    assert.equal((await get(s.url + '/api/usage', { authorization: 'Bearer read-secret-1234' })).status, 200);
    const page = await get(s.url + '/');
    assert.equal(page.status, 401); assert.match(page.text, /Read key needed/);
    assert.equal((await get(s.url + '/setup')).status, 401);
    assert.equal((await get(s.url + '/nope' + K)).status, 404);
  } finally { await s.stop(); }
});

test('ingest refuses bad keys, protobuf, bad JSON and oversize bodies', async () => {
  const s = await start({ DATA_DIR: tmpdir(), MAX_BODY_BYTES: '2000' });
  try {
    const body = otlp({}, [apiReq({})]);
    assert.equal((await post(s.url + '/v1/logs', body, { key: null })).status, 401);
    assert.equal((await post(s.url + '/v1/logs', body, { key: 'nope' })).status, 401);
    assert.equal((await post(s.url + '/v1/logs', body, { key: null, headers: { authorization: 'Bearer ingest-secret-1234' } })).status, 200);
    const pb = await post(s.url + '/v1/logs', body, { headers: { 'content-type': 'application/x-protobuf' } });
    assert.equal(pb.status, 415); assert.match(pb.json.error, /http\/json/);
    assert.equal((await post(s.url + '/v1/logs', '{not json')).status, 400);
    assert.equal((await post(s.url + '/v1/logs', '[1,2]')).status, 400);
    const big = await post(s.url + '/v1/logs', JSON.stringify({ resourceLogs: [], pad: 'x'.repeat(5000) }));
    assert.equal(big.status, 413);
    assert.equal((await get(s.url + '/api/usage' + K)).json.members.length, 1, 'the bearer-authorised post was kept');
  } finally { await s.stop(); }
});

test('api_request events become per-member, per-day, per-model rows and sessions', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    const body = multi([
      { attrs: { 'member.name': 'harsh', 'member.id': 'harsh@pc1', 'member.host': 'PC1' }, records: [
        apiReq({ time: '2026-10-17T10:00:00Z', in: 100, out: 50, cw: 200, cr: 1000, cost: 0.01, session: 'A' }),
        apiReq({ time: '2026-10-17T11:00:00Z', in: 10, out: 5, cw: 20, cr: 100, cost: 0.002, session: 'A' }),
        apiReq({ time: '2026-10-17T12:00:00Z', model: 'claude-opus-4-1-20250805', in: 7, out: 3, cw: 0, cr: 0, cost: 0.5, session: 'B' }),
        apiReq({ time: '2026-10-18T09:00:00Z', in: 1, out: 1, cw: 1, cr: 1, cost: 0.0001, session: 'B' }),
        { attrs: { 'event.name': 'user_prompt', prompt_length: '12', 'session.id': 'A' } },
        { attrs: { 'event.name': 'tool_result', tool_name: 'Read', success: 'true' } },
      ] },
      { attrs: { 'member.name': 'priya', 'member.id': 'priya@laptop', 'member.host': 'LAPTOP-2', 'os.type': 'darwin', 'os.version': '24.6.0', 'host.arch': 'arm64' }, records: [
        apiReq({ time: '2026-10-17T10:30:00Z', in: 1000, out: 500, cw: 0, cr: 0, cost: 0.1, session: 'C' }),
      ] },
    ]);
    const r = await post(s.url + '/v1/logs', body, { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    assert.equal(r.status, 200); assert.deepEqual(r.json, {});
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.equal(u.members.length, 2);
    const h = u.members.find((m) => m.id === 'harsh@pc1'), p = u.members.find((m) => m.id === 'priya@laptop');
    assert.equal(h.label, 'harsh · PC1');
    assert.equal(p.label, 'priya · LAPTOP-2');
    assert.deepEqual(h.rows, [
      ['2026-10-17', 'claude-opus-4-1-20250805', 7, 3, 0, 0, 0.5],
      ['2026-10-17', 'claude-sonnet-4-5-20250929', 110, 55, 220, 1100, 0.012],
      ['2026-10-18', 'claude-sonnet-4-5-20250929', 1, 1, 1, 1, 0.0001],
    ]);
    assert.deepEqual(p.rows, [['2026-10-17', 'claude-sonnet-4-5-20250929', 1000, 500, 0, 0, 0.1]]);
    assert.match(h.system, /^Windows 10\.0\.22631 \| x64 \| Claude Code 2\.1\.0 \| IP 203\.0\.113\.9$/);
    assert.match(p.system, /^macOS 24\.6\.0 \| arm64 \| Claude Code 2\.1\.0 \| IP 203\.0\.113\.9$/);
    assert.equal(h.lastSeen, '2026-10-18T09:00:00.000Z'); assert.equal(h.events, 4);
    assert.equal(u.sessions.length, 3);
    assert.equal(u.sessions[0].id, 'B'); assert.equal(u.sessions[0].pc, 'harsh · PC1'); assert.equal(u.sessions[0].cost, 0.5001);
    assert.deepEqual(u.sessions[0].models, ['claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929']);
    assert.equal(u.sessions[0].all, 7 + 3 + 1 + 1 + 1 + 1); assert.equal(u.sessions[0].out, 4); assert.equal(u.sessions[0].last, '2026-10-18T09:00:00.000Z');
    assert.equal(u.stats.events, 5); assert.equal(u.stats.other, 2); assert.equal(u.stats.duplicates, 0);
    const h2 = await get(s.url + '/healthz');
    assert.equal(h2.json.members, 2); assert.equal(h2.json.events, 5);
  } finally { await s.stop(); }
});

test('a re-sent batch is not counted twice, with or without request ids', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    const withId = otlp({ 'member.name': 'a', 'member.id': 'a@x' }, [apiReq({ rid: 'req_fixed_1', in: 10, out: 10, cw: 0, cr: 0, cost: 1 })]);
    const noId = otlp({ 'member.name': 'a', 'member.id': 'a@x' }, [apiReq({ rid: null, time: '2026-10-18T10:00:01Z', in: 5, out: 5, cw: 0, cr: 0, cost: 2 })]);
    for (let i = 0; i < 3; i++) { await post(s.url + '/v1/logs', withId); await post(s.url + '/v1/logs', noId); }
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members[0].rows, [['2026-10-18', 'claude-sonnet-4-5-20250929', 15, 15, 0, 0, 3]]);
    assert.equal(u.stats.events, 2); assert.equal(u.stats.duplicates, 4);
    /* two different requests in the same second without ids are both kept */
    const twin = otlp({ 'member.name': 'a', 'member.id': 'a@x' }, [apiReq({ rid: null, time: '2026-10-18T10:00:01Z', in: 6, out: 5, cw: 0, cr: 0, cost: 2 })]);
    await post(s.url + '/v1/logs', twin);
    assert.equal((await get(s.url + '/api/usage' + K)).json.members[0].rows[0][2], 21);
  } finally { await s.stop(); }
});

test('member identity: percent-encoded names, no member attributes, duplicate labels, cost in micros, odd models', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    await post(s.url + '/v1/logs', multi([
      { attrs: { 'member.name': 'Harsh%20Patel', 'member.id': 'hp@pc', 'member.host': 'PC-9' }, records: [apiReq({ extra: { cost_usd_micros: '12345', cost_usd: '9' } })] },
      { attrs: { 'user.account_uuid': 'acc-1' }, records: [apiReq({ extra: { 'user.email': 'shared@example.com' } })] },
      { attrs: { 'member.name': 'sam' }, records: [apiReq({ session: 's1' })] },
      { attrs: { 'member.name': 'sam', 'member.id': 'sam-other' }, records: [apiReq({ session: 's2' })] },
      { attrs: { 'member.name': 'bed', 'member.id': 'bed' }, records: [
        apiReq({ model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', in: 1, out: 1, cw: 0, cr: 0, cost: 0 }),
        apiReq({ model: 'claude-3-5-sonnet@20240620', in: 2, out: 2, cw: 0, cr: 0, cost: 0 }),
        apiReq({ model: 'gpt-4o', in: 3, out: 3, cw: 0, cr: 0, cost: 0 }),
        apiReq({ model: '<synthetic>', in: 4, out: 4, cw: 0, cr: 0, cost: 0 }),
        { attrs: { 'event.name': 'api_request', model: 'claude-sonnet-4-5-20250929', input_tokens: 'abc', output_tokens: '1', cache_read_tokens: '0', cache_creation_tokens: '0' } },
        { attrs: { 'event.name': 'api_request', model: 'claude-sonnet-4-5-20250929', input_tokens: '-5', output_tokens: '1', cache_read_tokens: '0', cache_creation_tokens: '0' } },
      ] },
    ]));
    const u = (await get(s.url + '/api/usage' + K)).json;
    const byId = Object.fromEntries(u.members.map((m) => [m.id, m]));
    assert.equal(byId['hp@pc'].label, 'Harsh Patel · PC-9');
    assert.equal(byId['hp@pc'].rows[0][6], 0.012345, 'cost_usd_micros wins over cost_usd');
    assert.equal(byId['account:acc-1'].label, 'shared@example.com');
    assert.equal(byId['name:sam'].label, 'sam'); assert.equal(byId['sam-other'].label, 'sam #2');
    assert.deepEqual(byId.bed.rows.map((r) => [r[1], r[2]]), [['claude-3-5-sonnet-20240620', 2], ['claude-sonnet-4-5-20250929', 1]]);
    assert.equal(u.stats.skipped, 4);
    /* a PC whose clock runs ahead: its events count for today, not for a day that has not happened */
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'fut', 'member.id': 'fut' }, [apiReq({ time: new Date(Date.now() + 3 * 3600e3).toISOString() })]));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    assert.equal((await get(s.url + '/api/usage' + K)).json.members.find((m) => m.id === 'fut').rows[0][0], today);
  } finally { await s.stop(); }
});

test('REPORT_TZ decides the day; a bad zone falls back to UTC', async () => {
  const s = await start({ DATA_DIR: tmpdir(), REPORT_TZ: 'Asia/Kolkata' });
  try {
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'z', 'member.id': 'z' }, [apiReq({ time: '2026-10-18T20:00:00Z' }), apiReq({ time: '2026-10-18T18:00:00Z' })]));
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.equal(u.tz, 'Asia/Kolkata');
    assert.deepEqual(u.members[0].rows.map((r) => r[0]), ['2026-10-18', '2026-10-19']);
  } finally { await s.stop(); }
  const s2 = await start({ DATA_DIR: tmpdir(), REPORT_TZ: 'Mars/Olympus' });
  try { assert.equal((await get(s2.url + '/api/usage' + K)).json.tz, 'UTC'); assert.match(s2.out.join(''), /not a valid time zone/); } finally { await s2.stop(); }
});

test('the store survives a restart and a gzip body is accepted', async () => {
  const dir = tmpdir();
  let s = await start({ DATA_DIR: dir });
  try {
    const r = await post(s.url + '/v1/logs', otlp({ 'member.name': 'g', 'member.id': 'g@pc' }, [apiReq({ in: 42 })]), { gzip: true });
    assert.equal(r.status, 200);
    assert.ok(await until(() => fs.existsSync(path.join(dir, 'store.json'))), 'store.json written');
  } finally { await s.stop(); }
  s = await start({ DATA_DIR: dir });
  try {
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.equal(u.members.length, 1); assert.equal(u.members[0].rows[0][2], 42);
    assert.match(s.out.join(''), /loaded 1 members from/);
    /* and the de-duplication memory came back too */
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'g', 'member.id': 'g@pc' }, [apiReq({ in: 42, rid: 'again' })]));
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'g', 'member.id': 'g@pc' }, [apiReq({ in: 42, rid: 'again' })]));
    assert.equal((await get(s.url + '/api/usage' + K)).json.members[0].rows[0][2], 84);
  } finally { await s.stop(); }
});

test('metrics and traces are accepted and dropped; CORS answers preflight', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    assert.equal((await post(s.url + '/v1/metrics', { resourceMetrics: [] })).status, 200);
    assert.equal((await post(s.url + '/v1/traces', { resourceSpans: [] })).status, 200);
    assert.equal((await post(s.url + '/v1/metrics', {}, { key: null })).status, 401);
    const pre = await fetch(s.url + '/api/usage', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'GET' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    const g = await get(s.url + '/api/usage' + K);
    assert.equal(g.headers.get('access-control-allow-origin'), '*'); assert.equal(g.headers.get('cache-control'), 'no-store');
  } finally { await s.stop(); }
});

test('the dashboard and setup pages are served with the read key', async () => {
  const s = await start({ DATA_DIR: tmpdir() });
  try {
    const page = await get(s.url + '/' + K);
    assert.equal(page.status, 200);
    assert.match(page.text, /^<!doctype html>/);
    assert.match(page.text, /<title>Claude Usage Ledger<\/title>/);
    assert.match(page.text, /var LIVE_CFG = \{"embedded":true,"tz":"UTC"\};/);
    assert.match(page.text, /var SEED = \{"generated":"\d{4}-\d{2}-\d{2}","pcs":\[\],"sessions":\[\]\};/);
    assert.doesNotMatch(page.text, /__SEED__|__LIVE__/);
    const setup = await get(s.url + '/setup' + K);
    assert.equal(setup.status, 200); assert.match(setup.text, /<title>Set up a PC<\/title>/);
    assert.equal((await get(s.url + '/robots.txt')).text, 'User-agent: *\nDisallow: /\n');
  } finally { await s.stop(); }
});

test('without a template the feed still works and the page says so', async () => {
  const s = await start({ DATA_DIR: tmpdir(), LEDGER_TEMPLATE: '/nonexistent/ledger.tpl.html' });
  try {
    assert.equal((await get(s.url + '/api/usage' + K)).status, 200);
    const page = await get(s.url + '/' + K);
    assert.equal(page.status, 503); assert.match(page.text, /template is missing/);
  } finally { await s.stop(); }
});

test('it refuses to start without INGEST_KEY', async () => {
  await assert.rejects(start({ DATA_DIR: tmpdir(), INGEST_KEY: '' }), /INGEST_KEY is not set/);
});

/* a stand-in for api.github.com: GET and PUT /repos/:owner/:repo/contents/:path */
function fakeGitHub() {
  const files = new Map(), puts = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(u.pathname);
    if (!m) { res.writeHead(404); return res.end('{}'); }
    if (req.headers.authorization !== 'Bearer gh-token') { res.writeHead(401); return res.end('{}'); }
    const key = m[1] + '/' + decodeURIComponent(m[2]);
    if (req.method === 'GET') {
      const f = files.get(key);
      if (!f) { res.writeHead(404); return res.end('{"message":"Not Found"}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ sha: f.sha, content: f.content, encoding: 'base64' }));
    }
    if (req.method === 'PUT') {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        const j = JSON.parse(body); const cur = files.get(key);
        if (cur && j.sha !== cur.sha) { res.writeHead(409); return res.end('{"message":"sha mismatch"}'); }
        if (!cur && j.sha) { res.writeHead(422); return res.end('{"message":"sha given for a new file"}'); }
        const sha = 'sha' + (puts.length + 1); files.set(key, { sha, content: j.content }); puts.push({ key, message: j.message, branch: j.branch, sha: j.sha });
        res.writeHead(cur ? 200 : 201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: { sha } }));
      });
      return;
    }
    res.writeHead(405); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port, files, puts, close: () => new Promise((r) => srv.close(r)) })));
}

test('GitHub mirror: uploads on a schedule and on shutdown, and a fresh server loads from it', async () => {
  const gh = await fakeGitHub();
  const envGH = { GITHUB_BACKUP: 'wildfox/claude-usage', GITHUB_TOKEN: 'gh-token', GITHUB_API: gh.url, GITHUB_BACKUP_INTERVAL_MS: '300', GITHUB_BACKUP_BRANCH: 'usage-data' };
  let s = await start(Object.assign({ DATA_DIR: tmpdir() }, envGH));
  try {
    assert.match(s.out.join(''), /no store in GitHub yet/);
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'm', 'member.id': 'm@pc' }, [apiReq({ in: 77, time: '2026-10-17T10:00:00Z' })]));
    assert.ok(await until(() => gh.puts.length >= 1, 5000), 'scheduled upload happened');
    assert.equal(gh.puts[0].key, 'wildfox/claude-usage/data/usage-store.json'); assert.equal(gh.puts[0].branch, 'usage-data'); assert.equal(gh.puts[0].sha, undefined);
    const stored = JSON.parse(Buffer.from(gh.files.get(gh.puts[0].key).content, 'base64').toString('utf8'));
    assert.equal(stored.members['m@pc'].name, 'm');
    const n = gh.puts.length;
    await sleep(700);
    assert.equal(gh.puts.length, n, 'nothing new to upload, so no more uploads');
    await post(s.url + '/v1/logs', otlp({ 'member.name': 'm', 'member.id': 'm@pc' }, [apiReq({ in: 1 })]));
  } finally { await s.stop(); }
  if (process.platform !== 'win32') { /* a Windows kill is not a shutdown; the real service stops with Ctrl+C (SIGINT), which does upload */
    assert.ok(gh.puts.length >= 2, 'shutdown uploaded the last change');
    assert.ok(gh.puts[gh.puts.length - 1].sha, 'the update carried the previous sha');
  }
  /* a new instance with an empty disk, as after a redeploy on a host without a persistent disk */
  s = await start(Object.assign({ DATA_DIR: tmpdir() }, envGH));
  try {
    assert.match(s.out.join(''), /loaded 1 members from github\.com\/wildfox\/claude-usage/);
    const u = (await get(s.url + '/api/usage' + K)).json;
    assert.deepEqual(u.members[0].rows.map((r) => [r[0], r[2]]), [['2026-10-17', 77], ['2026-10-18', 1]]);
    assert.equal((await get(s.url + '/healthz')).json.mirror, 'wildfox/claude-usage');
  } finally { await s.stop(); }
  await gh.close();
});

test('GitHub mirror failures are logged and never break ingest', async () => {
  const s = await start({ DATA_DIR: tmpdir(), GITHUB_BACKUP: 'wildfox/claude-usage', GITHUB_TOKEN: 'gh-token', GITHUB_API: 'http://127.0.0.1:1', GITHUB_BACKUP_INTERVAL_MS: '200' });
  try {
    assert.match(s.out.join(''), /could not load the store from GitHub/);
    assert.equal((await post(s.url + '/v1/logs', otlp({ 'member.name': 'm', 'member.id': 'm' }, [apiReq({})]))).status, 200);
    assert.ok(await until(() => /GitHub mirror failed/.test(s.out.join('')), 3000));
    assert.equal((await get(s.url + '/api/usage' + K)).json.members.length, 1);
  } finally { await s.stop(); }
});
