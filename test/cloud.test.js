// Cloud-layer tests against a fake Supabase client (tables, storage, auth, rpc) that models the
// query-builder subset cloud.js uses. Run: node test/cloud.test.js
// Covers: diffing, coalescing, deletes, version conflicts, retry/offline queue, per-user and
// per-household queue isolation across sign-out / retry / reconnect, revoked access, household
// listing with the caller's own role, backup import receipt links, and migration (same-id conflicts,
// idempotent receipts, byte-level verification, corrupted download detection).
const fs = require("fs"), path = require("path");
let fails = 0;
const t = (name, cond, extra) => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond || extra === undefined ? "" : "   → " + JSON.stringify(extra).slice(0, 220))); if (!cond) fails++; };

/* ---------------- fake Supabase ---------------- */
const tables = { entries: new Map(), receipts: new Map(), households: new Map(), household_members: new Map(), invitations: new Map() };
const keyOf = (name, r) => name === "household_members" ? r.household_id + "|" + r.user_id : r.id;
const objects = new Map();          // storage: path -> Blob
let failNext = 0, denyWrites = false, sessionUser = null, corruptDownloads = false;
let gate = null;                    // when set, writes wait on this promise (models an in-flight request)
const holdWrites = () => { let release; gate = new Promise(r => { release = r; }); return () => { const g = gate; gate = null; release(); return g; }; };
function builder(name) {
  const q = { _op: null, _payload: null, _filters: [], _select: null, _single: false };
  const chain = {
    select(cols) { if (!q._op) q._op = "select"; q._select = cols; return chain; },
    insert(rows) { q._op = "insert"; q._payload = rows; return chain; },
    update(patch) { q._op = "update"; q._payload = patch; return chain; },
    delete() { q._op = "delete"; return chain; },
    eq(col, v) { q._filters.push({ col, v, m: "eq" }); return chain; },
    in(col, vs) { q._filters.push({ col, v: vs, m: "in" }); return chain; },
    not(col, op, v) { q._filters.push({ col, v, m: "not-" + op }); return chain; },
    is(col, v) { q._filters.push({ col, v, m: "is" }); return chain; },
    order() { return chain; },
    maybeSingle() { q._single = true; return chain; }, single() { q._single = true; return chain; },
    then(res, rej) { const run = () => exec(); const p = (gate && ["insert", "update", "delete"].includes(q._op)) ? gate.then(run) : Promise.resolve().then(run); return p.then(res, rej); }
  };
  const match = row => q._filters.every(f => f.m === "in" ? f.v.includes(row[f.col]) : f.m === "is" ? row[f.col] == f.v : f.m === "not-is" ? row[f.col] != f.v : row[f.col] === f.v);
  const embed = row => { if (name === "household_members" && /households\(/.test(q._select || "")) return Object.assign({}, row, { households: tables.households.get(row.household_id) || null }); return Object.assign({}, row); };
  function exec() {
    const tbl = tables[name]; if (!tbl) return { data: [], error: null };
    if (["insert", "update", "delete"].includes(q._op) && failNext > 0) { failNext--; return { data: null, error: { message: "simulated network failure" } }; }
    if (["insert", "update", "delete"].includes(q._op) && denyWrites) return { data: null, error: { code: "42501", status: 403, message: "new row violates row-level security policy" } };
    if (q._op === "select") { const rows = [...tbl.values()].filter(match).map(embed); return { data: q._single ? (rows[0] || null) : rows, error: null }; }
    if (q._op === "insert") {
      const rows = Array.isArray(q._payload) ? q._payload : [q._payload];
      for (const r of rows) if (tbl.has(keyOf(name, r))) return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (name === "receipts") for (const r of rows) if (r.source_id && [...tbl.values()].some(x => x.household_id === r.household_id && x.source_id === r.source_id)) return { data: null, error: { code: "23505", message: "duplicate source_id" } };
      rows.forEach(r => tbl.set(keyOf(name, r), Object.assign({ created_at: new Date().toISOString() }, r)));
      return { data: q._single ? { version: rows[0].version, token: rows[0].token } : rows.map(r => ({ version: r.version, token: r.token })), error: null };
    }
    if (q._op === "update") { const rows = [...tbl.values()].filter(match); rows.forEach(r => Object.assign(r, q._payload)); return { data: rows.map(r => ({ version: r.version })), error: null }; }
    if (q._op === "delete") { [...tbl.values()].filter(match).forEach(r => tbl.delete(keyOf(name, r))); return { data: null, error: null }; }
  }
  return chain;
}
const fakeClient = {
  auth: {
    getSession: async () => ({ data: { session: sessionUser ? { user: sessionUser } : null } }),
    onAuthStateChange(cb) { fakeClient._authCb = cb; },
    signOut: async () => { sessionUser = null; fakeClient._authCb && fakeClient._authCb("SIGNED_OUT", null); }
  },
  from: builder,
  rpc: async () => ({ data: null, error: null }),
  channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
  removeChannel: async () => {},
  storage: { from() { return {
    createSignedUrls: async paths => ({ data: paths.map(p => ({ signedUrl: "https://signed.test/" + p })), error: null }),
    upload: async (p, blob) => { if (objects.has(p)) return { error: { message: "exists" } }; objects.set(p, blob); return { error: null }; },
    remove: async ps => { ps.forEach(p => objects.delete(p)); return {}; },
    download: async p => { const b = objects.get(p); if (!b) return { data: null, error: { message: "not found" } }; return { data: corruptDownloads ? new Blob(["corrupted"]) : b, error: null }; }
  }; } }
};
const signIn = (id, email) => { sessionUser = { id, email }; fakeClient._authCb && fakeClient._authCb("SIGNED_IN", { user: sessionUser }); };

/* ---------------- load modules ---------------- */
global.window = { SITE_CONFIG: { cloud: { url: "https://x.supabase.co", anonKey: "k" } }, supabase: { createClient: () => fakeClient }, addEventListener() {} };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
global.localStorage = { _m: {}, getItem(k) { return this._m[k] == null ? null : this._m[k]; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
global.location = { origin: "https://example.test", pathname: "/", href: "https://example.test/" };
for (const f of ["fmv", "rules", "data", "cloud"]) eval(fs.readFileSync(path.join(__dirname, "../js/" + f + ".js"), "utf8"));
const Cloud = window.Cloud, Store = window.Store;
const statuses = [], conflicts = [], lost = [];
const HH = { id: "11111111-1111-1111-1111-111111111111", name: "Alice household", role: "owner" };
const HH2 = { id: "22222222-2222-2222-2222-222222222222", name: "Second household", role: "member" };
const mk = (id, amount, extra) => Store.sanitizeEntry(Object.assign({ id, kind: "cash", date: "2026-03-01", org: "Food Bank", amount, bankRecord: true }, extra || {}));
const T = tables.entries;
const toDataUrl = async blob => "data:" + (blob.type || "application/octet-stream") + ";base64," + Buffer.from(await blob.arrayBuffer()).toString("base64");

(async () => {
  signIn("user-alice", "alice@example.test");
  await Cloud.init({ onStatus: s => statuses.push(s), onConflict: (l, s) => conflicts.push({ l, s }), onAccessLost: info => lost.push(info) });
  t("empty household loads no entries", (await Cloud.selectHousehold(HH)).length === 0);

  /* ---- sync basics ---- */
  await Cloud.sync([mk("a", 100), mk("b", 200)]);
  t("inserts reach the server with version 1", T.size === 2 && T.get("a").version === 1 && T.get("a").body.amount === 100);
  t("status went saving → saved", statuses.includes("saving") && statuses[statuses.length - 1] === "saved");
  await Cloud.sync([mk("a", 150), mk("b", 200)]);
  t("edit bumps the version and body", T.get("a").version === 2 && T.get("a").body.amount === 150);
  await Cloud.sync([mk("a", 150)]);
  t("removing an entry deletes it on the server", !T.has("b") && T.has("a"));
  const before = JSON.stringify([...T.values()]);
  await Cloud.sync([mk("a", 150)]);
  t("no-op sync writes nothing", JSON.stringify([...T.values()]) === before);
  T.get("a").version = 3; T.get("a").body.amount = 999;
  await Cloud.sync([mk("a", 175)]);
  t("stale write → conflict reported, server wins as base", conflicts.length === 1 && conflicts[0].s.amount === 999 && conflicts[0].l.amount === 175 && T.get("a").body.amount === 999);
  await Cloud.sync([mk("a", 999)]);
  t("adopting the server version → identical content is a no-op", T.get("a").version === 3);
  failNext = 1;
  await Cloud.sync([mk("a", 999), mk("d", 10)]);
  t("failed write → 'failed', pending write kept", statuses[statuses.length - 1] === "failed" && Cloud.pendingWrites() === 1 && !T.has("d"));
  await Cloud.retry();
  t("retry drains the queue", statuses[statuses.length - 1] === "saved" && T.has("d") && Cloud.pendingWrites() === 0);
  navigator.onLine = false;
  await Cloud.sync([mk("a", 999), mk("d", 11)]);
  t("offline edits wait with 'offline' status", statuses[statuses.length - 1] === "offline" && T.get("d").body.amount === 10 && Cloud.pendingWrites() === 1);
  navigator.onLine = true; await Cloud.retry();
  t("back online, the queued edit lands", T.get("d").body.amount === 11);

  /* ---- acceptance 1: queued edits never cross accounts or households ---- */
  failNext = 1;
  await Cloud.sync([mk("a", 999), mk("d", 12)]);                       // Alice has one unsent edit (d → 12)
  t("Alice's unsent edit is parked under her own key", Cloud.pendingWrites() === 1 && !!localStorage.getItem("gl_cloud_queue_user-alice_" + HH.id));
  await Cloud.signOut();
  t("sign-out clears the in-memory queue", Cloud.pendingWrites() === 0);
  signIn("user-bob", "bob@example.test");
  await Cloud.selectHousehold(HH); await Cloud.restoreQueue();
  await Cloud.retry();                                                   // the reviewer's reproduction
  t("Bob's retry does not submit Alice's edit", T.get("d").body.amount === 11 && Cloud.pendingWrites() === 0);
  navigator.onLine = false; navigator.onLine = true; await Cloud.retry();    // reconnect
  t("Bob's reconnect does not submit Alice's edit", T.get("d").body.amount === 11);
  await Cloud.sync([mk("a", 999), mk("d", 11), mk("bob1", 1)]);        // Bob's own new save
  t("Bob's new save submits only Bob's change", T.has("bob1") && T.get("d").body.amount === 11);
  await Cloud.signOut(); signIn("user-alice", "alice@example.test");
  await Cloud.selectHousehold(HH);
  failNext = 1; await Cloud.sync([mk("a", 999), mk("d", 11), mk("bob1", 1), mk("hh1", 5)]);   // Alice: unsent edit in HH …
  t("Alice has an unsent edit in household 1", Cloud.pendingWrites() === 1);
  await Cloud.selectHousehold(HH2); await Cloud.restoreQueue(); await Cloud.retry();          // … then switches household
  t("switching households parks household-1 work; nothing lands in household 2", !T.has("hh1") && Cloud.pendingWrites() === 0 && [...T.values()].every(r => r.household_id !== HH2.id));
  await Cloud.selectHousehold(HH); await Cloud.restoreQueue();
  t("returning to household 1 resumes Alice's own parked edit", T.has("hh1") && Cloud.pendingWrites() === 0);

  /* ---- revoked access ---- */
  denyWrites = true;
  await Cloud.sync([mk("a", 999), mk("d", 11), mk("bob1", 1), mk("hh1", 5), mk("e", 1)]);
  t("revoked access → 'denied', queue dropped, onAccessLost fired", statuses[statuses.length - 1] === "denied" && Cloud.pendingWrites() === 0 && lost.length === 1 && lost[0].dropped === 1 && !T.has("e"));
  denyWrites = false;

  /* ---- acceptance 4: households listed once with the caller's own role ---- */
  tables.households.set(HH.id, { id: HH.id, name: HH.name, plan: "household", plan_status: "beta" });
  tables.households.set(HH2.id, { id: HH2.id, name: HH2.name, plan: "household", plan_status: "beta" });
  const mem = (h, u, role) => tables.household_members.set(h + "|" + u, { household_id: h, user_id: u, role, joined_at: "2026-01-01" });
  mem(HH.id, "user-alice", "owner"); mem(HH.id, "user-bob", "viewer"); mem(HH.id, "user-carol", "member"); mem(HH2.id, "user-alice", "member"); mem(HH2.id, "user-bob", "owner");
  const hhs = await Cloud.households();
  t("each household appears once", hhs.length === 2 && new Set(hhs.map(h => h.id)).size === 2, hhs);
  t("roles are the signed-in user's own (owner of 1, member of 2), not other members'", hhs.find(h => h.id === HH.id).role === "owner" && hhs.find(h => h.id === HH2.id).role === "member", hhs);
  await Cloud.signOut(); signIn("user-bob", "bob@example.test");
  const bobHhs = await Cloud.households();
  t("Bob sees his own roles (viewer of 1, owner of 2)", bobHhs.find(h => h.id === HH.id).role === "viewer" && bobHhs.find(h => h.id === HH2.id).role === "owner", bobHhs);
  await Cloud.signOut(); signIn("user-alice", "alice@example.test"); await Cloud.selectHousehold(HH);

  /* ---- acceptance 2: backup import keeps receipt links (re-pointed to the uploads) ---- */
  const localBlob = new Blob(["receipt bytes"], { type: "image/png" });
  const backup = { app: "giving-ledger", version: 2, entries: [mk("imp1", 42, { receiptIds: ["old-r1"], hasReceiptDecl: true })], receipts: [{ id: "old-r1", entryId: "imp1", name: "r1.png", type: "image/png", size: 13, data: await toDataUrl(localBlob) }] };
  let committed = null;
  const res = await Cloud.importBackup(backup, { entries: [...T.values()].map(r => Store.sanitizeEntry(Object.assign({}, r.body, { id: r.id }))), settings: {} }, ns => { committed = ns; return true; });
  const imp = committed.entries.find(e => e.id === "imp1");
  t("import uploads the receipt and reports it", res.receiptsAdded === 1 && tables.receipts.size === 1);
  t("imported entry's receiptIds point at the newly uploaded file", imp && imp.receiptIds.length === 1 && tables.receipts.has(imp.receiptIds[0]) && imp.receiptIds[0] !== "old-r1", imp && imp.receiptIds);
  t("uploaded receipt is linked to the entry", [...tables.receipts.values()][0].entry_id === "imp1");

  /* ---- acceptance 5: an edit made while a save is in flight is not lost ---- */
  await Cloud.sync(committed.entries);
  let release = holdWrites();
  const base = committed.entries;
  const p1 = Cloud.sync(base.concat([mk("race", 1000)]));           // first save: in flight, held by the gate
  await new Promise(r => setTimeout(r, 10));
  const p2 = Cloud.sync(base.concat([mk("race", 2000)]));           // user edits again before the response returns
  release(); await p1; await p2; await Cloud.retry();
  t("edit during an in-flight save: server ends with the newer value", T.get("race") && T.get("race").body.amount === 2000, T.get("race") && T.get("race").body);
  t("edit during an in-flight save: queue empty and status Saved only after the newer edit landed", Cloud.pendingWrites() === 0 && statuses[statuses.length - 1] === "saved");

  /* ---- acceptance 6: an old response never modifies the newly active queue ---- */
  release = holdWrites();
  const pA = Cloud.sync(base.concat([mk("race", 2000), mk("slowA", 1)]));   // household A save, held in flight
  await new Promise(r => setTimeout(r, 10));
  await Cloud.selectHousehold(HH2);                                            // user switches to household B while A is pending
  const pB = Cloud.sync([mk("newB", 7)]);                                      // new work in B (held by the same gate)
  release(); await pA; await pB; await Cloud.retry();
  t("household switch during a pending save: B's new entry is stored in B", T.has("newB") && T.get("newB").household_id === HH2.id, T.get("newB"));
  t("household switch during a pending save: A's entry landed in A, not B", T.has("slowA") && T.get("slowA").household_id === HH.id);
  t("household switch during a pending save: nothing left pending, status Saved", Cloud.pendingWrites() === 0 && statuses[statuses.length - 1] === "saved");
  await Cloud.selectHousehold(HH); await Cloud.restoreQueue();
  t("returning to A does not re-send the completed save (parked copy was updated)", [...T.values()].filter(r => r.id === "slowA").length === 1 && Cloud.pendingWrites() === 0);

  /* ---- acceptance 7: created offline, deleted before reconnecting → never uploaded ---- */
  await Cloud.selectHousehold(HH); await Cloud.restoreQueue();
  const snapshot = () => [...T.values()].filter(r => r.household_id === HH.id).map(r => Store.sanitizeEntry(Object.assign({}, r.body, { id: r.id })));
  let cur = snapshot();
  navigator.onLine = false;
  await Cloud.sync(cur.concat([mk("ghostNew", 55)]));
  t("offline create is queued", Cloud.pendingWrites() === 1 && statuses[statuses.length - 1] === "offline");
  await Cloud.sync(cur);                                                        // deleted again before reconnecting
  t("deleting an unsent offline entry drops its queued insert", Cloud.pendingWrites() === 0);
  navigator.onLine = true; await Cloud.retry();
  t("after reconnect the deleted entry was never uploaded; status Saved", !T.has("ghostNew") && statuses[statuses.length - 1] === "saved");

  /* ---- acceptance 8: offline edit parked, someone else edits the original, edit returns → conflict, not overwrite ---- */
  cur = snapshot();
  const target = cur.find(e => e.id === "d");
  navigator.onLine = false;
  await Cloud.sync(cur.map(e => e.id === "d" ? mk("d", 5000) : e));            // Alice's offline edit of d
  navigator.onLine = true;
  await Cloud.selectHousehold(HH2);                                             // parks it
  T.get("d").body.amount = 777; T.get("d").version += 1;                        // someone else edits d meanwhile
  const conflictsBefore = conflicts.length;
  await Cloud.selectHousehold(HH); await Cloud.restoreQueue(); await Cloud.retry();
  t("returning parked edit does not overwrite the other person's change", T.get("d").body.amount === 777, T.get("d").body);
  t("it is surfaced as a conflict instead", conflicts.length === conflictsBefore + 1 && conflicts[conflicts.length - 1].l.amount === 5000 && conflicts[conflicts.length - 1].s.amount === 777);
  t("queue drained, status Saved", Cloud.pendingWrites() === 0 && statuses[statuses.length - 1] === "saved");

  /* ---- acceptance 9: delete an existing entry while another save is pending → no stall ---- */
  cur = snapshot();
  release = holdWrites();
  const pP = Cloud.sync(cur.concat([mk("pendingNew", 9)]));                     // in flight, held
  await new Promise(r => setTimeout(r, 10));
  const pD = Cloud.sync(cur.filter(e => e.id !== "a").concat([mk("pendingNew", 9)]));   // delete a while the insert is pending
  release(); await pP; await pD; await Cloud.retry();
  t("delete during a pending save: both operations reach the server", T.has("pendingNew") && !T.has("a"), { pending: Cloud.pendingWrites(), hasA: T.has("a") });
  t("delete during a pending save: nothing pending, status Saved (no stall)", Cloud.pendingWrites() === 0 && statuses[statuses.length - 1] === "saved");
  await Cloud.sync(snapshot());
  t("a later save still works (drain not locked)", Cloud.pendingWrites() === 0 && statuses[statuses.length - 1] === "saved");

  /* ---- acceptance 3: migration preserves differing same-id entries and verifies bytes ---- */
  await Cloud.sync(committed.entries);
  const localFile = { id: "loc-r1", entryId: "mig1", name: "m.png", type: "image/png", size: 5, blob: new Blob(["hello"], { type: "image/png" }) };
  const localState = { entries: [
    mk("mig1", 12345, { receiptIds: ["loc-r1"], hasReceiptDecl: true }),     // new to the household, with a receipt
    mk("a", 12345),                                                            // same id as a cloud entry worth 999 → must NOT be dropped
    mk("d", 11)                                                                // same id, identical content → skipped
  ], settings: {} };
  const r1 = await Cloud.migrateLocal(localState, [localFile], () => {});
  t("migration: new entry copied and verified byte-for-byte", r1.verified === true && T.has("mig1") && r1.receipts === 1, r1);
  t("migration: identical same-id entry skipped", r1.skipped === 1);
  const conflictRow = [...T.values()].find(r => r.body.conflictOf === "a");
  t("migration: differing same-id entry kept as an import conflict, household copy untouched", r1.conflicts === 1 && !!conflictRow && conflictRow.body.amount === 12345 && T.get("a").body.amount === 999, r1);
  const r2 = await Cloud.migrateLocal(localState, [localFile], () => {});
  t("migration retry: receipt reused, no second conflict copy, nothing duplicated", r2.receiptsReused === 1 && r2.receipts === 0 && r2.conflicts === 0 && r2.skipped === 3 && tables.receipts.size === 2 && [...T.values()].filter(r => r.body.conflictOf === "a").length === 1, r2);
  corruptDownloads = true;
  const localState3 = { entries: [mk("mig3", 7, { receiptIds: ["loc-r3"], hasReceiptDecl: true })], settings: {} };
  const r3 = await Cloud.migrateLocal(localState3, [{ id: "loc-r3", entryId: "mig3", name: "x.png", type: "image/png", size: 3, blob: new Blob(["xyz"]) }], () => {});
  t("migration: a receipt that reads back with different bytes is reported, verified=false", r3.verified === false && r3.missingReceipts.length === 1, r3);
  corruptDownloads = false;
  const r4 = await Cloud.migrateLocal({ entries: [mk("mig4", 3, { receiptIds: ["ghost"], hasReceiptDecl: true })], settings: {} }, [], () => {});
  t("migration: an entry referencing a file that is missing locally is flagged, verified=false", r4.verified === false && r4.missingReceipts.some(m => /ghost/.test(m)), r4.missingReceipts);
  corruptDownloads = true;
  const r5 = await Cloud.migrateLocal({ entries: [], settings: {} }, [{ id: "loc-unlinked", entryId: null, name: "u.png", type: "image/png", size: 2, blob: new Blob(["ab"]) }], () => {});
  t("migration: an unlinked receipt that reads back corrupted is flagged, verified=false", r5.verified === false && r5.missingReceipts.length === 1, r5);
  corruptDownloads = false;

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("TEST CRASH", e); process.exit(1); });
