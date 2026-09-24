// Failure-mode tests for Giving Ledger. Paste into the browser console on a running copy
// (http://localhost:8765). WARNING: deletes this browser's ledger and receipts first.
// Everything runs against the real UI: file inputs, buttons, toasts, localStorage, IndexedDB.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = []; const T = (n, c) => log.push((c ? "PASS" : "FAIL") + "  " + n);
  const st = () => JSON.parse(localStorage.getItem("giving_ledger_v2"));
  const recs = async () => (await window.Store.listReceipts());
  const recIds = async () => (await recs()).map(r => r.id).sort();
  const toast = () => document.getElementById("toast").textContent;
  const hero = () => document.querySelector("#ledgerStats .stat.hero .value").textContent;
  const pngFile = async name => { const c = document.createElement("canvas"); c.width = 20; c.height = 20; c.getContext("2d").fillRect(0, 0, 20, 20); const b = await new Promise(r => c.toBlob(r, "image/png")); return new File([b], name, { type: "image/png" }); };
  const toDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
  const gwRow = () => [...document.querySelectorAll("#ledgerTable tr.entry")].find(r => r.textContent.includes("Goodwill") && !r.querySelector(".badge.conflict"));
  const gw = () => st().entries.find(e => e.org === "Goodwill Industries" && !e.conflictOf);
  const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  async function importFile(json, mode) {
    document.getElementById("backupBtn").click(); await sleep(200);
    const inp = document.getElementById(mode === "replace" ? "bkReplace" : "bkImport");
    const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify(json)], "b.json", { type: "application/json" }));
    inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); await sleep(900);
    esc(); await sleep(100); return toast();
  }
  const mkEntry = (id, org, cat, desc, v, rid) => ({ id, kind: "noncash", date: "2026-05-01", donor: "Test", org, items: [{ desc, category: cat, qty: 1, unitValue: v, condition: "good" }], ackReceived: true, hasReceiptDecl: true, receiptIds: rid ? [rid] : [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" });
  const rcpt = async (id, name) => ({ id, entryId: null, name: name || id + ".png", type: "image/png", size: 100, addedAt: "2026-05-01T00:00:00Z", data: await toDataUrl(await pngFile(name || id + ".png")) });

  // ---- reset through the UI (Backup & data → Delete all data, confirmed) ----
  document.getElementById("backupBtn").click(); await sleep(200);
  document.getElementById("bkClear").click(); await sleep(100); document.getElementById("bkClear").click(); await sleep(500); esc(); await sleep(100);
  document.querySelector(".tab[data-view='ledger']").click(); await sleep(150);

  // ---- setup: samples + one receipt attached to Goodwill through the form ----
  document.getElementById("loadSamplesInline").click(); await sleep(400);
  gwRow().querySelector("[data-act='edit']").click(); await sleep(300);
  { const dt = new DataTransfer(); dt.items.add(await pngFile("gw.png")); const inp = document.getElementById("f_files"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); }
  for (let i = 0; i < 20 && document.getElementById("saveHint").textContent.startsWith("Processing"); i++) await sleep(200);
  document.getElementById("saveBtn").click(); await sleep(600);
  const baseEntries = st().entries.length, baseRecs = await recIds(), baseTotal = hero(), gwRecId = gw().receiptIds[0];
  T("setup: 11 sample entries, Goodwill has 1 receipt file", baseEntries === 11 && baseRecs.length === 1);

  const backup = { app: "giving-ledger", version: 2, entries: [mkEntry("t1", "Charity A", "Men's clothing", "Suits", 3000), mkEntry("t2", "Charity B", "Women's clothing", "Coats", 2500)], receipts: [await rcpt("r1"), await rcpt("r2"), await rcpt("r3")] };

  // ---- A: replace; receipt storage fails on the 2nd write ----
  window.Store._test.allowFirst = 1; window.Store._test.failWrites = 1;
  let msg = await importFile(backup, "replace");
  window.Store._test.failWrites = 0; window.Store._test.allowFirst = 0;
  T("A: replace fails midway → error says unchanged", /unchanged/i.test(msg));
  T("A: ledger entries intact", st().entries.length === baseEntries && gw().receiptIds[0] === gwRecId);
  T("A: receipt store rolled back to original set", JSON.stringify(await recIds()) === JSON.stringify(baseRecs));

  // ---- B: replace; receipts written, then the ledger write fails ----
  const realSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error("QuotaExceeded (simulated)"); };
  msg = await importFile(backup, "replace");
  Storage.prototype.setItem = realSet;
  T("B: ledger write fails after receipts → error", /unchanged|Nothing was changed/i.test(msg));
  T("B: ledger entries intact", st().entries.length === baseEntries);
  T("B: receipt writes rolled back", JSON.stringify(await recIds()) === JSON.stringify(baseRecs));

  // ---- C: save fails after a staged receipt removal ----
  gwRow().querySelector("[data-act='edit']").click(); await sleep(300);
  document.querySelector("#thumbs .rm").click(); await sleep(200);
  Storage.prototype.setItem = function () { throw new Error("QuotaExceeded (simulated)"); };
  document.getElementById("saveBtn").click(); await sleep(500);
  Storage.prototype.setItem = realSet;
  T("C: save failure reported, form kept", /Not saved/.test(document.getElementById("saveHint").textContent) && document.getElementById("formTitle").textContent === "Edit entry");
  T("C: stored entry still references its receipt and the file exists", gw().receiptIds.length === 1 && (await recs()).length === 1);
  document.getElementById("cancelEdit").click(); await sleep(300);
  T("C: after cancel, receipt still attached and file present", gw().receiptIds.length === 1 && (await recs()).length === 1);

  // ---- D: merge with a NESTED change (item description + value) → conflict; conflict never counts ----
  const full = await window.Store.exportBackup(st());
  const mod = JSON.parse(JSON.stringify(full)); const m = mod.entries.find(e => e.org === "Goodwill Industries"); m.items[0].desc = "Coat"; m.items[0].unitValue = 100;
  msg = await importFile(mod, "merge");
  T("D: nested item change produces a conflict", /1 conflict/.test(msg) && st().entries.filter(e => e.conflictOf).length === 1);
  T("D: original untouched (item still $35)", gw().items[0].unitValue === 35 && !document.getElementById("conflictBanner").hidden);
  T("D: hero total unchanged while the conflict is pending", hero() === baseTotal);
  document.querySelector(".tab[data-view='summary']").click(); await sleep(200);
  T("D: filing checklist lists the unresolved conflict", [...document.querySelectorAll("#summaryGrid .checklist .item")].some(i => /import conflict/i.test(i.textContent)));
  let copied = ""; const realWrite = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = t => { copied = t; return Promise.resolve(); };
  document.querySelector(".tab[data-view='ledger']").click(); await sleep(200); document.getElementById("copyCsvBtn").click(); await sleep(300);
  navigator.clipboard.writeText = realWrite;
  T("D: CSV export leaves the conflict copy out and says so", copied.split("\n").length - 1 === baseEntries && /1 unresolved import conflict/.test(toast()));
  const crow = [...document.querySelectorAll("#ledgerTable tr.entry")].find(r => r.querySelector(".badge.conflict"));
  T("D: conflict row shows badge and resolve buttons", !!crow && !!crow.querySelector("[data-act='keep']") && !!crow.querySelector("[data-act='discard']"));
  crow.querySelector("[data-act='discard']").click(); await sleep(400);
  T("D: 'Keep mine' removes the imported copy", st().entries.length === baseEntries && !st().entries.some(e => e.conflictOf) && gw().items[0].unitValue === 35);

  // ---- E: similar goods across guide categories and charities ----
  msg = await importFile({ app: "giving-ledger", version: 2, entries: backup.entries, receipts: [] }, "merge");
  document.querySelector(".tab[data-view='summary']").click(); await sleep(300);
  const ck = [...document.querySelectorAll("#summaryGrid .checklist .item")].map(i => i.textContent);
  // $5,500 from the two test entries + $130 of sample Goodwill clothing = $5,630
  T("E: appraisal check aggregates Clothing across categories and charities ($5,630)", ck.some(t => /Clothing \$5,630/.test(t)));
  T("E: merge added the two entries", st().entries.length === baseEntries + 2);
  document.querySelector(".tab[data-view='ledger']").click(); await sleep(200);

  // ---- F: restore interrupted before commit (simulated closed tab): previous dataset stays intact ----
  // The backup reuses the existing Goodwill receipt id on purpose, to prove the live file is never overwritten.
  const crashBackup = { app: "giving-ledger", version: 2, entries: [mkEntry("t9", "Charity Z", "Furniture", "Sofa", 100, gwRecId)], receipts: [await rcpt(gwRecId, "replacement.png"), await rcpt("x2")] };
  const entriesBefore = st().entries.length;
  window.Store._test.crashBeforeCommit = true;
  msg = await importFile(crashBackup, "replace");
  const after = await recs();
  T("F: crash before commit → ledger unchanged, Goodwill still points at its own file", st().entries.length === entriesBefore && gw().receiptIds[0] === gwRecId);
  T("F: live receipt file not overwritten", after.some(r => r.id === gwRecId && r.name === "gw.png" && !r.staged));
  T("F: staged orphans present until the next load", after.filter(r => r.staged).length === 2);
  T("F: cleanupOrphans removes them and keeps the live file", (await window.Store.cleanupOrphans(st())) === 2 && (await recs()).length === 1);

  // ---- G: successful replace uses fresh receipt ids and re-points entries ----
  msg = await importFile(crashBackup, "replace");
  const recs2 = await recs(); const st2 = st();
  const linked = recs2.find(r => r.id === st2.entries[0].receiptIds[0]);
  T("G: replace succeeded: both backup files present under fresh ids, entry re-pointed, old live file removed, staged flags cleared",
    st2.entries.length === 1 && recs2.length === 2 && !recs2.some(r => r.id === gwRecId || r.staged) && !!linked && linked.name === "replacement.png");

  console.log(log.join("\n"));
  console.log(log.some(l => l.startsWith("FAIL")) ? "SOME FAILED" : "ALL PASS");
  return log;
})();
