'use strict';
/* A mock of the claude.ai `db` and `user` capabilities (contract 0.2.75) for Playwright tests of the artifact page.
   One Node-side store is shared by every browser context so cross-device behaviour can be tested. */
const MAX_DOC = 256 * 1024;
function segs(path) { return path.split('/'); }
function validPath(path) {
  if (!path || path.length > 1000) return false;
  const s = segs(path);
  if (s.length > 16) return false;
  return s.every((x) => x.length > 0 && Buffer.byteLength(x) <= 200 && /^[A-Za-z0-9_\-.~:@+]+$/.test(x) && x !== '.' && x !== '..');
}
function createStore() {
  const store = {
    docs: new Map(), log: [], subs: new Map(), failNext: null, maxDocBytes: MAX_DOC, latencyMs: 0,
    clone: (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))),
    colDocs(col) {
      const n = segs(col).length;
      return [...store.docs.keys()].filter((p) => p.startsWith(col + '/') && segs(p).length === n + 1).sort().map((p) => ({ id: segs(p)[n], data: store.clone(store.docs.get(p)) }));
    },
    async notify() {
      for (const [key, s] of [...store.subs.entries()]) {
        let payload;
        if (s.kind === 'doc') payload = { kind: 'doc', id: segs(s.path).pop(), data: store.clone(store.docs.get(s.path)) };
        else payload = { kind: 'col', docs: store.colDocs(s.path) };
        const json = JSON.stringify(payload);
        if (json === s.last) continue;
        s.last = json;
        try { await s.page.evaluate(([id, p]) => window.__dbDeliver && window.__dbDeliver(id, p), [s.id, payload]); } catch (e) { store.subs.delete(key); }
      }
    },
  };
  return store;
}
async function installMock(context, store, cfg = {}) {
  await context.exposeFunction('__dbCall', async (op, path, data) => {
    if (store.latencyMs) await new Promise((r) => setTimeout(r, store.latencyMs));
    const err = (code, message) => ({ ok: false, code, message: message || code });
    if (!validPath(path)) return err('invalid_argument', 'bad path');
    const isDoc = segs(path).length % 2 === 0;
    if (op === 'list') { if (isDoc) return err('invalid_argument'); return { ok: true, value: store.colDocs(path) }; }
    if (!isDoc) return err('invalid_argument', 'doc path needs an even number of segments');
    if (op === 'get') return { ok: true, value: store.clone(store.docs.get(path)) ?? null };
    if (cfg.canWrite === false) return err('invalid_argument', 'view only');
    const f = store.failNext;
    if (f && (!f.match || path.startsWith(f.match))) { f.times = (f.times ?? 1) - 1; if (f.times <= 0) store.failNext = null; return err(f.code, f.message); }
    if (op === 'set' || op === 'update') {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return err('invalid_argument', 'body must be an object');
      const body = op === 'update' ? { ...(store.docs.get(path) || {}), ...data } : data;
      if (op === 'update' && !store.docs.has(path)) return err('invalid_argument', 'update needs an existing doc');
      if (Buffer.byteLength(JSON.stringify(body)) > store.maxDocBytes) return err('invalid_argument', 'document too large');
      store.docs.set(path, store.clone(body));
      store.log.push({ op, path });
    } else if (op === 'delete') { store.docs.delete(path); store.log.push({ op, path }); }
    else return err('invalid_argument', 'unknown op');
    setTimeout(() => store.notify(), 5);
    return { ok: true, value: null };
  });
  await context.exposeBinding('__dbSub', ({ page }, id, kind, path) => { store.subs.set(page._guid + ':' + id, { page, id, kind, path, last: null }); setTimeout(() => store.notify(), 5); });
  await context.addInitScript((c) => {
    let nextSub = 1; const handlers = new Map();
    const meta = { fromCache: false, hasPendingWrites: false };
    const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
    const docSnap = (id, data) => { const frozen = data == null ? undefined : deepFreeze(JSON.parse(JSON.stringify(data))); return Object.freeze({ id, exists: data != null, data: () => frozen, metadata: meta }); };
    const querySnap = (docs) => ({ docs: docs.map((d) => docSnap(d.id, d.data)), size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta });
    window.__dbDeliver = (id, p) => { const h = handlers.get(id); if (!h) return; if (p.error) { if (h.error) h.error({ code: p.error.code, message: p.error.message }); handlers.delete(id); return; } h.next(p.kind === 'doc' ? docSnap(p.id, p.data) : querySnap(p.docs)); };
    const call = async (op, path, data) => { const r = await window.__dbCall(op, path, data); if (!r.ok) throw { code: r.code, message: r.message }; return r.value; };
    const sub = (kind, path, next, error) => { const id = nextSub++; handlers.set(id, { next, error }); window.__dbSub(id, kind, path); return () => { handlers.delete(id); }; };
    const docRef = (path) => ({ id: path.split('/').pop(), path, get: async () => docSnap(path.split('/').pop(), await call('get', path)),
      set: (d) => call('set', path, d).then(() => undefined), update: (d) => call('update', path, d).then(() => undefined), delete: () => call('delete', path).then(() => undefined),
      onSnapshot: (next, error) => sub('doc', path, next, error), collection: (p) => colRef(path + '/' + p) });
    const colRef = (path) => ({ path, doc: (id) => docRef(path + '/' + (id || 'auto' + Math.random().toString(36).slice(2))), get: async () => querySnap(await call('list', path)), onSnapshot: (next, error) => sub('col', path, next, error),
      where: (field, op, value) => ({ get: async () => { const all = await call('list', path); return querySnap(all.filter((d) => d.data && (op === '==' || op === 'eq') && d.data[field] === value)); } }) });
    const db = Object.freeze({ doc: (p) => { if (p.split('/').length % 2) throw new TypeError('document path needs an even number of segments'); return docRef(p); }, collection: (p) => { if (p.split('/').length % 2 === 0) throw new TypeError('collection path needs an odd number of segments'); return colRef(p); } });
    const user = Object.freeze({ isOwner: async () => c.owner !== false, canEdit: async () => c.canWrite !== false, can: async (n) => (c.can !== undefined ? c.can : n === 'data.write' ? c.canWrite !== false : false), id: async () => 'u_test', me: async () => ({ id: 'u_test', name: '', avatarUrl: '', color: '#888', email: null, isOwner: true, canEdit: true }) });
    window.claude = Object.freeze({ use: (name) => { if (name === 'user') return Promise.resolve(user); if (name !== 'db') return Promise.resolve(null); if (c.db === 'null') return Promise.resolve(null); if (c.db === 'hang') return new Promise(() => {}); return Promise.resolve(db); } });
  }, cfg);
}
module.exports = { createStore, installMock };
