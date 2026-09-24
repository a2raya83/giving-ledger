// Failure-mode tests for Giving Ledger. Paste into the browser console on a running copy
// (http://localhost:8765). WARNING: resets this browser's ledger and receipts first.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = []; const T = (n, c) => log.push((c ? "PASS" : "FAIL") + "  " + n);
  const st = () => JSON.parse(localStorage.getItem("giving_ledger_v2"));
  const recs = async () => (await window.Store.listReceipts()).map(r => r.id).sort();
  const toast = () => document.getElementById("toast").textContent;
  const pngFile = async name => { const c = document.createElement("canvas"); c.width = 20; c.height = 20; c.getContext("2d").fillRect(0, 0, 20, 20); const b = await new Promise(r => c.toBlob(r, "image/png")); return new File([b], name, { type: "image/png" }); };
  const toDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
  const gwRow = () => [...document.querySelectorAll("#ledgerTable tr.entry")].find(r => r.textContent.includes("Goodwill"));
  const gw = () => st().entries.find(e => e.org === "Goodwill Industries");
  async function importFile(json, mode) {
    document.getElementById("backupBtn").click(); await sleep(200);
    const inp = document.getElementById(mode === "replace" ? "bkReplace" : "bkImport");
    const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify(json)], "b.json", { type: "application/json" }));
    inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); await sleep(900);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await sleep(100); return toast();
  }

  // reset
  localStorage.clear(); await window.Store.clearReceipts().catch(() => {});
  document.getElementById("backupBtn").click(); await sleep(150); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.querySelector(".tab[data-view='ledger']").click(); await sleep(100);
  if (!document.getElementById("loadSamplesInline")) { location.reload(); return console.log("Reloaded to reset — paste again."); }

  // setup: samples + one receipt attached to Goodwill through the form
  document.getElementById("loadSamplesInline").click(); await sleep(400);
  gwRow().querySelector("[data-act='edit']").click(); await sleep(300);
  { const dt = new DataTransfer(); dt.items.add(await pngFile("gw.png")); const inp = document.getElementById("f_files"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); }
  for (let i = 0; i < 20 && document.getElementById("saveHint").textContent.startsWith("Processing"); i++) await sleep(200);
  document.getElementById("saveBtn").click(); await sleep(600);
  const baseEntries = st().entries.length, baseRecs = await recs();
  T("setup: 11 sample entries, Goodwill has 1 receipt file", baseEntries === 11 && gw().receiptIds.length === 1 && baseRecs.length === 1);

  const mkEntry = (id, org, cat, desc, v) => ({ id, kind: "noncash", date: "2026-05-01", donor: "Test", org, items: [{ desc, category: cat, qty: 1, unitValue: v, condition: "good" }], ackReceived: true, hasReceiptDecl: true, receiptIds: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" });
  const rcpt = async id => ({ id, entryId: null, name: id + ".png", type: "image/png", size: 100, addedAt: "2026-05-01T00:00:00Z", data: await toDataUrl(await pngFile(id + ".png")) });
  const backup = { app: "giving-ledger", version: 2, entries: [mkEntry("t1", "Charity A", "Men's clothing", "Suits", 3000), mkEntry("t2", "Charity B", "Women's clothing", "Coats", 2500)], receipts: [await rcpt("r1"), await rcpt("r2"), await rcpt("r3")] };

  // A: replace; receipt storage fails on the 2nd write
  window.Store._test.allowFirst = 1; window.Store._test.failWrites = 1;
  let msg = await importFile(backup, "replace");
  window.Store._test.failWrites = 0; window.Store._test.allowFirst = 0;
  T("A: replace fails midway → error says unchanged", /unchanged/i.test(msg));
  T("A: ledger entries intact", st().entries.length === baseEntries && gw().receiptIds.length === 1);
  T("A: receipt store rolled back to original set", JSON.stringify(await recs()) === JSON.stringify(baseRecs));

  // B: replace; receipts written, then the ledger write fails
  const realSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error("QuotaExceeded (simulated)"); };
  msg = await importFile(backup, "replace");
  Storage.prototype.setItem = realSet;
  T("B: ledger write fails after receipts → error", /unchanged|Nothing was changed/i.test(msg));
  T("B: ledger entries intact", st().entries.length === baseEntries);
  T("B: receipt writes rolled back", JSON.stringify(await recs()) === JSON.stringify(baseRecs));

  // C: save fails after a staged receipt removal
  gwRow().querySelector("[data-act='edit']").click(); await sleep(300);
  document.querySelector("#thumbs .rm").click(); await sleep(200);
  Storage.prototype.setItem = function () { throw new Error("QuotaExceeded (simulated)"); };
  document.getElementById("saveBtn").click(); await sleep(500);
  Storage.prototype.setItem = realSet;
  T("C: save failure reported, form kept", /Not saved/.test(document.getElementById("saveHint").textContent) && document.getElementById("formTitle").textContent === "Edit entry");
  T("C: stored entry still references its receipt and the file exists", gw().receiptIds.length === 1 && (await recs()).length === 1);
  document.getElementById("cancelEdit").click(); await sleep(300);
  T("C: after cancel, receipt still attached and file present", gw().receiptIds.length === 1 && (await recs()).length === 1);

  // D: merge with a conflicting version of the same entry
  const full = await window.Store.exportBackup(st());
  const mod = JSON.parse(JSON.stringify(full)); const m = mod.entries.find(e => e.org === "Goodwill Industries"); m.notes = "Edited on another device"; m.items[0].unitValue = 40;
  msg = await importFile(mod, "merge");
  T("D: merge reports the conflict", /1 conflict/.test(msg));
  T("D: both versions kept, original untouched", st().entries.length === baseEntries + 1 && st().entries.filter(e => e.conflictOf).length === 1 && gw().items[0].unitValue === 35 && !document.getElementById("conflictBanner").hidden);
  const crow = [...document.querySelectorAll("#ledgerTable tr.entry")].find(r => r.querySelector(".badge.conflict"));
  T("D: conflict row shows badge and resolve buttons", !!crow && !!crow.querySelector("[data-act='keep']") && !!crow.querySelector("[data-act='discard']"));
  crow.querySelector("[data-act='discard']").click(); await sleep(400);
  T("D: 'Keep mine' removes the imported copy", st().entries.length === baseEntries && !st().entries.some(e => e.conflictOf) && gw().items[0].unitValue === 35);

  // E: similar goods across guide categories and charities
  msg = await importFile({ app: "giving-ledger", version: 2, entries: backup.entries, receipts: [] }, "merge");
  document.querySelector(".tab[data-view='summary']").click(); await sleep(300);
  const ck = [...document.querySelectorAll("#summaryGrid .checklist .item")].map(i => i.textContent);
  // $5,500 from the two test entries + $130 of sample Goodwill clothing = $5,630
  T("E: appraisal check aggregates Clothing across categories and charities ($5,630)", ck.some(t => /Clothing \$5,630/.test(t)));
  T("E: merge added the two entries", st().entries.length === baseEntries + 2);

  console.log(log.join("\n"));
  console.log(log.some(l => l.startsWith("FAIL")) ? "SOME FAILED" : "ALL PASS");
})();
