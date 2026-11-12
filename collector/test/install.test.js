'use strict';
/* The install commands the setup page writes, run for real: PowerShell (pwsh) and bash, with the real `claude` CLI
   pointed at a scratch config directory. Skipped where pwsh, claude or Chromium are missing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers');

let chromium = null;
for (const mod of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { chromium = require(mod).chromium; break; } catch (e) {} }
const EXE = ['/opt/pw-browsers/chromium', process.env.CHROMIUM].filter((p) => p && fs.existsSync(p))[0];
const PWSH = [process.env.PWSH, '/tmp/claude-0/-home-user-CLAUDE-USAGE/1b3476ee-536d-5e0c-809b-019efd8c9b5e/scratchpad/pwsh/ps7/pwsh', 'pwsh'].filter(Boolean).find((p) => { try { return spawnSync(p, ['-NoProfile', '-Command', '1'], { timeout: 20000 }).status === 0; } catch (e) { return false; } });
const CLAUDE = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 }).status === 0;
const skip = !chromium || !EXE ? 'needs playwright with chromium' : (!CLAUDE ? 'needs the claude CLI' : false);
const RK = 'read-secret-1234', IK = 'ingest-secret-1234';

async function commands(col) {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(col.url + '/setup?key=' + RK);
    await page.fill('#who', 'Harsh Patel'); await page.fill('#key', IK); await page.click('button[type=submit]');
    return { aps: await page.locator('#aps').innerText(), ash: await page.locator('#ash').innerText() };
  } finally { await browser.close(); }
}
function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'));
  fs.writeFileSync(path.join(cfg, '.claude.json'), '{}');
  fs.mkdirSync(path.join(cfg, 'projects'));
  return { home, cfg, env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg }) };
}
const servers = (cfg) => { try { return JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8')).mcpServers || {}; } catch (e) { return {}; } };
const hostName = os.hostname().split('.')[0];

test('the generated install commands register the agent, the status line, and send', { skip }, async () => {
  const col = await H.start({ DATA_DIR: H.tmpdir() });
  try {
    const { aps, ash } = await commands(col);
    assert.ok(aps.includes("Invoke-WebRequest -UseBasicParsing -Uri '" + col.url + "/agent.js'") && aps.includes('node $f --setup;node $f --once'), aps.slice(0, 200));
    if (PWSH) {
      const s = scratch();
      fs.writeFileSync(path.join(s.home, 'cmd.ps1'), aps);
      const r = spawnSync(PWSH, ['-NoProfile', '-File', path.join(s.home, 'cmd.ps1')], { env: s.env, encoding: 'utf8', timeout: 180000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Installed\. Every new Claude Code session on this PC now reports its usage\./);
      assert.match(r.stdout, /Status line set in .*settings\.json/);
      const m = servers(s.cfg)['claude-usage'];
      assert.ok(m && m.command === 'node' && m.args[0].endsWith('agent.js') && m.env.USAGE_MEMBER === 'Harsh%20Patel' && m.env.USAGE_HOST === hostName && m.env.USAGE_URL === col.url, JSON.stringify(m));
      const settings = JSON.parse(fs.readFileSync(path.join(s.cfg, 'settings.json'), 'utf8'));
      assert.equal(settings.statusLine.command, 'node "' + m.args[0] + '" --statusline');
      assert.equal(fs.readFileSync(m.args[0], 'utf8'), fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'agent.js'), 'utf8'), 'the downloaded agent is the repository file');
    }
    const s2 = scratch();
    const r2 = spawnSync('bash', ['-c', ash], { env: s2.env, encoding: 'utf8', timeout: 180000 });
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /Installed\./); assert.match(r2.stdout, /Status line set in/);
    const m2 = servers(s2.cfg)['claude-usage'];
    assert.ok(m2 && m2.args[0] === s2.home + '/.claude-usage/agent.js' && m2.env.USAGE_HOST === hostName, JSON.stringify(m2));
    assert.equal(JSON.parse(fs.readFileSync(path.join(s2.cfg, 'settings.json'), 'utf8')).statusLine.command, 'node "' + m2.args[0] + '" --statusline');
    /* the name reaches the collector decoded, and the status line feeds the meter */
    const fx = path.join(s2.cfg, 'projects', 'p'); fs.mkdirSync(fx);
    fs.writeFileSync(path.join(fx, 's.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, requestId: 'r1', timestamp: '2026-11-10T10:00:00Z', sessionId: 's', uuid: 'u' }) + '\n');
    const envA = Object.assign({}, s2.env, { USAGE_URL: col.url, USAGE_KEY: IK, USAGE_MEMBER: 'Harsh%20Patel', USAGE_HOST: hostName });
    const sl = spawnSync(process.execPath, [m2.args[0], '--statusline'], { env: envA, encoding: 'utf8', input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 33, resets_at: Math.floor(Date.now() / 1000) + 600 }, seven_day: { used_percentage: 70, resets_at: Math.floor(Date.now() / 1000) + 86400 } } }) });
    assert.match(sl.stdout, /^Claude limits: 5h 33%/);
    const once = spawnSync(process.execPath, [m2.args[0], '--once'], { env: envA, encoding: 'utf8', timeout: 60000 });
    assert.equal(once.status, 0, once.stdout + once.stderr); assert.match(once.stdout, /Account limits sent too/);
    const feed = (await H.get(col.url + '/api/usage?key=' + RK)).json;
    assert.ok(feed.members.some((m) => m.label === 'Harsh Patel · ' + hostName), feed.members.map((m) => m.label).join(', '));
    assert.equal(feed.account.windows.fiveHour.pct, 33); assert.equal(feed.account.byLabel, 'Harsh Patel · ' + hostName);
  } finally { await col.stop(); }
});
