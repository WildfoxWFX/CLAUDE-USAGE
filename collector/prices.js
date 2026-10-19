'use strict';
/* Model prices in USD per million tokens: input, output, cache write (5 min), cache read, cache write (1 hour).
   The table is LiteLLM's model_prices_and_context_window.json as of 2026-10-19; at start the collector refreshes it
   from LiteLLM unless PRICES_URL=off, and PRICES_FILE can add or override entries ({"claude-x": {in,out,cw,cr,cw1h}}).
   Unknown ids fall back to the closest known id (date suffix removed, then longest prefix, then family). */
const fs = require('fs');

const TABLE = {
  'claude-fable-5': { in: 10, out: 50, cw: 12.5, cr: 1, cw1h: 20 },
  'claude-fable-5-1': { in: 10, out: 50, cw: 12.5, cr: 0.25, cw1h: 20 },
  'claude-mythos-5': { in: 10, out: 50, cw: 12.5, cr: 1, cw1h: 20 },
  'claude-mythos-5-1': { in: 10, out: 50, cw: 12.5, cr: 0.25, cw1h: 20 },
  'claude-opus-5': { in: 5, out: 25, cw: 6.25, cr: 0.5, cw1h: 10 },
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2, cw1h: 8 },
  'claude-sonnet-5': { in: 2, out: 10, cw: 2.5, cr: 0.2, cw1h: 4 },
  'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.1, cw1h: 4 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01, cw1h: 0.2 },
  'claude-opus-4-8': { in: 5, out: 25, cw: 6.25, cr: 0.5, cw1h: 10 },
  'claude-opus-4-7': { in: 5, out: 25, cw: 6.25, cr: 0.5, cw1h: 10 },
  'claude-opus-4-6': { in: 5, out: 25, cw: 6.25, cr: 0.5, cw1h: 10 },
  'claude-opus-4-5': { in: 5, out: 25, cw: 6.25, cr: 0.5, cw1h: 10 },
  'claude-opus-4-1': { in: 15, out: 75, cw: 18.75, cr: 1.5, cw1h: 30 },
  'claude-opus-4': { in: 15, out: 75, cw: 18.75, cr: 1.5, cw1h: 30 },
  'claude-sonnet-4-6': { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 },
  'claude-sonnet-4-5': { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 },
  'claude-sonnet-4': { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 },
  'claude-3-7-sonnet': { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 },
  'claude-3-5-sonnet': { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 },
  'claude-haiku-4-5': { in: 1, out: 5, cw: 1.25, cr: 0.1, cw1h: 2 },
  'claude-3-5-haiku': { in: 0.8, out: 4, cw: 1, cr: 0.08, cw1h: 1.6 },
  'claude-3-haiku': { in: 0.25, out: 1.25, cw: 0.3, cr: 0.03, cw1h: 0.5 },
  'claude-3-opus': { in: 15, out: 75, cw: 18.75, cr: 1.5, cw1h: 30 },
};
const FAMILY = [[/fable|mythos/, 'claude-fable-5-1'], [/opus/, 'claude-opus-4-1'], [/haiku/, 'claude-haiku-4-5'], [/sonnet/, 'claude-sonnet-4-5']];

const prices = Object.assign({}, TABLE);
const origin = {};
Object.keys(TABLE).forEach((k) => { origin[k] = 'table'; });
const resolved = new Map();
function bare(id) { return id.replace(/-\d{8}$/, ''); }
/* -> { id: the price entry used, how: 'exact'|'bare'|'prefix'|'family'|'unknown' } */
function resolve(model) {
  if (resolved.has(model)) return resolved.get(model);
  let hit;
  if (prices[model]) hit = { id: model, how: 'exact' };
  else if (prices[bare(model)]) hit = { id: bare(model), how: 'bare' };
  else {
    const pref = Object.keys(prices).filter((k) => model.indexOf(k + '-') === 0).sort((a, b) => b.length - a.length)[0];
    if (pref) hit = { id: pref, how: 'prefix' };
    else { const fam = FAMILY.find((f) => f[0].test(model)); hit = fam ? { id: fam[1], how: 'family' } : { id: '', how: 'unknown' }; }
  }
  resolved.set(model, hit);
  return hit;
}
/* tokens: {in, out, cw, cr, cw1h} (cw1h is the part of cw written with a 1-hour lifetime) -> USD */
function cost(model, t) {
  const r = resolve(model), p = r.id ? prices[r.id] : null;
  if (!p) return 0;
  const cw1h = Math.min(t.cw1h || 0, t.cw || 0), cw5 = (t.cw || 0) - cw1h;
  return ((t.in || 0) * p.in + (t.out || 0) * p.out + cw5 * p.cw + cw1h * (p.cw1h || p.cw) + (t.cr || 0) * p.cr) / 1e6;
}
/* { model: 'litellm'|'table'|'file'|'family:<id>'|'unknown' } for the models asked about */
function sources(models) {
  const out = {};
  models.forEach((m) => { const r = resolve(m); out[m] = r.how === 'unknown' ? 'unknown' : (r.how === 'family' ? 'family:' + r.id : origin[r.id] || 'table'); });
  return out;
}
function setPrice(id, p, from) {
  if (!/^claude-/.test(id) || !p || typeof p !== 'object') return false;
  const n = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
  const e = { in: n(p.in), out: n(p.out), cw: n(p.cw), cr: n(p.cr), cw1h: n(p.cw1h) };
  if (e.in === null || e.out === null) return false;
  if (e.cw === null) e.cw = e.in * 1.25; if (e.cr === null) e.cr = e.in * 0.1; if (e.cw1h === null) e.cw1h = e.in * 2;
  prices[id] = e; origin[id] = from; resolved.clear();
  return true;
}
/* LiteLLM's file: per-token costs; keep the Anthropic entries (plain claude-* keys) */
function loadLiteLLM(json) {
  let n = 0;
  Object.keys(json || {}).forEach((k) => {
    const v = json[k];
    if (!/^claude-[a-z0-9.-]+$/.test(k) || !v || typeof v !== 'object' || typeof v.input_cost_per_token !== 'number') return;
    const m = (x) => (typeof x === 'number' ? x * 1e6 : null);
    if (setPrice(k, { in: m(v.input_cost_per_token), out: m(v.output_cost_per_token), cw: m(v.cache_creation_input_token_cost), cr: m(v.cache_read_input_token_cost), cw1h: m(v.cache_creation_input_token_cost_above_1hr) }, 'litellm')) n++;
  });
  return n;
}
async function refresh(opts) {
  const o = opts || {}, log = o.log || function () {};
  if (o.file) {
    try { const j = JSON.parse(fs.readFileSync(o.file, 'utf8')); let n = 0; Object.keys(j).forEach((k) => { if (setPrice(k, j[k], 'file')) n++; }); log('prices: ' + n + ' entries from ' + o.file); }
    catch (e) { if (e.code !== 'ENOENT') log('prices: could not read ' + o.file + ': ' + e.message); }
  }
  const url = o.url === undefined ? 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' : o.url;
  if (!url || url === 'off') return;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs || 20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const n = loadLiteLLM(await r.json());
    log('prices: ' + n + ' Claude entries refreshed from LiteLLM');
    if (o.file) { /* the file wins over the download */
      try { const j = JSON.parse(fs.readFileSync(o.file, 'utf8')); Object.keys(j).forEach((k) => setPrice(k, j[k], 'file')); } catch (e) {}
    }
  } catch (e) { log('prices: using the built-in table (' + e.message + ')'); }
}
module.exports = { cost, resolve, sources, refresh, setPrice, loadLiteLLM, TABLE };
