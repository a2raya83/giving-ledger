// Cloud sync tests with a fake Supabase client: diffing, coalescing, deletes, version conflicts,
// realtime echo suppression, and offline/failed status. Run: node test/cloud.test.js
const fs = require("fs"), path = require("path");
let fails = 0;
const t = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) fails++; };

// ---- fake supabase: an in-memory "entries" table with the query-builder subset cloud.js uses ----
const table = new Map();           // id -> { id, household_id, body, version }
let failNext = 0;                  // make the next N writes fail
function builder(name) {
  const q = { _op: null, _payload: null, _filters: [], _select: null, _single: false };
  const chain = {
    select(cols) { if (!q._op) q._op = "select"; q._select = cols; return chain; },
    insert(rows) { q._op = "insert"; q._payload = rows; return chain; },
    update(patch) { q._op = "update"; q._payload = patch; return chain; },
    delete() { q._op = "delete"; return chain; },
    eq(col, v) { q._filters.push([col, v]); return chain; },
    in(col, vs) { q._filters.push([col, vs, "in"]); return chain; },
    is() { return chain; }, order() { return chain; },
    maybeSingle() { q._single = true; return chain; }, single() { q._single = true; return chain; },
    then(res, rej) { return Promise.resolve(exec()).then(res, rej); }
  };
  const match = row => q._filters.every(([c, v, m]) => m === "in" ? v.includes(row[c]) : row[c] === v);
  function exec() {
    if (name !== "entries") return { data: [], error: null };
    if (["insert", "update", "delete"].includes(q._op) && failNext > 0) { failNext--; return { data: null, error: { message: "simulated network failure" } }; }
    if (q._op === "select") { const rows = [...table.values()].filter(match); return { data: q._single ? (rows[0] || null) : rows, error: null }; }
    if (q._op === "insert") {
      const rows = Array.isArray(q._payload) ? q._payload : [q._payload];
      for (const r of rows) { if (table.has(r.id)) return { data: null, error: { code: "23505", message: "duplicate" } }; }
      rows.forEach(r => table.set(r.id, Object.assign({}, r)));
      return { data: q._single ? { version: rows[0].version } : rows.map(r => ({ version: r.version })), error: null };
    }
    if (q._op === "update") { const rows = [...table.values()].filter(match); rows.forEach(r => Object.assign(r, q._payload)); return { data: rows.map(r => ({ version: r.version })), error: null }; }
    if (q._op === "delete") { [...table.values()].filter(match).forEach(r => table.delete(r.id)); return { data: null, error: null }; }
  }
  return chain;
}
const fakeClient = {
  auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {}, signOut: async () => {} },
  from: builder,
  rpc: async () => ({ data: null, error: null }),
  channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
  removeChannel: async () => {},
  storage: { from() { return { createSignedUrls: async () => ({ data: [], error: null }), upload: async () => ({ error: null }), remove: async () => ({}), download: async () => ({ data: null }) }; } }
};

// ---- load the app modules in a fake window ----
global.window = { SITE_CONFIG: { cloud: { url: "https://x.supabase.co", anonKey: "k" } }, supabase: { createClient: () => fakeClient }, addEventListener() {} };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
global.localStorage = { _m: {}, getItem(k) { return this._m[k] == null ? null : this._m[k]; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
global.location = { origin: "https://example.test", pathname: "/", href: "https://example.test/" };
for (const f of ["fmv", "rules", "data", "cloud"]) eval(fs.readFileSync(path.join(__dirname, "../js/" + f + ".js"), "utf8"));
const Cloud = window.Cloud, Store = window.Store;
const statuses = []; const conflicts = [];
const HH = { id: "11111111-1111-1111-1111-111111111111", name: "Test", role: "owner" };
const mk = (id, amount) => Store.sanitizeEntry({ id, kind: "cash", date: "2026-03-01", org: "Food Bank", amount, bankRecord: true });

(async () => {
  await Cloud.init({ onStatus: s => statuses.push(s), onConflict: (l, s) => conflicts.push({ l, s }) });
  const entries = await Cloud.selectHousehold(HH);
  t("empty household loads no entries", entries.length === 0 && Cloud.currentHousehold.id === HH.id);

  // insert two, update one, delete one
  let app = [mk("a", 100), mk("b", 200)];
  await Cloud.sync(app);
  t("inserts reach the server with version 1", table.size === 2 && table.get("a").version === 1 && table.get("a").body.amount === 100);
  t("status went saving → saved", statuses.includes("saving") && statuses[statuses.length - 1] === "saved");
  app = [mk("a", 150), mk("b", 200)];
  await Cloud.sync(app);
  t("edit bumps the version and body", table.get("a").version === 2 && table.get("a").body.amount === 150);
  await Cloud.sync([mk("a", 150)]);
  t("removing an entry deletes it on the server", !table.has("b") && table.has("a"));

  // unchanged sync writes nothing
  const before = JSON.stringify([...table.values()]);
  await Cloud.sync([mk("a", 150)]);
  t("no-op sync writes nothing", JSON.stringify([...table.values()]) === before);

  // concurrent edit: another device bumped the version
  table.get("a").version = 3; table.get("a").body.amount = 999;
  await Cloud.sync([mk("a", 175)]);
  t("stale write is rejected and reported as a conflict (server wins as base)", conflicts.length === 1 && conflicts[0].s.amount === 999 && conflicts[0].l.amount === 175 && table.get("a").body.amount === 999);
  await Cloud.sync([mk("a", 999)]);
  t("after adopting the server version, syncing identical content is a no-op", table.get("a").version === 3);

  // duplicate id created elsewhere with the same content → no conflict
  table.set("c", { id: "c", household_id: HH.id, body: Object.assign({}, mk("c", 5)), version: 1 }); delete table.get("c").body.id;
  await Cloud.sync([mk("a", 999), mk("c", 5)]);
  t("inserting an id that already exists with identical content raises no conflict", conflicts.length === 1);

  // failure → status failed, queue kept, retry succeeds
  failNext = 1;
  await Cloud.sync([mk("a", 999), mk("c", 5), mk("d", 10)]);
  t("failed write reports 'failed' and keeps the pending write", statuses[statuses.length - 1] === "failed" && Cloud.pendingWrites() === 1 && !table.has("d"));
  await Cloud.retry();
  t("retry drains the queue", statuses[statuses.length - 1] === "saved" && table.has("d") && Cloud.pendingWrites() === 0);

  // offline → status offline, nothing sent
  navigator.onLine = false;
  await Cloud.sync([mk("a", 999), mk("c", 5), mk("d", 11)]);
  t("offline edits wait in the queue with 'offline' status", statuses[statuses.length - 1] === "offline" && table.get("d").body.amount === 10 && Cloud.pendingWrites() === 1);
  navigator.onLine = true; await Cloud.retry();
  t("back online, the queued edit lands", table.get("d").body.amount === 11);

  // queue survives a reload (persisted in localStorage)
  failNext = 1;
  await Cloud.sync([mk("a", 999), mk("c", 5), mk("d", 12)]);
  const persisted = JSON.parse(localStorage.getItem("gl_cloud_queue_" + HH.id) || "[]");
  t("pending writes are persisted for the next load", persisted.length === 1 && persisted[0].id === "d");

  // signature-preserving mergeEntries still applies to cloud conflicts (reuse of existing logic)
  const m = Store.mergeEntries([mk("z", 1)], [mk("z", 2)]);
  t("merge helper is shared with device mode", m.conflicts === 1);

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("TEST CRASH", e); process.exit(1); });
