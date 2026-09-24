// Storage layer. Entries live in localStorage; receipt files live in IndexedDB.
// Everything stays on this device. Backup/restore moves it as a single JSON file.
(function () {
  const LS_KEY = "giving_ledger_v2";
  const DB_NAME = "giving-ledger";
  const STORE = "receipts";
  let dbPromise = null;
  const test = { failWrites: 0, allowFirst: 0 }; // test hook: after allowFirst successful writes, the next failWrites receipt writes fail (failure tests)

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const s = db.createObjectStore(STORE, { keyPath: "id" });
            s.createIndex("entryId", "entryId", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB unavailable"));
        req.onblocked = () => reject(new Error("IndexedDB blocked"));
      } catch (e) { reject(e); }
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  function tx(mode, fn) {
    if (mode === "readwrite" && test.failWrites > 0) { if (test.allowFirst > 0) test.allowFirst--; else { test.failWrites--; return Promise.reject(new Error("Simulated storage failure")); } }
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("Transaction aborted"));
    }));
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { const s = JSON.parse(raw); if (s && Array.isArray(s.entries)) return { entries: s.entries.map(sanitizeEntry).filter(Boolean), settings: s.settings || {} }; }
    } catch (e) { /* storage unavailable or corrupt */ }
    return { entries: [], settings: {} };
  }
  // Returns true on success. Callers must check — a failed save must not be reported as saved.
  function saveState(state) {
    try {
      const json = JSON.stringify(state);
      localStorage.setItem(LS_KEY, json);
      return localStorage.getItem(LS_KEY) === json;
    } catch (e) { return false; }
  }

  /* ---------- validation ---------- */
  const KIND_SET = new Set(["cash", "noncash", "stock", "mileage", "expense"]);
  const str = (v, max = 500) => (v == null ? "" : String(v)).slice(0, max);
  const numOrNull = v => (v === "" || v === null || v === undefined) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const nonNeg = v => Math.max(0, Number(v) || 0);
  const bool = v => !!v;
  const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(Date.parse(v)) ? v : "";

  // Coerce an entry from any source (old versions, imports, hand-edited files) into a well-typed record.
  // Returns null if it can't be an entry at all.
  function sanitizeEntry(e) {
    if (!e || typeof e !== "object" || !KIND_SET.has(e.kind)) return null;
    const out = {
      id: str(e.id, 64) || uid(), kind: e.kind, date: isoDate(e.date), donor: str(e.donor, 120), org: str(e.org, 200), notes: str(e.notes, 2000),
      ackReceived: bool(e.ackReceived), hasReceiptDecl: bool(e.hasReceiptDecl), receiptIds: Array.isArray(e.receiptIds) ? e.receiptIds.map(x => str(x, 64)).filter(Boolean) : [],
      createdAt: str(e.createdAt, 40), updatedAt: str(e.updatedAt, 40), sample: bool(e.sample), benefit: nonNeg(e.benefit), amount: nonNeg(e.amount)
    };
    if (e.conflictOf) out.conflictOf = str(e.conflictOf, 64);
    if (e.kind === "cash") Object.assign(out, { method: str(e.method, 20), checkNo: str(e.checkNo, 60), bankRecord: e.bankRecord !== false });
    if (e.kind === "noncash") Object.assign(out, {
      items: (Array.isArray(e.items) ? e.items : []).map(it => it && typeof it === "object" ? { desc: str(it.desc, 200), category: str(it.category, 60), condition: ["excellent", "good", "fair"].includes(it.condition) ? it.condition : "good", qty: Math.max(1, Math.round(Number(it.qty) || 1)), unitValue: nonNeg(it.unitValue), lo: numOrNull(it.lo), hi: numOrNull(it.hi) } : null).filter(Boolean),
      howValued: str(e.howValued, 120), acquired: str(e.acquired, 300), vehicle: bool(e.vehicle), appraised: bool(e.appraised)
    });
    if (e.kind === "stock") { const s = e.stock || {}; out.stock = { ticker: str(s.ticker, 80), costBasis: numOrNull(s.costBasis), longTerm: s.longTerm !== false }; }
    if (e.kind === "mileage") Object.assign(out, { miles: nonNeg(e.miles), parkingTolls: nonNeg(e.parkingTolls), route: str(e.route, 200), purpose: str(e.purpose, 300), rate: 0.14 });
    if (e.kind === "expense") Object.assign(out, { expenseCategory: str(e.expenseCategory, 20) || "other", expenseDesc: str(e.expenseDesc, 300), reimbursed: bool(e.reimbursed), awayOvernight: bool(e.awayOvernight), personalPleasure: bool(e.personalPleasure), companions: bool(e.companions), uniformNoGeneralUse: bool(e.uniformNoGeneralUse), delegate: bool(e.delegate) });
    return out;
  }
  // Content signature: everything that matters, ignoring timestamps and flags that don't describe the gift.
  function signature(e) {
    const c = Object.assign({}, e); delete c.createdAt; delete c.updatedAt; delete c.sample; delete c.conflictOf;
    return JSON.stringify(c, Object.keys(c).sort());
  }

  /* ---------- receipts ---------- */
  // Downscale images so a phone photo doesn't eat storage. PDFs and other files pass through.
  // Never blocks: if decoding stalls or fails, the original file is stored as-is.
  function compressImage(file, maxDim = 1800, quality = 0.82) {
    if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return Promise.resolve(file);
    const work = (async () => {
      let bmp, w, h, draw;
      if (typeof createImageBitmap === "function") { bmp = await createImageBitmap(file); w = bmp.width; h = bmp.height; draw = bmp; }
      else {
        const url = URL.createObjectURL(file);
        try { draw = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("decode")); i.src = url; }); w = draw.naturalWidth; h = draw.naturalHeight; }
        finally { URL.revokeObjectURL(url); }
      }
      const scale = Math.min(1, maxDim / Math.max(w, h));
      if (scale === 1 && file.size < 900 * 1024) { if (bmp && bmp.close) bmp.close(); return file; }
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
      c.getContext("2d").drawImage(draw, 0, 0, c.width, c.height);
      if (bmp && bmp.close) bmp.close();
      const out = await new Promise(res => c.toBlob(res, "image/jpeg", quality));
      return out && out.size < file.size ? out : file;
    })();
    const timeout = new Promise(res => setTimeout(() => res(file), 6000));
    return Promise.race([work.catch(() => file), timeout]);
  }

  async function addReceipt(file, entryId) {
    const blob = await compressImage(file);
    const rec = { id: uid(), entryId: entryId || null, name: str(file.name, 200), type: blob.type || file.type, size: blob.size, blob, addedAt: new Date().toISOString() };
    await tx("readwrite", s => s.put(rec));
    return rec;
  }
  function getReceipt(id) { return tx("readonly", s => s.get(id)); }
  function listReceipts() { return tx("readonly", s => s.getAll()); }
  function deleteReceipt(id) { return tx("readwrite", s => s.delete(id)); }
  async function attachReceipts(ids, entryId) {
    for (const id of ids) { const r = await getReceipt(id); if (r && r.entryId !== entryId) { r.entryId = entryId; await tx("readwrite", s => s.put(r)); } }
  }
  function clearReceipts() { return tx("readwrite", s => s.clear()); }

  const blobToDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read " + (blob.name || "file"))); r.readAsDataURL(blob); });
  async function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) throw new Error("Bad receipt data");
    const r = await fetch(dataUrl); return r.blob();
  }

  /* ---------- backup ---------- */
  // Throws if receipts can't be read: a backup is never silently incomplete.
  async function exportBackup(state) {
    let receipts;
    try { receipts = await listReceipts(); }
    catch (e) { throw new Error("Couldn't read the stored receipt files, so no backup was made. Try again, or in another browser."); }
    const referenced = new Set(state.entries.flatMap(e => e.receiptIds || []));
    const out = [];
    for (const r of receipts) out.push({ id: r.id, entryId: r.entryId, name: r.name, type: r.type, size: r.size, addedAt: r.addedAt, data: await blobToDataUrl(r.blob) });
    const missing = [...referenced].filter(id => !receipts.some(r => r.id === id));
    return { app: "giving-ledger", version: 2, exportedAt: new Date().toISOString(), counts: { entries: state.entries.length, receipts: out.length, missingReceiptFiles: missing.length }, entries: state.entries, settings: state.settings || {}, receipts: out };
  }

  // Merge incoming entries into existing ones without losing anything:
  //   new id            → added
  //   same id, same content → skipped
  //   same id, different content → the incoming version is kept as a separate "conflict copy"
  //                                 (conflictOf = existing id) for the user to resolve. Clocks are not trusted.
  function mergeEntries(existing, incoming) {
    const entries = existing.slice();
    const byId = new Map(entries.map(e => [e.id, e]));
    let added = 0, skipped = 0, conflicts = 0;
    incoming.forEach(e => {
      const cur = byId.get(e.id);
      if (!cur) { entries.push(e); byId.set(e.id, e); added++; return; }
      if (signature(cur) === signature(e)) { skipped++; return; }
      const copy = Object.assign({}, e, { id: uid(), conflictOf: cur.id });
      entries.push(copy); byId.set(copy.id, copy); conflicts++;
    });
    return { entries, added, skipped, conflicts };
  }

  // Restore from a backup. Nothing existing is discarded until the whole operation has succeeded:
  //   1. validate + decode everything in memory
  //   2. write incoming receipts (remembering what was new and what was overwritten)
  //   3. build the new ledger and ask the app to persist it via `commit(newState)`
  //   4. only if commit succeeded and mode is "replace": delete receipts that aren't in the backup
  // If 2 or 3 fails, receipt writes are rolled back and the original ledger is untouched.
  // Returns { added, updated, skipped, conflicts, rejected, receiptsAdded, receiptsFailed, staleRemoved, staleRemoveFailed }
  async function importBackup(json, state, mode, commit) {
    if (!json || typeof json !== "object" || json.app !== "giving-ledger" || !Array.isArray(json.entries)) throw new Error("That isn't a Giving Ledger backup file.");
    const incoming = json.entries.map(sanitizeEntry).filter(Boolean);
    const rejected = json.entries.length - incoming.length;
    const staged = []; const failed = [];
    for (const r of (Array.isArray(json.receipts) ? json.receipts : [])) {
      try { const blob = await dataUrlToBlob(r.data); staged.push({ id: str(r.id, 64), entryId: r.entryId ? str(r.entryId, 64) : null, name: str(r.name, 200), type: str(r.type, 80) || blob.type, size: blob.size, blob, addedAt: str(r.addedAt, 40) }); }
      catch (e) { failed.push(r && r.name ? r.name : "(unnamed)"); }
    }
    if (mode === "replace" && failed.length) throw new Error(`${failed.length} receipt file${failed.length > 1 ? "s" : ""} in the backup couldn't be decoded, so nothing was replaced. Try "Merge" instead.`);
    if (!incoming.length && !staged.length) throw new Error("The backup contains no usable entries or receipts." + (rejected ? ` (${rejected} malformed entries skipped.)` : ""));

    let existing;
    try { existing = await listReceipts(); } catch (e) { throw new Error("Couldn't read existing receipts; nothing was imported."); }
    const existingMap = new Map(existing.map(r => [r.id, r]));

    // Step 2: write incoming receipts, tracking for rollback.
    const writtenNew = [], overwritten = [];
    let receiptsAdded = 0;
    const rollback = async () => {
      const problems = [];
      for (const id of writtenNew) { try { await deleteReceipt(id); } catch (e) { problems.push(id); } }
      for (const r of overwritten) { try { await tx("readwrite", s => s.put(r)); } catch (e) { problems.push(r.id); } }
      return problems;
    };
    try {
      for (const r of staged) {
        const prior = existingMap.get(r.id);
        if (prior && mode === "merge") continue;             // keep what's already here
        await tx("readwrite", s => s.put(r));
        if (prior) overwritten.push(prior); else writtenNew.push(r.id);
        receiptsAdded++;
      }
      // Step 3: build and commit the new ledger.
      let result;
      if (mode === "replace") result = { entries: incoming, added: incoming.length, skipped: 0, conflicts: 0 };
      else result = mergeEntries(state.entries, incoming);
      const newState = { entries: result.entries, settings: Object.assign({}, state.settings, (json.settings && typeof json.settings === "object") ? json.settings : {}) };
      if (!commit(newState)) throw new Error("Couldn't write the ledger to browser storage (blocked or full). Nothing was changed.");
      // Step 4: replace mode only — remove receipts that are not part of the backup. Best effort; reported.
      let staleRemoved = 0, staleRemoveFailed = 0;
      if (mode === "replace") {
        const keep = new Set(staged.map(r => r.id));
        for (const r of existing) { if (!keep.has(r.id)) { try { await deleteReceipt(r.id); staleRemoved++; } catch (e) { staleRemoveFailed++; } } }
      }
      return { added: result.added, updated: 0, skipped: result.skipped, conflicts: result.conflicts, rejected, receiptsAdded, receiptsFailed: failed, staleRemoved, staleRemoveFailed };
    } catch (e) {
      const problems = await rollback();
      const msg = (e && e.message) || "Restore failed";
      throw new Error(problems.length ? `${msg} Rollback could not undo ${problems.length} receipt write${problems.length > 1 ? "s" : ""}; your ledger entries are unchanged.` : `${msg} Your existing ledger and receipts are unchanged.`);
    }
  }

  window.Store = { uid, loadState, saveState, sanitizeEntry, signature, mergeEntries, addReceipt, getReceipt, listReceipts, deleteReceipt, attachReceipts, clearReceipts, exportBackup, importBackup, _test: test };
})();
