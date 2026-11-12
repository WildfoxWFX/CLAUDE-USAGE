'use strict';
/* The dashboard page in a real browser: the collector-served copy and the artifact copy (with a mocked claude.ai db).
   Needs Playwright with Chromium; skipped where they are not installed (the VPS, for instance). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../../collector/test/helpers');
const { createStore, installMock } = require('./mockdb');

let chromium = null;
for (const mod of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { chromium = require(mod).chromium; break; } catch (e) {} }
const EXE = ['/opt/pw-browsers/chromium', process.env.CHROMIUM].filter((p) => p && fs.existsSync(p))[0];
const skip = !chromium || !EXE ? 'playwright with chromium is not installed' : false;
const K = '?key=read-secret-1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(50); } return false; }

/* the stand-alone page as the artifact publishes it: the template with an empty built-in seed */
function artifactPage(dir) {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'ledger.tpl.html'), 'utf8');
  const seed = JSON.stringify({ generated: '2026-11-12', pcs: [{ label: 'vm · 192.0.2.2', system: 'test seed', rows: [['2026-11-10', 'claude-sonnet-5-5', 10, 20, 0, 0, 0.001]] }], sessions: [] });
  const f = path.join(dir, 'claude-usage-ledger.html');
  fs.writeFileSync(f, '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' + tpl.replace('/*__SEED__*/null', () => seed) + '\n</html>');
  return 'file://' + f;
}
const seedData = async (col) => {
  const yday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  await H.post(col.url + '/v1/usage', { member: { id: 'sathish@desktop-1', name: 'sathish', host: 'DESKTOP-1', system: 'Windows 11 (10.0.22631) x64 | 16 threads | 32 GB RAM', lastActivity: new Date().toISOString() }, tz: 'UTC', full: true, days: [[yday, 'claude-sonnet-5-5', 1000, 500, 20000, 300000, 12, 0]], sessions: [] });
  await H.post(col.url + '/v1/usage', { member: { id: 'priya@lap', name: 'priya', host: 'LAPTOP-2', lastActivity: new Date().toISOString() }, tz: 'UTC', full: true, days: [[yday, 'claude-opus-5-5', 10, 20, 0, 0, 1, 0]], sessions: [] });
};
const limits = (fiveHour, sevenDay, opus) => ({ member: { id: 'sathish@desktop-1' }, limits: { plan: 'max', checkedAt: new Date().toISOString(), windows: Object.assign({ fiveHour: { pct: fiveHour, resetsAt: new Date(Date.now() + 130 * 60000).toISOString() }, sevenDay: { pct: sevenDay, resetsAt: new Date(Date.now() + 3 * 86400e3 + 4 * 3600e3).toISOString() } }, opus === undefined ? {} : { sevenDayOpus: { pct: opus, resetsAt: new Date(Date.now() + 2 * 86400e3).toISOString() } }) } });

test('collector page: the account limit meter shows the windows with severity, and hides when there is no reading', { skip }, async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const errs = [];
  try {
    await seedData(col);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(col.url + '/' + K);
    assert.ok(await until(async () => (await page.locator('#pcsel option').count()) === 3), 'both PCs loaded');
    assert.ok(await page.locator('#limits').isHidden(), 'no reading yet: the section stays hidden');
    await H.post(col.url + '/v1/limits', limits(42.4, 91, 12));
    await page.reload();
    assert.ok(await until(async () => !(await page.locator('#limits').isHidden())), 'the meter appears');
    const rows = page.locator('#meterlist .meter');
    assert.equal(await rows.count(), 3);
    const names = await page.locator('#meterlist .meter .name').allInnerTexts();
    assert.deepEqual(names, ['5-hour window', 'Weekly, all models', 'Weekly, Opus']);
    const figs = await page.locator('#meterlist .meter .fig').allInnerTexts();
    assert.match(figs[0], /^42\.4% used\s*resets in 2 h 10 min/); assert.match(figs[1], /^91% used\s*near the limit\s*resets in 3 d 4 h/); assert.match(figs[2], /^12% used/);
    assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => e.className)), ['meter ok', 'meter danger', 'meter ok']);
    assert.deepEqual(await page.locator('#meterlist .fill').evaluateAll((els) => els.map((e) => e.style.width)), ['42.4%', '91%', '12%']);
    assert.equal(await page.locator('#meterlist .track').first().getAttribute('aria-valuenow'), '42');
    assert.match(await page.locator('#limits-meta').innerText(), /^Max plan · checked (just now|\d+ min ago) · on sathish · DESKTOP-1$/);
    /* high but not critical */
    await H.post(col.url + '/v1/limits', limits(80, 10));
    await page.reload();
    assert.ok(await until(async () => (await page.locator('#meterlist .meter').count()) === 2));
    assert.deepEqual(await page.locator('#meterlist .meter').evaluateAll((els) => els.map((e) => e.className)), ['meter warn', 'meter ok']);
    assert.match((await page.locator('#meterlist .fig').first().innerText()), /high/);
    /* phone width: no horizontal overflow */
    await page.setViewportSize({ width: 400, height: 800 });
    await sleep(200);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no horizontal scroll at 400px');
    assert.deepEqual(errs, []);
  } finally { await browser.close(); await col.stop(); }
});

test('artifact page: the meter comes through the live collector connection and goes away on disconnect', { skip }, async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir(), REPORT_TZ: 'UTC' });
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const errs = [];
  try {
    await seedData(col);
    await H.post(col.url + '/v1/limits', limits(55, 30));
    const url = artifactPage(fs.mkdtempSync(path.join(os.tmpdir(), 'page-')));
    const store = createStore(); store.docs.set('meta/settings', { live: { url: col.url, key: 'read-secret-1234' } });
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await installMock(ctx, store);
    const page = await ctx.newPage(); page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert.ok(await until(async () => (await page.locator('#storemode').innerText()).startsWith('Shared store')), 'shared store connected');
    assert.ok(await until(async () => !(await page.locator('#limits').isHidden())), 'meter shown from the live feed');
    assert.equal(await page.locator('#meterlist .meter').count(), 2);
    assert.ok(await until(async () => (await page.locator('#pcsel option').count()) === 4), 'built-in PC plus two live PCs');
    await page.click('#livedrop');
    assert.ok(await until(async () => page.locator('#limits').isHidden()), 'hidden after disconnect');
    assert.deepEqual(errs, []);
    await ctx.close();
  } finally { await browser.close(); await col.stop(); }
});
