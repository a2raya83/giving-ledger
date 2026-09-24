// Giving Ledger — cloud layer (Supabase). Household ledgers, sign-in, receipts, realtime, sync.
//
// Model: a HOUSEHOLD owns the ledger. People are granted access to a household (owner / member /
// viewer). Entries and receipts belong to the household, never to a person, so sharing a ledger
// with a spouse or a read-only accountant is a membership row, not a data migration.
//
// The app keeps working exactly as before when SITE_CONFIG.cloud is empty (device-only mode).
(function () {
  const CFG = (window.SITE_CONFIG && window.SITE_CONFIG.cloud) || {};
  const configured = !!(CFG.url && CFG.anonKey && window.supabase && window.supabase.createClient);
  const Cloud = { configured, currentHousehold: null, lastError: null };
  if (!configured) { window.Cloud = Cloud; return; }

  const sb = window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const BUCKET = "receipts";
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sig = e => window.Store.signature(e);
  let handlers = { onAuth: () => {}, onStatus: () => {}, onRemoteChange: () => {}, onConflict: () => {}, onAccessLost: () => {} };
  let session = null;
  let channel = null;

  /* ---------------- auth ---------------- */
  Cloud.init = async function (h) {
    handlers = Object.assign(handlers, h || {});
    const { data } = await sb.auth.getSession();
    session = data.session || null;
    sb.auth.onAuthStateChange((_event, s) => {
      const prevId = session && session.user ? session.user.id : null;
      const nextId = s && s.user ? s.user.id : null;
      if (prevId !== nextId) newGeneration();   // pending work belongs to the previous user; park it under their key
      const was = !!session; session = s;
      if (!!s !== was || prevId !== nextId) handlers.onAuth(Cloud.user());
    });
    handlers.onAuth(Cloud.user());
    return Cloud.user();
  };
  Cloud.user = () => session && session.user ? { id: session.user.id, email: session.user.email } : null;
  Cloud.signInWithEmail = async function (email) {
    const redirect = location.origin + location.pathname;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
    if (error) throw new Error(error.message);
    return true;
  };
  Cloud.signOut = async function () {
    newGeneration();                                     // park unsent edits under this user's key; nobody else can drain them
    await unsubscribe(); Cloud.currentHousehold = null; known = new Map();
    await sb.auth.signOut();
  };

  /* ---------------- households & access ---------------- */
  Cloud.households = async function () {
    if (!session || !session.user) return [];
    const { data, error } = await sb.from("household_members").select("role, households(id, name, created_at, plan, plan_status, plan_renews_at, canceled_at)").eq("user_id", session.user.id).order("joined_at");
    if (error) throw new Error(error.message);
    const seen = new Set();
    return (data || []).filter(r => r.households && !seen.has(r.households.id) && seen.add(r.households.id)).map(r => ({ id: r.households.id, name: r.households.name, role: r.role, plan: r.households.plan || "household", planStatus: r.households.plan_status || "beta", renewsAt: r.households.plan_renews_at, canceledAt: r.households.canceled_at }));
  };
  Cloud.createHousehold = async function (name) {
    const { data, error } = await sb.rpc("create_household", { p_name: name });
    if (error) throw new Error(error.message);
    return data; // household id
  };
  Cloud.renameHousehold = async function (id, name) {
    const { error } = await sb.from("households").update({ name }).eq("id", id);
    if (error) throw new Error(error.message);
  };
  Cloud.members = async function () {
    const { data, error } = await sb.rpc("household_member_list", { p_household: Cloud.currentHousehold.id });
    if (error) throw new Error(error.message);
    return data || [];
  };
  Cloud.invite = async function (email, role) {
    const { data, error } = await sb.from("invitations").insert({ household_id: Cloud.currentHousehold.id, email: email.trim().toLowerCase(), role }).select("token").single();
    if (error) throw new Error(error.message);
    return { token: data.token, link: location.origin + location.pathname + "#invite=" + data.token };
  };
  Cloud.invitations = async function () {
    const { data, error } = await sb.from("invitations").select("id, email, role, token, created_at, accepted_at").eq("household_id", Cloud.currentHousehold.id).is("accepted_at", null).order("created_at");
    if (error) throw new Error(error.message);
    return data || [];
  };
  Cloud.revokeInvite = async function (id) { const { error } = await sb.from("invitations").delete().eq("id", id); if (error) throw new Error(error.message); };
  Cloud.acceptInvite = async function (token) {
    const { data, error } = await sb.rpc("accept_invitation", { p_token: token });
    if (error) throw new Error(error.message);
    return data; // household id
  };
  Cloud.removeMember = async function (userId) {
    const { error } = await sb.from("household_members").delete().eq("household_id", Cloud.currentHousehold.id).eq("user_id", userId);
    if (error) throw new Error(error.message);
  };
  Cloud.canWrite = () => { const h = Cloud.currentHousehold; return !!h && h.role !== "viewer" && !["canceled", "past_due"].includes(h.planStatus || "beta"); };
  Cloud.planLabel = () => { const h = Cloud.currentHousehold; if (!h) return ""; const st = h.planStatus || "beta"; return st === "beta" ? "Household plan · free beta" : st === "active" ? "Household plan" : st === "canceled" ? "Household plan canceled · read-only" : st === "past_due" ? "Payment overdue · read-only" : st; };

  /* ---------------- ledger load + realtime ---------------- */
  let known = new Map(); // id -> { sig, version } as last seen on the server
  async function fetchEntries() {
    const { data, error } = await sb.from("entries").select("id, body, version").eq("household_id", Cloud.currentHousehold.id);
    if (error) throw new Error(error.message);
    known = new Map();
    const entries = [];
    (data || []).forEach(row => { const e = window.Store.sanitizeEntry(Object.assign({}, row.body, { id: row.id })); if (!e) return; known.set(e.id, { sig: sig(e), version: row.version }); entries.push(e); });
    return entries;
  }
  Cloud.selectHousehold = async function (hh) {
    if (!Cloud.currentHousehold || Cloud.currentHousehold.id !== hh.id) newGeneration();   // pending work stays with its own household
    await unsubscribe();
    Cloud.currentHousehold = hh;
    const entries = await fetchEntries();
    subscribe();
    return entries;
  };
  Cloud.reload = fetchEntries;
  function subscribe() {
    const hid = Cloud.currentHousehold.id;
    channel = sb.channel("hh-" + hid)
      .on("postgres_changes", { event: "*", schema: "public", table: "entries", filter: "household_id=eq." + hid }, () => remoteChanged())
      .on("postgres_changes", { event: "*", schema: "public", table: "receipts", filter: "household_id=eq." + hid }, () => remoteChanged())
      .subscribe();
  }
  async function unsubscribe() { if (channel) { try { await sb.removeChannel(channel); } catch (e) {} channel = null; } }
  let remoteTimer = null;
  function remoteChanged() {
    if (draining) return;                       // our own writes echo back; the queue handles those
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(async () => { try { const entries = await fetchEntries(); handlers.onRemoteChange(entries); } catch (e) { /* next change retries */ } }, 400);
  }

  /* ---------------- write queue with status ---------------- */
  // sync(entries): diff the app's entries against what the server last had, queue the writes,
  // and drain them one at a time. Status events: saving → saved | failed | offline | denied.
  //
  // Integrity rules (each one closes a reproduced bug):
  //  * Every queued operation is FROZEN when submitted (a deep copy). A later edit of the same entry
  //    never mutates an operation that may already be in flight; it becomes a separate operation
  //    that waits its turn.
  //  * An edit records the server version and content it was made against (its BASE). If the server
  //    has moved on by the time the edit is sent (someone else changed it while this edit was parked
  //    offline), the edit is not applied over their change: it goes through conflict resolution.
  //  * A drain is BOUND to a generation (user + household). Switching household, changing user or
  //    signing out bumps the generation; a response that comes back afterwards may not touch the new
  //    queue. It only removes its own operation from the parked copy of the old queue.
  //  * Within a generation the queue array is only ever mutated IN PLACE, so a running drain can
  //    never lose track of it and stall.
  //  * Removing an entry removes its unsent work too: an entry created offline and deleted before
  //    reconnecting is never uploaded; an entry the server has (or will have, because its insert is in
  //    flight) gets a delete operation.
  let queue = [];
  let draining = false;
  let generation = 0;
  let seqCounter = 0;
  let inFlight = null;                 // the operation currently being sent, if any
  const nextSeq = () => Date.now().toString(36) + "-" + (++seqCounter);
  const QKEY = () => "gl_cloud_queue_" + (session && session.user ? session.user.id : "anon") + "_" + (Cloud.currentHousehold ? Cloud.currentHousehold.id : "none");
  const isAccessError = e => { const m = String((e && e.message) || "").toLowerCase(); return /row-level security|permission denied|42501|jwt|not authorized|403|401/.test(m) || (e && (e.status === 401 || e.status === 403)); };
  const freeze = v => JSON.parse(JSON.stringify(v));
  function persistQueue() { try { if (queue.length) localStorage.setItem(QKEY(), JSON.stringify(queue)); else localStorage.removeItem(QKEY()); } catch (e) {} }
  // Park the current queue under its own key and start a fresh generation. In-flight work finishes
  // against the OLD generation and can no longer affect the new queue.
  function newGeneration() { persistQueue(); queue = []; inFlight = null; draining = false; generation++; }
  Cloud.pendingWrites = () => queue.length;
  Cloud.restoreQueue = function () {
    try { const q = JSON.parse(localStorage.getItem(QKEY()) || "[]"); if (Array.isArray(q) && q.length) { const fresh = q.filter(op => !queue.some(x => x.seq === op.seq)); queue.unshift(...fresh); return drain(); } } catch (e) {}
    return Promise.resolve();
  };

  Cloud.sync = function (entries) {
    if (!Cloud.currentHousehold) return Promise.resolve();
    const ids = new Set(entries.map(e => e.id));
    entries.forEach(e => {
      const s = sig(e); const k = known.get(e.id);
      const pending = queue.find(op => op.id === e.id && op.type !== "delete" && op !== inFlight);
      if (pending) { pending.body = freeze(e); pending.sig = s; return; }          // coalesce into a NOT-yet-sent op; its base is kept
      const sent = inFlight && inFlight.id === e.id && inFlight.type !== "delete" ? inFlight : null;
      if (sent) { if (sent.sig !== s) queue.push({ type: "update", id: e.id, body: freeze(e), sig: s, seq: nextSeq(), base: null }); return; }   // base resolved once the in-flight op lands
      if (!k) queue.push({ type: "insert", id: e.id, body: freeze(e), sig: s, seq: nextSeq(), base: null });
      else if (k.sig !== s) queue.push({ type: "update", id: e.id, body: freeze(e), sig: s, seq: nextSeq(), base: { version: k.version, sig: k.sig } });
    });
    // Removals: anything the app no longer has, whether the server knows it or it only exists as queued work.
    const removed = new Set();
    for (const [id] of known) if (!ids.has(id)) removed.add(id);
    queue.forEach(op => { if (op.type !== "delete" && !ids.has(op.id)) removed.add(op.id); });
    removed.forEach(id => {
      if (queue.some(op => op.id === id && op.type === "delete")) return;
      const serverWillHaveIt = known.has(id) || (inFlight && inFlight.id === id && inFlight.type !== "delete");
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id && queue[i] !== inFlight) queue.splice(i, 1);   // drop unsent work in place
      if (serverWillHaveIt) queue.push({ type: "delete", id, seq: nextSeq() });
    });
    persistQueue();
    return drain();
  };

  async function drain() {
    if (draining) return;
    draining = true;
    const gen = generation, key = QKEY();
    if (queue.length) handlers.onStatus("saving");
    let failed = null;
    while (queue.length && gen === generation) {
      const op = queue[0]; inFlight = op;
      try {
        if (typeof navigator !== "undefined" && navigator.onLine === false) throw Object.assign(new Error("offline"), { offline: true });
        await apply(op, gen);
        if (gen !== generation) { forgetParked(key, op); break; }      // stale: the world moved on while we waited
        const i = queue.indexOf(op); if (i >= 0) queue.splice(i, 1);
        persistQueue();
      } catch (e) {
        if (gen !== generation) break;                                    // stale failure: the parked copy keeps the op for a later retry
        failed = e; break;
      }
    }
    if (gen !== generation) return;                                       // superseded generation: report nothing, touch nothing
    inFlight = null; draining = false;
    if (failed && !failed.offline && isAccessError(failed)) {
      const dropped = queue.length; queue.splice(0, queue.length); persistQueue();
      Cloud.lastError = failed.message; handlers.onStatus("denied", failed.message);
      handlers.onAccessLost({ household: Cloud.currentHousehold, dropped, message: failed.message });
      return;
    }
    if (failed) { Cloud.lastError = failed.message; handlers.onStatus(failed.offline ? "offline" : "failed", failed.message); }
    else { Cloud.lastError = null; handlers.onStatus("saved"); }
  }
  // Remove one completed operation from a parked queue (stored under an old user/household key).
  function forgetParked(key, op) {
    try { const q = JSON.parse(localStorage.getItem(key) || "[]"); const rest = q.filter(x => x.seq !== op.seq); if (rest.length) localStorage.setItem(key, JSON.stringify(rest)); else localStorage.removeItem(key); } catch (e) {}
  }
  Cloud.retry = () => drain();
  window.addEventListener("online", () => { if (queue.length) drain(); });

  async function apply(op, gen) {
    const hid = Cloud.currentHousehold.id;
    const body = Object.assign({}, op.body); delete body.id;
    const opSig = op.sig;
    const fail = error => { const e = new Error(error.message || "write failed"); e.code = error.code; e.status = error.status; if (error.code === "42501" || error.status === 401 || error.status === 403) e.message = "permission denied: " + e.message; throw e; };
    const remember = (id, version) => { if (gen === generation) known.set(id, { sig: opSig, version }); };
    if (op.type === "delete") {
      const { error } = await sb.from("entries").delete().eq("household_id", hid).eq("id", op.id);
      if (error) fail(error);
      if (gen === generation) known.delete(op.id); return;
    }
    const k = known.get(op.id);
    if (op.type === "insert" || !k) {
      const { data, error } = await sb.from("entries").insert({ id: op.id, household_id: hid, body, version: 1 }).select("version").maybeSingle();
      if (error && error.code !== "23505") fail(error);
      if (error && error.code === "23505") { await resolveConflict(op, gen); return; }   // someone else created this id
      remember(op.id, data ? data.version : 1); return;
    }
    // The server must still be at the version this edit was made against. If it moved on while the
    // edit was parked (someone else saved), do not overwrite their change: resolve as a conflict.
    if (op.base && (op.base.version !== k.version || op.base.sig !== k.sig)) { await resolveConflict(op, gen); return; }
    const expected = op.base ? op.base.version : k.version;
    const { data, error } = await sb.from("entries").update({ body, version: expected + 1 }).eq("household_id", hid).eq("id", op.id).eq("version", expected).select("version");
    if (error) fail(error);
    if (!data || !data.length) { await resolveConflict(op, gen); return; }
    remember(op.id, data[0].version);
  }
  // The server row changed under us (edited on another device). Server wins as the base; the local
  // edit is handed to the app to keep as an "Import conflict"-style copy, unless the content matches.
  async function resolveConflict(op, gen) {
    const { data, error } = await sb.from("entries").select("id, body, version").eq("household_id", Cloud.currentHousehold.id).eq("id", op.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (gen !== generation) return;
    if (!data) { known.delete(op.id); const again = Object.assign({}, op, { type: "insert", base: null }); const i = queue.indexOf(op); if (i >= 0) queue[i] = again; inFlight = again; return apply(again, gen); }
    const server = window.Store.sanitizeEntry(Object.assign({}, data.body, { id: data.id }));
    known.set(op.id, { sig: sig(server), version: data.version });
    if (sig(server) === op.sig) return;
    handlers.onConflict(op.body, server);
  }

  /* ---------------- receipts (private storage) ---------------- */
  const pathFor = id => Cloud.currentHousehold.id + "/" + id;
  async function signedUrls(records) {
    if (!records.length) return {};
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(records.map(r => r.path), 3600);
    if (error) throw new Error(error.message);
    const map = {}; (data || []).forEach((d, i) => { if (d && d.signedUrl) map[records[i].id] = d.signedUrl; });
    return map;
  }
  Cloud.files = {
    async addReceipt(file, entryId) {
      if (!Cloud.canWrite()) throw new Error("Viewers can't add receipts.");
      const id = uid(); const path = pathFor(id);
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (upErr) throw new Error(upErr.message);
      const rec = { id, household_id: Cloud.currentHousehold.id, entry_id: entryId || null, name: (file.name || "receipt").slice(0, 200), type: file.type || "", size: file.size, path };
      const { error } = await sb.from("receipts").insert(rec);
      if (error) { await sb.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
      return { id, entryId: entryId || null, name: rec.name, type: rec.type, size: rec.size, addedAt: new Date().toISOString(), path };
    },
    async listReceipts() {
      if (!Cloud.currentHousehold) return [];
      const { data, error } = await sb.from("receipts").select("id, entry_id, name, type, size, path, created_at").eq("household_id", Cloud.currentHousehold.id).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const recs = (data || []).map(r => ({ id: r.id, entryId: r.entry_id, name: r.name, type: r.type || "", size: r.size, path: r.path, addedAt: r.created_at }));
      const urls = await signedUrls(recs);
      recs.forEach(r => { r.url = urls[r.id] || null; });
      return recs;
    },
    async getReceipt(id) { const all = await this.listReceipts(); return all.find(r => r.id === id) || null; },
    async deleteReceipt(id) {
      const { error } = await sb.from("receipts").delete().eq("household_id", Cloud.currentHousehold.id).eq("id", id);
      if (error) throw new Error(error.message);
      await sb.storage.from(BUCKET).remove([pathFor(id)]).catch(() => {});
    },
    async attachReceipts(ids, entryId) {
      if (!ids.length) return;
      const { error } = await sb.from("receipts").update({ entry_id: entryId }).eq("household_id", Cloud.currentHousehold.id).in("id", ids);
      if (error) throw new Error(error.message);
    },
    async clearReceipts() { throw new Error("Deleting every receipt is not available on a shared ledger."); },
    async fetchBlob(rec) {
      const { data, error } = await sb.storage.from(BUCKET).download(rec.path || pathFor(rec.id));
      if (error) throw new Error(error.message);
      return data;
    }
  };

  /* ---------------- backup export (same file format as device mode) ---------------- */
  Cloud.exportBackup = async function (state) {
    const recs = await Cloud.files.listReceipts();
    const out = [];
    for (const r of recs) {
      const blob = await Cloud.files.fetchBlob(r);
      const dataUrl = await new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(new Error("read " + r.name)); f.readAsDataURL(blob); });
      out.push({ id: r.id, entryId: r.entryId, name: r.name, type: r.type, size: r.size, addedAt: r.addedAt, data: dataUrl });
    }
    return { app: "giving-ledger", version: 2, exportedAt: new Date().toISOString(), household: Cloud.currentHousehold.name, counts: { entries: state.entries.length, receipts: out.length, missingReceiptFiles: 0 }, entries: state.entries, settings: {}, receipts: out };
  };

  /* ---------------- merge a backup file into the household ---------------- */
  // Merge only (Replace is a device-mode operation). Receipts are uploaded under fresh ids, entries
  // are re-pointed, then the app commits the merged ledger through its normal sync path.
  Cloud.importBackup = async function (json, state, commit) {
    if (!json || typeof json !== "object" || json.app !== "giving-ledger" || !Array.isArray(json.entries)) throw new Error("That isn't a Giving Ledger backup file.");
    if (!Cloud.canWrite()) throw new Error("You have read-only access to this ledger.");
    const incoming = json.entries.map(window.Store.sanitizeEntry).filter(Boolean);
    const rejected = json.entries.length - incoming.length;
    const idMap = new Map(); const failed = []; let receiptsAdded = 0;
    for (const r of (Array.isArray(json.receipts) ? json.receipts : [])) {
      try {
        const blob = await (await fetch(r.data)).blob();
        const rec = await Cloud.files.addReceipt(new File([blob], r.name || "receipt", { type: r.type || blob.type }), null);
        idMap.set(r.id, rec.id); receiptsAdded++;
      } catch (e) { failed.push(r && r.name ? r.name : "(unnamed)"); }
    }
    let existingFiles = new Set();
    try { existingFiles = new Set((await Cloud.files.listReceipts()).map(r => r.id)); } catch (e) { /* treated as none */ }
    incoming.forEach(e => { e.receiptIds = (e.receiptIds || []).filter(id => idMap.has(id) || existingFiles.has(id)).map(id => idMap.get(id) || id); });
    const result = window.Store.mergeEntries(state.entries, incoming);
    if (!commit({ entries: result.entries, settings: state.settings })) throw new Error("Couldn't save the merged ledger.");
    for (const e of result.entries) { const mine = (e.receiptIds || []).filter(id => [...idMap.values()].includes(id)); if (mine.length) await Cloud.files.attachReceipts(mine, e.id).catch(() => {}); }
    return { added: result.added, updated: 0, skipped: result.skipped, conflicts: result.conflicts, rejected, receiptsAdded, receiptsFailed: failed, staleRemoved: 0, staleRemoveFailed: 0 };
  };

  /* ---------------- migration from this device's ledger ---------------- */
  // Copies local entries + receipt files into the current household, then READS EVERYTHING BACK and
  // verifies it before reporting success. Nothing local is removed here; the app offers that only
  // after verification. Entries that already exist in the household (same id) are skipped.
  const sha256 = async blob => { const buf = await blob.arrayBuffer(); const h = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join(""); };
  Cloud.migrateLocal = async function (localState, localReceipts, onProgress) {
    const hid = Cloud.currentHousehold.id;
    const progress = msg => { try { (onProgress || (() => {}))(msg); } catch (e) {} };
    const entries = localState.entries.filter(e => !e.sample);
    const current = await fetchEntries();                        // what the household holds right now
    const currentById = new Map(current.map(e => [e.id, e]));
    const existing = new Set(currentById.keys());
    const referenced = new Set(entries.flatMap(e => e.receiptIds || []));
    const files = localReceipts.filter(r => referenced.has(r.id) || !r.entryId);
    const idMap = new Map();
    let uploaded = 0, reused = 0;
    // Receipts already copied by an earlier, interrupted run are found by their original id and reused.
    const { data: prior, error: priorErr } = await sb.from("receipts").select("id, source_id").eq("household_id", hid).not("source_id", "is", null);
    if (priorErr) throw new Error(priorErr.message);
    (prior || []).forEach(p => idMap.set(p.source_id, p.id));
    for (const r of files) {
      if (idMap.has(r.id)) { reused++; continue; }
      progress(`Uploading receipt ${uploaded + 1} of ${files.length - reused}…`);
      const id = uid(); const path = pathFor(id);
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, r.blob, { contentType: r.type || "application/octet-stream" });
      if (upErr) throw new Error("Upload failed for " + r.name + ": " + upErr.message);
      const { error } = await sb.from("receipts").insert({ id, household_id: hid, entry_id: null, name: r.name, type: r.type || "", size: r.size, path, source_id: r.id });
      if (error) { await sb.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error("Could not record " + r.name + ": " + error.message); }
      idMap.set(r.id, id); uploaded++;
    }
    // Same id already in the household: identical content → skip; different content → keep the local
    // version as an import-conflict copy (never silently drop it, never overwrite the household's).
    const rows = []; let skipped = 0, conflicts = 0;
    for (const e of entries) {
      const mapped = Object.assign({}, e, { receiptIds: (e.receiptIds || []).map(id => idMap.get(id) || id) }); delete mapped.sample;
      if (existing.has(e.id)) {
        if (sig(window.Store.sanitizeEntry(mapped)) === sig(currentById.get(e.id))) { skipped++; continue; }
        // a retry must not create a second conflict copy of the same local version
        const sameContent = (x, y) => sig(Object.assign({}, window.Store.sanitizeEntry(x), { id: "", conflictOf: "" })) === sig(Object.assign({}, window.Store.sanitizeEntry(y), { id: "", conflictOf: "" }));
        if (current.some(c => c.conflictOf === e.id && sameContent(c, mapped))) { skipped++; continue; }
        const copy = Object.assign({}, mapped, { id: uid(), conflictOf: e.id });
        const body = Object.assign({}, copy); delete body.id;
        rows.push({ id: copy.id, household_id: hid, body, version: 1 }); conflicts++;
      } else {
        const body = Object.assign({}, mapped); delete body.id;
        rows.push({ id: e.id, household_id: hid, body, version: 1 });
      }
    }
    progress(`Saving ${rows.length} entries…`);
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await sb.from("entries").insert(rows.slice(i, i + 50));
      if (error) throw new Error("Could not save entries: " + error.message);
    }
    // link uploaded receipts to their entries
    for (const row of rows) for (const rid of row.body.receiptIds || []) { if ([...idMap.values()].includes(rid)) await sb.from("receipts").update({ entry_id: row.id }).eq("household_id", hid).eq("id", rid); }
    // verify: every saved entry must read back with the same content, and every receipt file the
    // local ledger references must download from the household with matching bytes (SHA-256).
    progress("Verifying entries…");
    const fresh = await fetchEntries();
    const freshById = new Map(fresh.map(e => [e.id, e]));
    const missingEntries = rows.filter(r => { const got = freshById.get(r.id); return !got || sig(got) !== sig(window.Store.sanitizeEntry(Object.assign({}, r.body, { id: r.id }))); }).map(r => r.id);
    const missingReceipts = [];
    // 1. every receipt an entry references must exist locally AND read back from the household intact
    const referencedLocal = [...new Set(entries.flatMap(e => e.receiptIds || []))];
    // 2. every file this run copied or reused (including unlinked ones) must read back intact,
    //    because the app will offer to delete the local originals afterwards
    const toVerify = [...new Set(referencedLocal.concat(files.map(r => r.id)))];
    let n = 0;
    for (const localId of toVerify) {
      n++; progress(`Verifying receipt ${n} of ${toVerify.length}…`);
      const local = localReceipts.find(r => r.id === localId); const cloudId = idMap.get(localId);
      if (!local) { missingReceipts.push(localId + " (referenced by an entry but the file is not on this device)"); continue; }
      if (!cloudId) { missingReceipts.push(localId + " (not copied)"); continue; }
      try {
        const remote = await Cloud.files.fetchBlob({ id: cloudId, path: pathFor(cloudId) });
        if (!remote || (await sha256(remote)) !== (await sha256(local.blob))) missingReceipts.push(cloudId);
      } catch (e) { missingReceipts.push(cloudId); }
    }
    const verified = !missingEntries.length && !missingReceipts.length;
    return { entries: rows.length - conflicts, conflicts, skipped, receipts: uploaded, receiptsReused: reused, verified, missingEntries, missingReceipts, all: fresh };
  };

  window.Cloud = Cloud;
})();
