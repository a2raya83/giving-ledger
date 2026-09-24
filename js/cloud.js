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
  let handlers = { onAuth: () => {}, onStatus: () => {}, onRemoteChange: () => {}, onConflict: () => {} };
  let session = null;
  let channel = null;

  /* ---------------- auth ---------------- */
  Cloud.init = async function (h) {
    handlers = Object.assign(handlers, h || {});
    const { data } = await sb.auth.getSession();
    session = data.session || null;
    sb.auth.onAuthStateChange((_event, s) => { const was = !!session; session = s; if (!!s !== was || (s && session && s.user.id !== session.user.id)) handlers.onAuth(Cloud.user()); });
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
  Cloud.signOut = async function () { await unsubscribe(); Cloud.currentHousehold = null; known = new Map(); await sb.auth.signOut(); };

  /* ---------------- households & access ---------------- */
  Cloud.households = async function () {
    const { data, error } = await sb.from("household_members").select("role, households(id, name, created_at)").order("joined_at");
    if (error) throw new Error(error.message);
    return (data || []).filter(r => r.households).map(r => ({ id: r.households.id, name: r.households.name, role: r.role }));
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
  Cloud.canWrite = () => !!Cloud.currentHousehold && Cloud.currentHousehold.role !== "viewer";

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
  // and drain them one at a time. Status events: saving → saved | failed | offline.
  let queue = [];
  let draining = false;
  const QKEY = () => "gl_cloud_queue_" + (Cloud.currentHousehold ? Cloud.currentHousehold.id : "none");
  function persistQueue() { try { if (queue.length) localStorage.setItem(QKEY(), JSON.stringify(queue)); else localStorage.removeItem(QKEY()); } catch (e) {} }
  Cloud.pendingWrites = () => queue.length;
  Cloud.restoreQueue = function () { try { const q = JSON.parse(localStorage.getItem(QKEY()) || "[]"); if (Array.isArray(q) && q.length) { queue = q.concat(queue); return drain(); } } catch (e) {} return Promise.resolve(); };

  Cloud.sync = function (entries) {
    if (!Cloud.currentHousehold) return Promise.resolve();
    const ids = new Set();
    entries.forEach(e => {
      ids.add(e.id);
      const s = sig(e); const k = known.get(e.id);
      const existing = queue.find(op => op.id === e.id && op.type !== "delete");
      if (existing) { existing.body = e; existing.sig = s; return; }       // coalesce repeated edits
      if (!k) queue.push({ type: "insert", id: e.id, body: e, sig: s });
      else if (k.sig !== s) queue.push({ type: "update", id: e.id, body: e, sig: s, version: k.version });
    });
    for (const [id] of known) if (!ids.has(id) && !queue.some(op => op.id === id && op.type === "delete")) { queue = queue.filter(op => op.id !== id); queue.push({ type: "delete", id }); }
    persistQueue();
    return drain();
  };

  async function drain() {
    if (draining) return;
    draining = true;
    if (queue.length) handlers.onStatus("saving");
    let failed = null;
    while (queue.length) {
      const op = queue[0];
      try {
        if (typeof navigator !== "undefined" && navigator.onLine === false) throw Object.assign(new Error("offline"), { offline: true });
        await apply(op);
        queue.shift(); persistQueue();
      } catch (e) {
        failed = e; break;
      }
    }
    draining = false;
    if (failed) { Cloud.lastError = failed.message; handlers.onStatus(failed.offline ? "offline" : "failed", failed.message); }
    else { Cloud.lastError = null; handlers.onStatus("saved"); }
  }
  Cloud.retry = () => drain();
  window.addEventListener("online", () => { if (queue.length) drain(); });

  async function apply(op) {
    const hid = Cloud.currentHousehold.id;
    if (op.type === "delete") {
      const { error } = await sb.from("entries").delete().eq("household_id", hid).eq("id", op.id);
      if (error) throw new Error(error.message);
      known.delete(op.id); return;
    }
    const body = Object.assign({}, op.body); delete body.id;
    if (op.type === "insert" || !known.has(op.id)) {
      const { data, error } = await sb.from("entries").insert({ id: op.id, household_id: hid, body, version: 1 }).select("version").maybeSingle();
      if (error && error.code !== "23505") throw new Error(error.message);
      if (error && error.code === "23505") { await resolveConflict(op); return; }   // someone else created this id
      known.set(op.id, { sig: op.sig, version: data ? data.version : 1 }); return;
    }
    const { data, error } = await sb.from("entries").update({ body, version: op.version + 1 }).eq("household_id", hid).eq("id", op.id).eq("version", op.version).select("version");
    if (error) throw new Error(error.message);
    if (!data || !data.length) { await resolveConflict(op); return; }
    known.set(op.id, { sig: op.sig, version: data[0].version });
  }
  // The server row changed under us (edited on another device). Server wins as the base; the local
  // edit is handed to the app to keep as an "Import conflict"-style copy, unless the content matches.
  async function resolveConflict(op) {
    const { data, error } = await sb.from("entries").select("id, body, version").eq("household_id", Cloud.currentHousehold.id).eq("id", op.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { known.delete(op.id); queue[0] = { type: "insert", id: op.id, body: op.body, sig: op.sig }; return apply(queue[0]); }
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
    incoming.forEach(e => { e.receiptIds = (e.receiptIds || []).map(id => idMap.get(id) || id).filter(id => idMap.has(id) ? true : known.has(id) || state.entries.some(x => (x.receiptIds || []).includes(id))); });
    const result = window.Store.mergeEntries(state.entries, incoming);
    if (!commit({ entries: result.entries, settings: state.settings })) throw new Error("Couldn't save the merged ledger.");
    for (const e of result.entries) { const mine = (e.receiptIds || []).filter(id => [...idMap.values()].includes(id)); if (mine.length) await Cloud.files.attachReceipts(mine, e.id).catch(() => {}); }
    return { added: result.added, updated: 0, skipped: result.skipped, conflicts: result.conflicts, rejected, receiptsAdded, receiptsFailed: failed, staleRemoved: 0, staleRemoveFailed: 0 };
  };

  /* ---------------- migration from this device's ledger ---------------- */
  // Copies local entries + receipt files into the current household, then READS EVERYTHING BACK and
  // verifies it before reporting success. Nothing local is removed here; the app offers that only
  // after verification. Entries that already exist in the household (same id) are skipped.
  Cloud.migrateLocal = async function (localState, localReceipts, onProgress) {
    const hid = Cloud.currentHousehold.id;
    const progress = msg => { try { (onProgress || (() => {}))(msg); } catch (e) {} };
    const entries = localState.entries.filter(e => !e.sample);
    const existing = new Set(known.keys());
    const referenced = new Set(entries.flatMap(e => e.receiptIds || []));
    const files = localReceipts.filter(r => referenced.has(r.id) || !r.entryId);
    const idMap = new Map();
    let uploaded = 0;
    for (const r of files) {
      progress(`Uploading receipt ${uploaded + 1} of ${files.length}…`);
      const id = uid(); const path = pathFor(id);
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, r.blob, { contentType: r.type || "application/octet-stream" });
      if (upErr) throw new Error("Upload failed for " + r.name + ": " + upErr.message);
      const { error } = await sb.from("receipts").insert({ id, household_id: hid, entry_id: null, name: r.name, type: r.type || "", size: r.size, path });
      if (error) throw new Error("Could not record " + r.name + ": " + error.message);
      idMap.set(r.id, id); uploaded++;
    }
    const rows = entries.filter(e => !existing.has(e.id)).map(e => { const body = Object.assign({}, e, { receiptIds: (e.receiptIds || []).map(id => idMap.get(id) || id) }); delete body.id; delete body.sample; return { id: e.id, household_id: hid, body, version: 1 }; });
    progress(`Saving ${rows.length} entries…`);
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await sb.from("entries").insert(rows.slice(i, i + 50));
      if (error) throw new Error("Could not save entries: " + error.message);
    }
    // link uploaded receipts to their entries
    for (const row of rows) for (const rid of row.body.receiptIds || []) { if ([...idMap.values()].includes(rid)) await sb.from("receipts").update({ entry_id: row.id }).eq("household_id", hid).eq("id", rid); }
    // verify: every entry id and every uploaded receipt must be readable from the server
    progress("Verifying…");
    const fresh = await fetchEntries();
    const missingEntries = rows.filter(r => !fresh.some(e => e.id === r.id)).map(r => r.id);
    const { data: recRows, error: recErr } = await sb.from("receipts").select("id").eq("household_id", hid).in("id", [...idMap.values()].length ? [...idMap.values()] : ["-"]);
    if (recErr) throw new Error(recErr.message);
    const missingReceipts = [...idMap.values()].filter(id => !(recRows || []).some(r => r.id === id));
    const verified = !missingEntries.length && !missingReceipts.length;
    return { entries: rows.length, skipped: entries.length - rows.length, receipts: uploaded, verified, missingEntries, missingReceipts, all: fresh };
  };

  window.Cloud = Cloud;
})();
