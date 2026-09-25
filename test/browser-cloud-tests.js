// End-to-end cloud tests through the REAL UI against the fake Supabase client.
// Serve the site (node serve.js), open http://localhost:8765/test/cloud-harness.html, and paste
// this into the console. Drives the form, the account flow, restore-on-load, realtime refresh and
// conflict handling. Resets this browser's storage first.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = []; const T = (n, c, x) => log.push((c ? "PASS" : "FAIL") + "  " + n + (c || x === undefined ? "" : "   → " + JSON.stringify(x).slice(0, 200)));
  const F = window.FAKE, E = F.tables.entries;
  const HH = "hh-alice";
  const rows = () => [...document.querySelectorAll("#ledgerTable tr.entry")];
  const rowFor = id => rows().find(r => r.dataset.id === id);
  const hero = () => document.querySelector("#ledgerStats .stat.hero .value").textContent;
  const status = () => document.getElementById("saveStatus").textContent;
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const PHASE = "gl_cloud_phase";

  /* ---------- phase 2: after a real reload with parked work ---------- */
  if (sessionStorage.getItem(PHASE) === "2") {
    const prior = JSON.parse(sessionStorage.getItem("gl_cloud_log") || "[]");
    await sleep(1200);                                              // boot + restore + reconcile
    T("restore on load: parked entry reached the server", E.has("parked1") && E.get("parked1").body.amount === 321);
    T("restore on load: ledger shows the restored entry (reconciled, not the pre-restore snapshot)", !!rowFor("parked1"));
    // now save an UNRELATED new entry through the form
    setVal("f_org", "Unrelated Charity"); setVal("f_amount_cash", "40");
    document.getElementById("saveBtn").click(); await sleep(600);
    T("saving an unrelated entry does NOT delete the restored one", E.has("parked1") && [...E.values()].some(r => r.body.org === "Unrelated Charity"), [...E.keys()]);
    T("status Saved, nothing pending", /Saved/.test(status()) && window.Cloud.pendingWrites() === 0);
    sessionStorage.removeItem(PHASE); sessionStorage.removeItem("gl_cloud_log");
    const all = prior.concat(log);
    console.log(all.join("\n")); console.log(all.some(l => l.startsWith("FAIL")) ? "SOME FAILED" : "ALL PASS (" + all.length + " checks)");
    return all;
  }

  /* ---------- phase 1 ---------- */
  localStorage.clear(); sessionStorage.clear();
  // seed: Alice owns a household with two entries, then sign in through the fake auth
  F.seedHousehold(HH, "Alice household", [["user-alice", "owner"]]);
  F.seedEntry(HH, "d", { kind: "cash", date: "2026-03-01", org: "Food Bank", amount: 999, bankRecord: true, receiptIds: [] }, 1);
  F.seedEntry(HH, "g", { kind: "cash", date: "2026-03-05", org: "Shelter", amount: 50, bankRecord: true, receiptIds: [] }, 1);
  localStorage.setItem("gl_household", HH);
  F.signIn("user-alice", "alice@example.test"); await sleep(900);
  T("sign-in opens the household ledger in the UI", rowFor("d") && rowFor("g") && document.getElementById("accountBtn").textContent === "Alice household");
  T("save status pill visible and Saved", !document.getElementById("saveStatus").hidden && /Saved/.test(status()));

  // form save reaches the server
  setVal("f_org", "New Org"); setVal("f_amount_cash", "25");
  document.getElementById("saveBtn").click(); await sleep(600);
  const created = [...E.values()].find(r => r.body.org === "New Org");
  T("a form save reaches the server and appears in the ledger", !!created && !!rowFor(created.id));

  /* ---- scenario B: someone changes the entry while the edit form is open ---- */
  rowFor("d").querySelector("[data-act='edit']").click(); await sleep(300);
  T("edit form opened with the current value", document.getElementById("f_amount_cash").value === "999");
  E.get("d").body.amount = 9876; E.get("d").version = 2;                 // another device saves
  F.triggerRealtime("entries"); await sleep(800);                        // realtime refresh arrives
  T("realtime refresh updated the ledger row", /9,876/.test(rowFor("d").textContent));
  T("open draft still shows the old value (not silently replaced)", document.getElementById("f_amount_cash").value === "999");
  setVal("f_amount_cash", "1000");                                       // user finishes their edit on the stale draft
  document.getElementById("saveBtn").click(); await sleep(800);
  T("saving the outdated draft does NOT overwrite the other person's change", E.get("d").body.amount === 9876, E.get("d").body);
  const copy = [...E.values()].find(r => r.body.conflictOf === "d");
  T("the draft is preserved as an import-conflict copy on the server", !!copy && copy.body.amount === 1000);
  T("the conflict is visible in the UI", !!rows().find(r => r.querySelector(".badge.conflict")) && !document.getElementById("conflictBanner").hidden);
  T("hero total counts the server value ($9,876 + $50 + $25), not the draft", hero() === "$9,951.00", hero());

  /* ---- scenario A setup: park an unsent insert under Alice's key, then really reload ---- */
  const parked = [{ type: "insert", id: "parked1", body: { kind: "cash", date: "2026-04-01", org: "Parked Org", amount: 321, bankRecord: true, receiptIds: [] }, sig: "x", seq: "t-1", base: null }];
  localStorage.setItem("gl_cloud_queue_user-alice_" + HH, JSON.stringify(parked));
  sessionStorage.setItem(PHASE, "2"); sessionStorage.setItem("gl_cloud_log", JSON.stringify(log));
  // the fake tables live in memory: re-seed them after reload via a bootstrap the harness reads
  sessionStorage.setItem("gl_cloud_seed", JSON.stringify({ hh: HH, entries: [...E.values()] }));
  console.log(log.join("\n")); console.log("Reloading for phase 2 — paste the script again after the page loads.");
  location.reload();
  return log;
})();
