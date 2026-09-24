// Giving Ledger — application
(function () {
  const $ = id => document.getElementById(id);
  const { evaluate, yearSummary, isCountable, money, num, isBlank } = window.Rules;
  const KINDS = window.KINDS, EXP = window.EXPENSE_CATEGORIES, RULES = window.RULES;
  const CFG = window.SITE_CONFIG || {};
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = d => { if (!d) return "—"; const [y, m, dd] = d.split("-"); return `${m}/${dd}/${y}`; };
  const yearOf = e => (e.date || "").slice(0, 4);
  const thisYear = String(new Date().getFullYear());

  let state = window.Store.loadState();
  let receiptsCache = [];        // all receipt records (blobs) from IndexedDB
  let objectUrls = [];
  let editingId = null;
  let originalReceiptIds = [];   // receipts the entry had when editing began
  let pendingReceiptIds = [];    // receipts currently shown in the form
  let stagedRemovals = [];       // original receipts the user removed; deleted only on Save
  let currentKind = "cash";
  let currentView = "ledger";
  let year = state.settings.year || thisYear;

  /* ---------- helpers ---------- */
  function toast(msg, long) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), long ? 5000 : 2400); }
  // Returns true when the state was actually written. Every caller that reports success must check it.
  function persist() {
    state.settings.year = year;
    const ok = window.Store.saveState(state);
    if (!ok) toast("Couldn't save: browser storage is blocked or full. Your change is NOT stored — export a backup and free up space.", true);
    return ok;
  }
  function freeUrls() { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; }
  function urlFor(rec) { const u = URL.createObjectURL(rec.blob); objectUrls.push(u); return u; }
  async function refreshReceipts() { try { receiptsCache = await window.Store.listReceipts(); } catch (e) { receiptsCache = []; toast("Receipt storage is unavailable in this browser; files can't be shown.", true); } }
  const receiptsFor = e => (e.receiptIds || []).map(id => receiptsCache.find(r => r.id === id)).filter(Boolean);
  const ev = e => evaluate(e, { files: receiptsFor(e).length });
  const summarize = entries => yearSummary(entries, { filesFor: e => receiptsFor(e).length });
  function inYear(e) { return year === "all" || yearOf(e) === year; }
  const visibleEntries = () => state.entries.filter(inYear);
  // Entries that count: everything visible except unresolved import conflict copies.
  const countableEntries = () => visibleEntries().filter(isCountable);
  const conflictNote = () => { const n = visibleEntries().filter(e => !isCountable(e)).length; return n ? ` ${n} unresolved import conflict${n > 1 ? "s" : ""} left out.` : ""; };
  function copyText(text) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (e) {} ta.remove(); return ok;
    });
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type }); const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function modal(html, opts = {}) {
    const root = $("modalRoot");
    root.innerHTML = `<div class="modal-back" id="modalBack"><div class="modal ${opts.wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div></div>`;
    const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
    const onKey = ev => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    $("modalBack").addEventListener("click", ev => { if (ev.target.id === "modalBack") close(); });
    root.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
    return close;
  }
  const describe = e => {
    if (e.kind === "noncash") { const items = e.items || []; return items.length ? items.map(i => `${num(i.qty || 1) > 1 ? i.qty + "× " : ""}${i.desc || i.category || "item"}`).join(", ") : (e.notes || "Goods"); }
    if (e.kind === "stock") return e.stock && e.stock.ticker ? e.stock.ticker : "Securities";
    if (e.kind === "mileage") return `${num(e.miles)} mi${e.purpose ? " · " + e.purpose : ""}`;
    if (e.kind === "expense") return `${(EXP[e.expenseCategory] || EXP.other).label}${e.expenseDesc ? " · " + e.expenseDesc : ""}`;
    return e.method ? ({ card: "Card", check: "Check" + (e.checkNo ? " #" + e.checkNo : ""), online: "Online", bank: "Bank transfer", payroll: "Payroll", text: "Text gift", cash: "Cash", other: "" }[e.method] || "") : "";
  };
  const statusBadge = r => r.status === "stop" ? `<span class="badge stop">Not eligible</span>` : r.status === "docs" ? `<span class="badge docs">Documentation needed</span>` : `<span class="badge ok">Records OK</span>`;
  const yearLabel = () => year === "all" ? "all years" : year;

  /* ---------- year picker ---------- */
  function renderYearPicker() {
    const sel = $("yearFilter");
    const years = new Set(state.entries.map(yearOf).filter(Boolean)); years.add(thisYear);
    const list = [...years].sort().reverse();
    sel.innerHTML = list.map(y => `<option value="${y}">${y}</option>`).join("") + `<option value="all">All years</option>`;
    sel.value = list.includes(year) || year === "all" ? year : thisYear; year = sel.value;
  }
  $("yearFilter").addEventListener("change", () => { year = $("yearFilter").value; persist(); renderAll(); });

  /* ---------- views / tabs ---------- */
  function showView(v) {
    currentView = v;
    document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === v)));
    ["ledger", "volunteer", "guide", "receipts", "summary", "rules"].forEach(id => { $("view-" + id).hidden = id !== v; });
    if (v === "ledger") mountForm("formMount", ["cash", "noncash", "stock"]);
    if (v === "volunteer") mountForm("volFormMount", ["mileage", "expense"]);
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => showView(t.dataset.view)));
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if ($("view-" + v)) showView(v); });

  /* ---------- entry form ---------- */
  const form = $("entryForm");
  let allowedKinds = ["cash", "noncash", "stock"];
  function mountForm(slotId, kinds) {
    allowedKinds = kinds;
    if (form.parentElement !== $(slotId)) $(slotId).appendChild(form);
    if (!kinds.includes(currentKind) && !editingId) setKind(kinds[0]);
    renderKindPicker();
  }
  function renderKindPicker() {
    $("kindPicker").innerHTML = allowedKinds.map(k => `<button type="button" data-kind="${k}" aria-pressed="${k === currentKind}">${KINDS[k].label}</button>`).join("");
    $("kindPicker").querySelectorAll("button").forEach(b => b.addEventListener("click", () => setKind(b.dataset.kind)));
  }
  function setKind(k) {
    currentKind = k;
    form.querySelectorAll("[data-kinds]").forEach(el => { el.hidden = !el.dataset.kinds.split(" ").includes(k); });
    if (k === "noncash" && !$("itemRows").children.length) addItemRow();
    renderKindPicker(); updateExpenseVisibility(); updateInsight();
  }
  function updateExpenseVisibility() {
    const cat = $("f_expenseCategory").value;
    form.querySelectorAll("[data-cats]").forEach(el => { if (currentKind === "expense") el.hidden = !el.dataset.cats.split(" ").includes(cat); });
    $("expenseHint").textContent = (EXP[cat] || EXP.other).note;
  }
  $("f_expenseCategory").innerHTML = Object.entries(EXP).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("f_expenseCategory").addEventListener("change", () => { updateExpenseVisibility(); updateInsight(); });
  $("f_howValued").innerHTML = window.FMV_METHODS.map(m => `<option>${esc(m)}</option>`).join("");

  // Non-cash item rows. A row created from the value guide remembers its low/high range so the
  // condition picker can move the value: excellent → high, good → midpoint, fair → low.
  const catOptions = () => `<option value="">Category</option>` + window.FMV_GUIDE.map(g => `<option>${esc(g.cat)}</option>`).join("") + (window.FMV_EXTRA_CATEGORIES || []).map(c => `<option>${esc(c)}</option>`).join("") + `<option>Other</option>`;
  const condOptions = sel => window.FMV_CONDITIONS.map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l.split(" — ")[0]}</option>`).join("");
  const valueForCondition = (cond, lo, hi) => cond === "excellent" ? hi : cond === "fair" ? lo : (lo + hi) / 2;
  function addItemRow(it = {}) {
    const row = document.createElement("div"); row.className = "item-row";
    if (!isBlank(it.lo) && !isBlank(it.hi)) { row.dataset.lo = it.lo; row.dataset.hi = it.hi; }
    row.innerHTML = `<label class="cell desc-cell"><span>Description</span><input class="desc" type="text" placeholder="Description (e.g. men's wool overcoat)" value="${esc(it.desc)}"></label>
      <label class="cell"><span>Category</span><select class="cat">${catOptions()}</select></label>
      <label class="cell"><span>Condition</span><select class="cond">${condOptions(it.condition || "good")}</select></label>
      <label class="cell"><span>Qty</span><input class="qty" type="number" min="1" step="1" value="${Math.max(1, Math.round(num(it.qty) || 1))}"></label>
      <label class="cell"><span>Value each</span><input class="unit" type="number" min="0" step="0.01" placeholder="0.00" value="${it.unitValue != null && it.unitValue !== "" ? esc(it.unitValue) : ""}"></label>
      <span class="total num" aria-label="Line total">$0.00</span>
      <button type="button" class="icon-btn" title="Remove item" aria-label="Remove item">×</button>`;
    row.querySelector(".cat").value = it.category || "";
    row.querySelector(".icon-btn").addEventListener("click", () => { row.remove(); recalcItems(); updateInsight(); });
    row.querySelector(".cond").addEventListener("change", () => {
      if (row.dataset.lo != null) { row.querySelector(".unit").value = valueForCondition(row.querySelector(".cond").value, num(row.dataset.lo), num(row.dataset.hi)).toFixed(2); recalcItems(); updateInsight(); }
    });
    $("itemRows").appendChild(row); recalcItems();
    return row;
  }
  function readItems() {
    return [...$("itemRows").querySelectorAll(".item-row")].map(r => ({
      desc: r.querySelector(".desc").value.trim(), category: r.querySelector(".cat").value, condition: r.querySelector(".cond").value,
      qty: Math.max(1, Math.round(num(r.querySelector(".qty").value) || 1)), unitValue: num(r.querySelector(".unit").value),
      lo: r.dataset.lo != null ? num(r.dataset.lo) : null, hi: r.dataset.hi != null ? num(r.dataset.hi) : null
    })).filter(i => i.desc || i.unitValue);
  }
  function recalcItems() {
    let t = 0;
    $("itemRows").querySelectorAll(".item-row").forEach(r => { const v = (num(r.querySelector(".qty").value) || 1) * num(r.querySelector(".unit").value); r.querySelector(".total").textContent = money(v); t += v; });
    $("itemsTotal").textContent = money(t);
  }
  $("itemRows").addEventListener("input", () => { recalcItems(); updateInsight(); });
  $("addItemBtn").addEventListener("click", () => { addItemRow().querySelector(".desc").focus(); });
  $("openGuideBtn").addEventListener("click", () => showView("guide"));

  // Collect the form into an entry object
  function readForm() {
    const e = {
      id: editingId || window.Store.uid(), kind: currentKind, date: $("f_date").value, donor: $("f_donor").value.trim(), org: $("f_org").value.trim(),
      notes: $("f_notes").value.trim(), ackReceived: $("f_ack").checked, hasReceiptDecl: $("f_hasReceipt").checked, receiptIds: pendingReceiptIds.slice()
    };
    if (currentKind === "cash") Object.assign(e, { amount: num($("f_amount_cash").value), method: $("f_method").value, checkNo: $("f_checkNo").value.trim(), benefit: num($("f_benefit").value), bankRecord: $("f_bankRecord").checked });
    if (currentKind === "noncash") Object.assign(e, { items: readItems(), amount: 0, benefit: num($("f_benefit").value), howValued: $("f_howValued").value, acquired: $("f_acquired").value.trim(), vehicle: $("f_vehicle").checked, appraised: $("f_appraised").checked });
    if (currentKind === "stock") Object.assign(e, { amount: num($("f_amount_stock").value), stock: { ticker: $("f_ticker").value.trim(), costBasis: $("f_costBasis").value === "" ? null : num($("f_costBasis").value), longTerm: $("f_longTerm").checked } });
    if (currentKind === "mileage") Object.assign(e, { miles: num($("f_miles").value), parkingTolls: num($("f_parkingTolls").value), route: $("f_route").value.trim(), purpose: $("f_purpose").value.trim(), rate: RULES.MILEAGE_RATE });
    if (currentKind === "expense") Object.assign(e, { amount: num($("f_amount_expense").value), expenseCategory: $("f_expenseCategory").value, expenseDesc: $("f_expenseDesc").value.trim(), reimbursed: $("f_reimbursed").checked, awayOvernight: $("f_awayOvernight").checked, personalPleasure: $("f_personalPleasure").checked, companions: $("f_companions").checked, uniformNoGeneralUse: $("f_uniformNoGeneralUse").checked, delegate: $("f_delegate").checked });
    return e;
  }
  async function fillForm(e) {
    await resetForm(false);
    editingId = e.id; setKind(e.kind);
    $("f_date").value = e.date || ""; $("f_donor").value = e.donor || ""; $("f_org").value = e.org || ""; $("f_notes").value = e.notes || ""; $("f_ack").checked = !!e.ackReceived; $("f_hasReceipt").checked = !!e.hasReceiptDecl;
    originalReceiptIds = (e.receiptIds || []).slice(); pendingReceiptIds = originalReceiptIds.slice(); stagedRemovals = [];
    if (e.kind === "cash") { $("f_amount_cash").value = e.amount || ""; $("f_method").value = e.method || "card"; $("f_checkNo").value = e.checkNo || ""; $("f_benefit").value = e.benefit || ""; $("f_bankRecord").checked = e.bankRecord !== false; }
    if (e.kind === "noncash") { $("itemRows").innerHTML = ""; (e.items || []).forEach(addItemRow); if (!(e.items || []).length) addItemRow(); $("f_benefit").value = e.benefit || ""; $("f_howValued").value = e.howValued || window.FMV_METHODS[0]; $("f_acquired").value = e.acquired || ""; $("f_vehicle").checked = !!e.vehicle; $("f_appraised").checked = !!e.appraised; }
    if (e.kind === "stock") { $("f_amount_stock").value = e.amount || ""; $("f_ticker").value = (e.stock || {}).ticker || ""; $("f_costBasis").value = isBlank((e.stock || {}).costBasis) ? "" : e.stock.costBasis; $("f_longTerm").checked = (e.stock || {}).longTerm !== false; }
    if (e.kind === "mileage") { $("f_miles").value = e.miles || ""; $("f_parkingTolls").value = e.parkingTolls || ""; $("f_route").value = e.route || ""; $("f_purpose").value = e.purpose || ""; }
    if (e.kind === "expense") { $("f_amount_expense").value = e.amount || ""; $("f_expenseCategory").value = e.expenseCategory || "other"; $("f_expenseDesc").value = e.expenseDesc || ""; $("f_reimbursed").checked = !!e.reimbursed; $("f_awayOvernight").checked = !!e.awayOvernight; $("f_personalPleasure").checked = !!e.personalPleasure; $("f_companions").checked = !!e.companions; $("f_uniformNoGeneralUse").checked = !!e.uniformNoGeneralUse; $("f_delegate").checked = !!e.delegate; updateExpenseVisibility(); }
    $("formTitle").textContent = "Edit entry"; $("volFormTitle").textContent = "Edit entry"; $("cancelEdit").hidden = false; $("saveBtn").textContent = "Save changes";
    renderThumbs(); updateInsight();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // Clearing or cancelling: files uploaded during this form session (and not part of the saved entry)
  // are deleted; staged removals are forgotten so the saved entry keeps its attachments.
  async function resetForm(keepDate = true) {
    const d = $("f_date").value;
    const orphans = pendingReceiptIds.filter(id => !originalReceiptIds.includes(id));
    for (const id of orphans) await window.Store.deleteReceipt(id).catch(() => {});
    if (orphans.length) await refreshReceipts();
    form.reset(); editingId = null; pendingReceiptIds = []; originalReceiptIds = []; stagedRemovals = [];
    $("f_date").value = keepDate && d ? d : new Date().toISOString().slice(0, 10);
    $("f_bankRecord").checked = true; $("f_longTerm").checked = true;
    $("itemRows").innerHTML = ""; if (currentKind === "noncash") addItemRow();
    $("formTitle").textContent = "Record a gift"; $("volFormTitle").textContent = "Log a trip or expense"; $("cancelEdit").hidden = true; $("saveBtn").textContent = "Save to ledger"; $("saveHint").textContent = "";
    recalcItems(); renderThumbs(); updateExpenseVisibility(); updateInsight();
  }
  $("resetBtn").addEventListener("click", () => resetForm());
  $("cancelEdit").addEventListener("click", () => resetForm());
  form.addEventListener("input", updateInsight);
  form.addEventListener("change", updateInsight);

  function updateInsight() {
    const e = readForm(); const r = evaluate(e, { files: pendingReceiptIds.filter(id => receiptsCache.some(x => x.id === id)).length });
    const headline = r.status === "stop" ? "Not eligible as entered" : r.status === "docs" ? "Eligible — documentation needed before filing" : "Eligible, records complete";
    const flags = r.flags.length ? r.flags : [{ level: "info", text: currentKind === "mileage" ? `Log the miles and purpose. ${num(e.miles)} miles × 14¢ = ${money(num(e.miles) * RULES.MILEAGE_RATE)}.` : "Fill in the gift and the checker will list what records you need." }];
    $("insight").innerHTML = `<div class="eyebrow">Deduction check</div>
      <div class="verdict ${r.status}">${money(r.deductible)}</div>
      <p class="small" style="margin-bottom:10px">${headline}${r.gross !== r.deductible ? ` · recorded value ${money(r.gross)}` : ""}</p>
      <div class="flags">${flags.map(f => `<div class="flag ${f.level}"><span>${f.text}</span></div>`).join("")}</div>`;
  }

  // Receipts in the form
  async function handleFiles(files) {
    if (!files || !files.length) return;
    $("saveHint").textContent = "Processing files…";
    let stored = 0;
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB — skipped`); continue; }
      try { const rec = await window.Store.addReceipt(f, editingId); pendingReceiptIds.push(rec.id); stored++; }
      catch (e) { toast(`Couldn't store ${f.name} — receipt storage may be blocked in this browser.`, true); }
    }
    await refreshReceipts(); renderThumbs(); updateInsight(); $("saveHint").textContent = "";
    if (stored && !$("f_ack").checked) $("saveHint").textContent = "Tip: if one of these is the charity's acknowledgment letter, tick the box above.";
    if (stored && !editingId) $("saveHint").textContent += " Files are attached when you save.";
  }
  $("f_files").addEventListener("change", ev => { handleFiles([...ev.target.files]); ev.target.value = ""; });
  const dz = $("dropZone");
  dz.addEventListener("dragover", ev => { ev.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", ev => { ev.preventDefault(); dz.classList.remove("over"); handleFiles([...ev.dataTransfer.files]); });
  function renderThumbs() {
    const recs = pendingReceiptIds.map(id => receiptsCache.find(r => r.id === id) || { id, missing: true, name: "file missing", type: "" });
    $("thumbs").innerHTML = recs.map(r => `<div class="thumb" data-id="${esc(r.id)}">${r.missing ? `<span>File missing<br>(not restored)</span>` : r.type.startsWith("image/") ? `<img src="${urlFor(r)}" alt="">` : `<span>PDF<br>${esc(r.name.slice(0, 18))}</span>`}<button type="button" class="rm" title="Remove" aria-label="Remove receipt">×</button></div>`).join("");
    $("thumbs").querySelectorAll(".rm").forEach(b => b.addEventListener("click", async () => {
      const id = b.parentElement.dataset.id; pendingReceiptIds = pendingReceiptIds.filter(x => x !== id);
      if (originalReceiptIds.includes(id)) { stagedRemovals.push(id); $("saveHint").textContent = "Receipt will be removed when you save. Cancel to keep it."; }
      else { await window.Store.deleteReceipt(id).catch(() => {}); await refreshReceipts(); }
      renderThumbs(); updateInsight();
    }));
  }

  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const e = readForm();
    const problems = [];
    const y = Number((e.date || "").slice(0, 4));
    if (!e.date || isNaN(Date.parse(e.date))) problems.push("a valid date");
    else if (y < 2000 || y > Number(thisYear) + 1) problems.push("a date between 2000 and next year");
    if (["cash", "noncash", "stock"].includes(e.kind) && !e.org) problems.push("the organization");
    if (e.kind === "cash" && !(e.amount > 0)) problems.push("an amount greater than zero");
    if (e.kind === "noncash" && !(e.items.length && window.Rules.itemsTotal(e) > 0)) problems.push("at least one item with a value");
    if (e.kind === "noncash" && e.items.some(i => !i.desc)) problems.push("a description for every item");
    if (e.kind === "stock" && !(e.amount > 0)) problems.push("the market value");
    if (e.kind === "mileage" && !(e.miles > 0 || e.parkingTolls > 0)) problems.push("miles or parking/tolls");
    if (e.kind === "expense" && !(e.amount > 0)) problems.push("an amount greater than zero");
    if (num(e.benefit) > window.Rules.grossValue(e) && ["cash", "noncash"].includes(e.kind)) problems.push("a value received that isn't more than the gift itself");
    if (problems.length) { $("saveHint").textContent = "Please add " + problems.join(", ") + "."; return; }

    const idx = state.entries.findIndex(x => x.id === e.id);
    const now = new Date().toISOString();
    e.updatedAt = now; e.createdAt = idx >= 0 ? state.entries[idx].createdAt : now;
    const previous = idx >= 0 ? state.entries[idx] : null;
    if (idx >= 0) state.entries[idx] = e; else state.entries.push(e);
    if (!persist()) { if (previous) state.entries[idx] = previous; else state.entries.pop(); $("saveHint").textContent = "Not saved. Your entry is still in the form — export a backup or free up storage, then try again."; return; }
    // Saved. Now finalize receipts: attach current ones, delete staged removals.
    await window.Store.attachReceipts(e.receiptIds, e.id).catch(() => toast("Saved, but receipt links couldn't be updated.", true));
    for (const id of stagedRemovals) await window.Store.deleteReceipt(id).catch(() => {});
    originalReceiptIds = pendingReceiptIds.slice(); stagedRemovals = [];
    await refreshReceipts();
    if (yearOf(e) !== year && year !== "all") year = yearOf(e);
    persist(); const k = e.kind; await resetForm(); setKind(k); renderAll();
    const r = ev2(e);
    toast(idx >= 0 ? "Entry updated" : r.status === "stop" ? "Saved — not eligible as entered (see status)" : r.status === "docs" ? "Saved — documentation still needed" : "Saved to the ledger");
  });
  const ev2 = e => ev(e);

  /* ---------- tables ---------- */
  function entryRow(e) {
    const r = ev(e); const recs = receiptsFor(e); const lost = (e.receiptIds || []).length - recs.length;
    return `<tr class="entry" data-id="${esc(e.id)}">
      <td class="num" style="white-space:nowrap">${fmtDate(e.date)}</td>
      <td><div class="org">${esc(e.org || (e.kind === "mileage" || e.kind === "expense" ? "(volunteering)" : "—"))}</div><div class="sub">${esc(describe(e))}${e.notes && e.kind !== "noncash" ? " · " + esc(e.notes) : ""}</div></td>
      <td>${esc(e.donor || "—")}</td>
      <td><span class="pill k-${e.kind}">${KINDS[e.kind].short}</span></td>
      <td>${e.conflictOf ? `<span class="badge conflict">Import conflict</span> <span class="small muted">not counted</span> ` : ""}${statusBadge(r)}${recs.length ? ` <span class="small muted">📎${recs.length}</span>` : ""}${lost > 0 ? ` <span class="badge warn" title="Receipt file not found in this browser">${lost} file${lost > 1 ? "s" : ""} missing</span>` : ""}</td>
      <td class="r num"><b>${money(r.deductible)}</b>${r.gross !== r.deductible ? `<div class="sub">recorded ${money(r.gross)}</div>` : ""}</td>
      <td><div class="row-actions">${e.conflictOf ? `<button class="btn sm" data-act="keep" type="button" title="Keep this imported copy and delete your version">Keep this</button><button class="btn sm" data-act="discard" type="button" title="Delete this imported copy, keep your version">Keep mine</button>` : ""}<button class="btn sm" data-act="edit" type="button">Edit</button><button class="btn sm danger" data-act="del" type="button">Delete</button></div></td>
    </tr>`;
  }
  function renderTable(container, entries, emptyHtml) {
    if (!entries.length) { container.innerHTML = `<div class="empty">${emptyHtml}</div>`; return; }
    const sorted = [...entries].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    container.innerHTML = `<table><thead><tr><th>Date</th><th>Organization</th><th>Donor</th><th>Type</th><th>Status</th><th class="r">Deductible</th><th></th></tr></thead><tbody>${sorted.map(entryRow).join("")}</tbody></table>`;
    container.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => {
      const id = b.closest("tr").dataset.id; const e = state.entries.find(x => x.id === id); if (!e) return;
      if (b.dataset.act === "edit") { showView(["mileage", "expense"].includes(e.kind) ? "volunteer" : "ledger"); fillForm(e); }
      else if (b.dataset.act === "keep" || b.dataset.act === "discard") resolveConflict(e, b.dataset.act === "keep");
      else if (b.dataset.confirm) deleteEntry(e);
      else { b.dataset.confirm = "1"; b.textContent = "Confirm delete"; setTimeout(() => { delete b.dataset.confirm; b.textContent = "Delete"; }, 3500); }
    }));
  }
  // keepImported: true → the imported copy replaces the local version; false → the imported copy is discarded.
  async function resolveConflict(copy, keepImported) {
    const before = state.entries;
    const other = state.entries.find(x => x.id === copy.conflictOf);
    const loser = keepImported ? other : copy;
    state.entries = state.entries.filter(x => x !== loser).map(x => { if (x === copy && keepImported) { const k = Object.assign({}, x); delete k.conflictOf; if (other) k.id = other.id; return k; } return x; });
    if (!keepImported) { /* nothing else to change */ }
    if (!persist()) { state.entries = before; return; }
    if (loser) for (const id of loser.receiptIds || []) { if (!(keepImported ? copy : other || {}).receiptIds?.includes(id)) await window.Store.deleteReceipt(id).catch(() => {}); }
    await refreshReceipts(); renderAll(); toast(keepImported ? "Imported version kept" : "Your version kept");
  }
  async function deleteEntry(e) {
    const before = state.entries;
    state.entries = state.entries.filter(x => x.id !== e.id);
    if (!persist()) { state.entries = before; return; }
    for (const id of e.receiptIds || []) await window.Store.deleteReceipt(id).catch(() => {});
    await refreshReceipts(); if (editingId === e.id) await resetForm(); renderAll(); toast("Entry deleted");
  }

  function renderLedger() {
    const vis = visibleEntries();
    const s = summarize(vis);
    const cnt = vis.filter(isCountable);
    const attention = cnt.filter(e => ev(e).status !== "ok").length;
    $("ledgerStats").innerHTML = `
      <div class="stat hero"><div class="label">Deductible total · ${yearLabel()}</div><div class="value">${money(s.deductible)}</div><div class="sub">${cnt.length} entr${cnt.length === 1 ? "y" : "ies"}${s.conflicts ? ` · ${s.conflicts} conflict${s.conflicts > 1 ? "s" : ""} not counted` : ""} · recorded ${money(s.gross)}${s.needsDocs ? ` · ${money(s.needsDocs)} needs documentation` : ""}${s.notEligible ? ` · ${money(s.notEligible)} not eligible` : ""}</div></div>
      <div class="stat"><div class="label">Cash gifts</div><div class="value">${money(s.cash)}</div><div class="sub">Schedule A line 11</div></div>
      <div class="stat"><div class="label">Goods &amp; stock</div><div class="value">${money(s.noncash)}</div><div class="sub">${s.noncash > RULES.FORM_8283_THRESHOLD ? "Form 8283 required" : "Schedule A line 12"}</div></div>
      <div class="stat"><div class="label">Volunteer costs</div><div class="value">${money(s.volunteer)}</div><div class="sub">Mileage + expenses</div></div>
      <div class="stat ${attention ? "attention" : ""}"><div class="label">Need attention</div><div class="value">${attention}</div><div class="sub">${s.needsAck ? s.needsAck + " missing acknowledgment" : attention ? "See status column" : "All records complete"}</div></div>`;
    const conflicts = state.entries.filter(e => e.conflictOf);
    $("conflictBanner").hidden = !conflicts.length;
    if (conflicts.length) $("conflictBanner").innerHTML = `<b>${conflicts.length} imported entr${conflicts.length === 1 ? "y differs" : "ies differ"} from your version.</b><span>Both copies were kept. The imported copy (marked “Import conflict”) is not counted in totals, forms or exports until you choose Keep this or Keep mine.</span>`;
    const order = ["cash", "noncash", "stock", "mileage", "expense"];
    const total = order.reduce((t, k) => t + s.byKind[k], 0);
    $("breakdown").innerHTML = total ? `<div class="eyebrow">Where the deduction comes from</div>
      <div class="bar" role="img" aria-label="Deduction breakdown by gift type">${order.filter(k => s.byKind[k] > 0).map(k => `<span class="c${KINDS[k].color}" style="flex:${s.byKind[k]}" title="${KINDS[k].label}: ${money(s.byKind[k])}"></span>`).join("")}</div>
      <div class="legend">${order.filter(k => s.byKind[k] > 0).map(k => `<span class="key"><span class="swatch c${KINDS[k].color}"></span>${KINDS[k].label} <b class="num">${money(s.byKind[k])}</b> <span class="muted">${Math.round(s.byKind[k] / total * 100)}%</span></span>`).join("")}</div>`
      : `<div class="eyebrow">Where the deduction comes from</div><p class="small muted">Once you log gifts, this shows how cash, goods, stock and volunteer costs add up.</p>`;
    const q = $("searchBox").value.trim().toLowerCase(); const kf = $("kindFilter").value; const df = $("donorFilter").value;
    const donors = [...new Set(state.entries.map(e => e.donor).filter(Boolean))].sort();
    const orgs = [...new Set(state.entries.map(e => e.org).filter(Boolean))].sort();
    $("donorList").innerHTML = donors.map(d => `<option value="${esc(d)}">`).join(""); $("orgList").innerHTML = orgs.map(o => `<option value="${esc(o)}">`).join("");
    if ($("kindFilter").options.length === 1) $("kindFilter").innerHTML += order.map(k => `<option value="${k}">${KINDS[k].label}</option>`).join("");
    const prevD = $("donorFilter").value; $("donorFilter").innerHTML = `<option value="">All donors</option>` + donors.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join(""); $("donorFilter").value = prevD;
    const rows = vis.filter(e => (!kf || e.kind === kf) && (!df || e.donor === df) && (!q || [e.org, e.donor, e.notes, describe(e)].join(" ").toLowerCase().includes(q)));
    renderTable($("ledgerTable"), rows, vis.length ? `<h3>No entries match those filters.</h3>` : `<h3>No gifts logged for ${yearLabel()} yet.</h3><p>Record your first gift above, or <button class="btn sm" type="button" id="loadSamplesInline">load sample entries</button> to see how the ledger works.</p>`);
    const ls = $("loadSamplesInline"); if (ls) ls.addEventListener("click", loadSamples);
    $("countLedger").textContent = vis.length;
  }
  ["searchBox", "kindFilter", "donorFilter"].forEach(id => $(id).addEventListener("input", renderLedger));

  function renderVolunteer() {
    const vis = visibleEntries().filter(e => e.kind === "mileage" || e.kind === "expense");
    const miles = vis.filter(isCountable).reduce((t, e) => t + (e.kind === "mileage" ? num(e.miles) : 0), 0);
    const s = summarize(vis);
    const notDed = vis.filter(e => isCountable(e) && ev(e).status === "stop").length;
    $("volunteerStats").innerHTML = `
      <div class="stat hero"><div class="label">Volunteer deduction · ${yearLabel()}</div><div class="value">${money(s.byKind.mileage + s.byKind.expense)}</div><div class="sub">Goes on Schedule A with cash gifts</div></div>
      <div class="stat"><div class="label">Miles driven</div><div class="value num">${miles.toLocaleString()}</div><div class="sub">× 14¢ = ${money(miles * RULES.MILEAGE_RATE)}</div></div>
      <div class="stat"><div class="label">Out-of-pocket expenses</div><div class="value">${money(s.byKind.expense)}</div><div class="sub">${vis.filter(e => e.kind === "expense").length} items</div></div>
      <div class="stat ${notDed ? "attention" : ""}"><div class="label">Logged but not eligible</div><div class="value">${notDed}</div><div class="sub">${notDed ? "Kept for your records" : "Everything counts"}</div></div>`;
    renderTable($("volunteerTable"), vis, `<h3>No trips or expenses for ${yearLabel()}.</h3><p>Log a delivery route, a supply run, or a conference trip above.</p>`);
    $("countVolunteer").textContent = vis.length;
  }

  /* ---------- value guide ---------- */
  $("guideCat").innerHTML += window.FMV_GUIDE.map(g => `<option>${esc(g.cat)}</option>`).join("");
  function renderGuide() {
    const q = $("guideSearch").value.trim().toLowerCase(); const c = $("guideCat").value;
    const rows = [];
    window.FMV_GUIDE.forEach((g, gi) => { if (c && g.cat !== c) return; g.items.forEach(([name, lo, hi], ii) => { if (!q || (name + " " + g.cat).toLowerCase().includes(q)) rows.push({ name, cat: g.cat, lo, hi, key: gi + ":" + ii }); }); });
    $("guideRows").innerHTML = rows.length ? rows.map(r => `<tr><td>${esc(r.name)}</td><td class="muted small">${esc(r.cat)}</td><td class="r num range">${money(r.lo)}</td><td class="r num range">${money(r.hi)}</td><td class="r"><button class="btn sm" type="button" data-use="${r.key}">Use</button></td></tr>`).join("") : `<tr><td colspan="5" class="empty">Nothing matches. Try a broader word, or value the item from comparable online listings.</td></tr>`;
    $("guideRows").querySelectorAll("[data-use]").forEach(b => b.addEventListener("click", async () => {
      const [gi, ii] = b.dataset.use.split(":").map(Number); const g = window.FMV_GUIDE[gi]; const [name, lo, hi] = g.items[ii];
      showView("ledger"); if (editingId && currentKind !== "noncash") await resetForm(); setKind("noncash");
      const rows = [...$("itemRows").querySelectorAll(".item-row")]; const last = rows[rows.length - 1];
      const blank = last && !last.querySelector(".desc").value && !num(last.querySelector(".unit").value);
      if (blank) last.remove();
      addItemRow({ desc: name, category: g.cat, condition: "good", qty: 1, unitValue: valueForCondition("good", lo, hi).toFixed(2), lo, hi });
      recalcItems(); updateInsight(); $("f_howValued").value = window.FMV_METHODS[0];
      form.scrollIntoView({ behavior: "smooth", block: "start" }); toast(`Added “${name}” at the good-condition value — change the condition to adjust`);
    }));
  }
  $("guideSearch").addEventListener("input", renderGuide); $("guideCat").addEventListener("change", renderGuide);

  /* ---------- receipts view ---------- */
  function renderReceipts() {
    const vis = visibleEntries();
    const missing = vis.filter(e => isCountable(e) && !receiptsFor(e).length && ev(e).deductible > 0 && e.kind !== "mileage" && !(e.kind === "cash" && e.bankRecord && ev(e).gross < RULES.ACK_THRESHOLD));
    $("missingReceipts").innerHTML = missing.length ? `<div class="card-head"><div><h3>${missing.length} entr${missing.length === 1 ? "y" : "ies"} without a receipt</h3><p>Attach a photo of the receipt or the charity's letter so the record is complete.</p></div></div>
      <div class="flags">${missing.map(e => `<div class="flag warn"><span><b>${fmtDate(e.date)}</b> · ${esc(e.org || describe(e))} · ${money(ev(e).deductible)}</span><button class="btn sm" type="button" data-edit="${esc(e.id)}" style="margin-left:auto">Attach</button></div>`).join("")}</div>`
      : `<div class="flag ok"><span>Every deductible entry for ${yearLabel()} has a receipt, bank record or acknowledgment.</span></div>`;
    $("missingReceipts").querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => { const e = state.entries.find(x => x.id === b.dataset.edit); showView(["mileage", "expense"].includes(e.kind) ? "volunteer" : "ledger"); fillForm(e); }));
    const total = receiptsCache.reduce((t, r) => t + (r.size || 0), 0);
    $("receiptStorage").textContent = receiptsCache.length ? `${receiptsCache.length} file${receiptsCache.length === 1 ? "" : "s"}, ${(total / 1024 / 1024).toFixed(1)} MB stored in this browser.` : "No files yet.";
    const list = [...receiptsCache].sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
    $("receiptGrid").innerHTML = list.length ? list.map(r => { const e = state.entries.find(x => (x.receiptIds || []).includes(r.id)); return `<div class="receipt-card" data-id="${esc(r.id)}">
        <div class="img" data-open="${esc(r.id)}">${r.type.startsWith("image/") ? `<img src="${urlFor(r)}" alt="${esc(r.name)}">` : `<span class="small">PDF · ${esc(r.name.slice(0, 22))}</span>`}</div>
        <div class="meta">${e ? `<b>${esc(e.org || describe(e))}</b><span class="muted">${fmtDate(e.date)} · ${money(ev(e).deductible)}</span>` : `<b class="muted">Not linked to an entry</b><button class="btn sm link" type="button" data-link="${esc(r.id)}">Link to entry</button>`}
        <div class="row-actions" style="justify-content:flex-start;margin-top:6px"><a class="btn sm" href="${urlFor(r)}" target="_blank" rel="noopener">Open</a><button class="btn sm danger" type="button" data-rm="${esc(r.id)}">Delete</button></div></div></div>`; }).join("")
      : `<div class="empty"><h3>No receipts stored.</h3><p>Attach files from the entry form, or add them here.</p></div>`;
    $("receiptGrid").querySelectorAll("[data-open]").forEach(el => el.addEventListener("click", () => { const r = receiptsCache.find(x => x.id === el.dataset.open); if (!r) return; if (r.type.startsWith("image/")) modal(`<img src="${urlFor(r)}" alt="${esc(r.name)}"><div class="actions"><button class="btn" data-close type="button">Close</button></div>`, { wide: true }); else window.open(urlFor(r), "_blank"); }));
    $("receiptGrid").querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", async () => {
      if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Confirm"; setTimeout(() => { delete b.dataset.confirm; b.textContent = "Delete"; }, 3500); return; }
      const id = b.dataset.rm;
      const before = JSON.stringify(state.entries);
      state.entries.forEach(e => { if (e.receiptIds) e.receiptIds = e.receiptIds.filter(x => x !== id); });
      if (!persist()) { state.entries = JSON.parse(before); return; }
      await window.Store.deleteReceipt(id).catch(() => {});
      await refreshReceipts(); renderAll(); toast("Receipt deleted");
    }));
    $("receiptGrid").querySelectorAll("[data-link]").forEach(b => b.addEventListener("click", () => linkReceipt(b.dataset.link)));
    $("countReceipts").textContent = receiptsCache.length;
  }
  function linkReceipt(id) {
    const opts = [...state.entries].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map(e => `<option value="${esc(e.id)}">${fmtDate(e.date)} · ${esc(e.org || describe(e))} · ${money(ev(e).deductible)}</option>`).join("");
    const close = modal(`<h3>Link receipt to an entry</h3><p class="small">Pick the gift this file belongs to.</p><div class="field w12" style="margin-top:10px"><select id="linkSel">${opts || "<option value=''>No entries yet</option>"}</select></div><div class="actions"><button class="btn primary" id="linkGo" type="button">Link</button><button class="btn" data-close type="button">Cancel</button></div>`);
    $("linkGo").addEventListener("click", async () => { const e = state.entries.find(x => x.id === $("linkSel").value); if (!e) return; const before = (e.receiptIds || []).slice(); e.receiptIds = [...before, id]; if (!persist()) { e.receiptIds = before; return; } await window.Store.attachReceipts([id], e.id).catch(() => {}); await refreshReceipts(); close(); renderAll(); toast("Receipt linked"); });
  }
  $("looseReceipts").addEventListener("change", async ev => {
    const files = [...ev.target.files]; ev.target.value = ""; if (!files.length) return;
    let n = 0; for (const f of files) { try { await window.Store.addReceipt(f, null); n++; } catch (e) { toast(`Couldn't store ${f.name}`, true); } }
    await refreshReceipts(); renderAll(); if (n) toast(`${n} file${n > 1 ? "s" : ""} added — link each to an entry`);
  });

  /* ---------- summary ---------- */
  function renderSummary() {
    const vis = visibleEntries(); const s = summarize(vis);
    $("summaryTitle").textContent = `Tax summary · ${yearLabel()}`;
    $("summaryStats").innerHTML = `
      <div class="stat hero"><div class="label">Total charitable deduction</div><div class="value">${money(s.deductible)}</div><div class="sub">Before AGI limits and the 0.5% floor${s.needsDocs ? ` · includes ${money(s.needsDocs)} still needing documentation` : ""}${s.notEligible ? ` · ${money(s.notEligible)} recorded but not eligible` : ""}</div></div>
      <div class="stat"><div class="label">Cash + volunteer costs</div><div class="value">${money(s.cash + s.volunteer)}</div><div class="sub">Schedule A, line 11</div></div>
      <div class="stat"><div class="label">Goods + stock</div><div class="value">${money(s.noncash)}</div><div class="sub">Schedule A, line 12</div></div>
      <div class="stat ${s.needsAck || s.missingReceipts ? "attention" : ""}"><div class="label">Open items</div><div class="value">${s.needsAck + s.missingReceipts}</div><div class="sub">${s.needsAck} acknowledgments · ${s.missingReceipts} receipts</div></div>`;
    const kv = (obj) => { const keys = Object.keys(obj).sort((a, b) => obj[b] - obj[a]); return keys.length ? `<dl class="kv">${keys.map(k => `<dt>${esc(k)}</dt><dd class="num">${money(obj[k])}</dd>`).join("")}</dl>` : `<p class="small muted">Nothing logged yet.</p>`; };
    const order = ["cash", "noncash", "stock", "mileage", "expense"];
    const checklistCard = (title, sum) => `<div class="card"><h3>${title}</h3><div class="checklist" style="margin-top:10px">${sum.checklist.map(c => `<div class="item"><span class="mk ${c.state}">${c.state === "need" ? "!" : c.state === "done" ? "✓" : "–"}</span><span>${c.text}</span></div>`).join("")}</div></div>`;
    // Filing checks are per tax year: with "All years" selected, run one checklist per year.
    const years = year === "all" ? [...new Set(vis.map(yearOf).filter(Boolean))].sort().reverse() : [year];
    const checklists = year === "all" ? years.map(y => checklistCard(`Filing checklist · ${y}`, summarize(vis.filter(e => yearOf(e) === y)))).join("") : checklistCard("Filing checklist", s);
    $("summaryGrid").innerHTML = `
      <div class="card"><h3>By type</h3><dl class="kv" style="margin-top:10px">${order.map(k => `<dt><span class="dot c${KINDS[k].color}"></span>${KINDS[k].label}</dt><dd class="num">${money(s.byKind[k])}</dd>`).join("")}<dt class="total">Total</dt><dd class="total num">${money(s.deductible)}</dd></dl></div>
      ${checklists}
      <div class="card"><h3>By donor</h3><div style="margin-top:10px">${kv(s.byDonor)}</div><p class="small muted" style="margin-top:8px">Married filing jointly combines everyone; separate returns split by donor.</p></div>
      <div class="card"><h3>By organization</h3><div style="margin-top:10px">${kv(s.byOrg)}</div></div>`;
    renderSupport();
  }
  const csvCell = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  function csvFor(entries) {
    const cols = ["Date", "Tax year", "Donor", "Organization", "Type", "Description", "Recorded value", "Value received in return", "Deductible", "Status", "Payment method", "Check/confirmation", "Miles", "Parking & tolls", "Cost basis", "Held > 1 year", "Written acknowledgment", "Bank record", "Receipt files", "How valued", "Acquired / cost", "Expense category", "Notes"];
    const lines = [cols.join(",")];
    [...entries].sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach(e => {
      const r = ev(e); const st = e.stock || {};
      const status = r.status === "stop" ? "Not eligible" : r.status === "docs" ? "Documentation needed" : "OK";
      const row = [e.date, yearOf(e), e.donor, e.org, KINDS[e.kind].label, describe(e), r.gross.toFixed(2), num(e.benefit).toFixed(2), r.deductible.toFixed(2), status, e.method || "", e.checkNo || "", e.miles || "", e.parkingTolls || "", e.kind === "stock" && !isBlank(st.costBasis) ? num(st.costBasis).toFixed(2) : "", e.kind === "stock" ? (st.longTerm ? "Yes" : "No") : "", e.ackReceived ? "Yes" : "No", e.kind === "cash" ? (e.bankRecord ? "Yes" : "No") : "", receiptsFor(e).length, e.howValued || "", e.acquired || "", e.kind === "expense" ? (EXP[e.expenseCategory] || EXP.other).label : "", e.notes];
      lines.push(row.map(csvCell).join(","));
    });
    return lines.join("\n");
  }
  // One row per donated item — the inventory Form 8283 and a preparer want.
  function itemsCsvFor(entries) {
    const cols = ["Date", "Tax year", "Donor", "Organization", "Item", "Category", "Condition", "Qty", "Value each", "Line total", "Guide low", "Guide high", "How valued", "Acquired / cost", "Acknowledgment", "Receipt files", "Entry notes"];
    const lines = [cols.join(",")];
    [...entries].filter(e => e.kind === "noncash").sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach(e => (e.items || []).forEach(it => {
      lines.push([e.date, yearOf(e), e.donor, e.org, it.desc, it.category, it.condition, it.qty, num(it.unitValue).toFixed(2), window.Rules.itemValue(it).toFixed(2), isBlank(it.lo) ? "" : it.lo, isBlank(it.hi) ? "" : it.hi, e.howValued || "", e.acquired || "", e.ackReceived ? "Yes" : "No", receiptsFor(e).length, e.notes].map(csvCell).join(","));
    }));
    return lines.join("\n");
  }
  function summaryText() {
    const vis = countableEntries(); const s = summarize(visibleEntries());
    const order = ["cash", "noncash", "stock", "mileage", "expense"];
    const years = year === "all" ? [...new Set(vis.map(yearOf).filter(Boolean))].sort().reverse() : [year];
    const checks = years.flatMap(y => { const sy = year === "all" ? summarize(vis.filter(e => yearOf(e) === y)) : s; return [`Filing checklist ${y}:`, ...sy.checklist.map(c => `  [${c.state === "need" ? "!" : c.state === "done" ? "x" : "-"}] ${c.text}`), ""]; });
    return [`GIVING LEDGER — TAX SUMMARY ${year === "all" ? "(all years)" : year}`, "",
      `Total charitable deduction: ${money(s.deductible)}`, ...order.map(k => `  ${KINDS[k].label}: ${money(s.byKind[k])}`), s.needsDocs ? `  Of which still needing documentation: ${money(s.needsDocs)}` : "", s.notEligible ? `  Recorded but not eligible: ${money(s.notEligible)}` : "", "",
      "By donor:", ...Object.entries(s.byDonor).map(([k, v]) => `  ${k}: ${money(v)}`), "",
      "By organization:", ...Object.entries(s.byOrg).map(([k, v]) => `  ${k}: ${money(v)}`), "",
      ...checks,
      "Entries:", ...[...vis].sort((a, b) => (a.date || "").localeCompare(b.date || "")).map(e => `  ${e.date}  ${money(ev(e).deductible).padStart(12)}  ${KINDS[e.kind].short.padEnd(8)} ${e.org || ""} — ${describe(e)}`),
      conflictNote() ? "" : "", conflictNote() ? "NOTE:" + conflictNote() + " Resolve them in the ledger before filing." : ""
    ].join("\n");
  }
  const exportCsv = () => { const vis = countableEntries(); if (!vis.length) return toast("Nothing to export for this year"); download(`giving-ledger-${year}.csv`, csvFor(vis), "text/csv"); toast("CSV download started (if nothing happened, use Copy CSV)." + conflictNote(), !!conflictNote()); };
  $("csvBtn").addEventListener("click", exportCsv); $("summaryCsv").addEventListener("click", exportCsv);
  $("itemsCsv").addEventListener("click", async () => { const vis = countableEntries().filter(e => e.kind === "noncash"); if (!vis.length) return toast("No goods donations for this year"); download(`giving-ledger-items-${year}.csv`, itemsCsvFor(vis), "text/csv"); toast("Itemized goods CSV download started"); });
  $("copyCsvBtn").addEventListener("click", async () => { const vis = countableEntries(); if (!vis.length) return toast("Nothing to copy"); toast((await copyText(csvFor(vis))) ? "CSV copied — paste into a spreadsheet." + conflictNote() : "Copy blocked by the browser", !!conflictNote()); });
  $("summaryCopy").addEventListener("click", async () => toast((await copyText(summaryText())) ? "Summary copied" : "Copy blocked by the browser"));
  $("summaryPrint").addEventListener("click", () => { try { window.print(); } catch (e) {} toast("If no print dialog opened, use Copy summary instead"); });

  /* ---------- support (optional donation) ---------- */
  const SUPPORT = CFG.support || {};
  function renderSupport() {
    const card = $("supportCard"); const foot = $("supportFooter");
    if (!SUPPORT.enabled || !(SUPPORT.links || []).length) { card.hidden = true; foot.hidden = true; return; }
    const links = SUPPORT.links.map(l => `<a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("");
    foot.hidden = false; foot.innerHTML = `<b>${esc(SUPPORT.heading || "Support this site")}</b> ${esc(SUPPORT.footer || "Free to use. If it helped, a small tip keeps it running.")} <span class="support-links">${links}</span>`;
    let dismissed = false; try { dismissed = localStorage.getItem("gl_support_dismissed") === "1"; } catch (e) {}
    card.hidden = dismissed;
    card.innerHTML = `<div><h4>${esc(SUPPORT.heading || "Support this site")}</h4><span>${esc(SUPPORT.message || "Giving Ledger is free and stores nothing on a server. If it saved you time at tax season, a tip of any size keeps it online — entirely optional.")}</span></div><div class="support-links">${links}<button class="btn sm link" type="button" id="supportDismiss">Not now</button></div>`;
    const d = $("supportDismiss"); if (d) d.addEventListener("click", () => { try { localStorage.setItem("gl_support_dismissed", "1"); } catch (e) {} card.hidden = true; });
  }

  /* ---------- backup & data ---------- */
  $("backupBtn").addEventListener("click", () => {
    const n = state.entries.length;
    const close = modal(`<h3>Backup &amp; data</h3>
      <p class="small">Everything lives in this browser. Save a backup file to move to another device, share with a spouse, or protect against a cleared browser.</p>
      <div class="actions"><button class="btn primary" id="bkDownload" type="button">Download backup (.json)</button><button class="btn" id="bkCopy" type="button">Copy backup text</button></div>
      <p class="small muted" style="margin-top:6px">${n} entr${n === 1 ? "y" : "ies"}, ${receiptsCache.length} receipt file${receiptsCache.length === 1 ? "" : "s"}. Receipts are included in the file.</p>
      <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <h3>Restore</h3>
      <p class="small" style="margin:6px 0 0">Merge keeps your data and adds the file's entries; when both have the same entry, the more recently edited one wins. Replace wipes this browser first and only proceeds if every receipt in the file can be read.</p>
      <div class="actions" style="margin-top:8px"><label class="btn">Merge from file <input type="file" id="bkImport" accept="application/json,.json" hidden></label><label class="btn danger">Replace everything from file <input type="file" id="bkReplace" accept="application/json,.json" hidden></label></div>
      <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <div class="actions" style="margin-top:0"><button class="btn" id="bkSamples" type="button">Load sample entries</button><button class="btn danger" id="bkClear" type="button">Delete all data</button><button class="btn" data-close type="button" style="margin-left:auto">Close</button></div>`);
    const makeBackup = async () => { try { return await window.Store.exportBackup(state); } catch (e) { toast(e.message || "Backup failed", true); return null; } };
    $("bkDownload").addEventListener("click", async () => { const b = await makeBackup(); if (!b) return; download(`giving-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(b), "application/json"); toast(`Backup started: ${b.counts.entries} entries, ${b.counts.receipts} receipts${b.counts.missingReceiptFiles ? ` (${b.counts.missingReceiptFiles} referenced files were not found)` : ""}`, true); });
    $("bkCopy").addEventListener("click", async () => { const b = await makeBackup(); if (!b) return; toast((await copyText(JSON.stringify(b))) ? `Backup copied: ${b.counts.entries} entries, ${b.counts.receipts} receipts` : "Copy blocked by the browser", true); });
    const doImport = mode => async ev => {
      const f = ev.target.files[0]; if (!f) return;
      try {
        const json = JSON.parse(await f.text());
        const commit = newState => { const prev = state; state = newState; if (!persist()) { state = prev; return false; } return true; };
        const res = await window.Store.importBackup(json, state, mode, commit);
        await refreshReceipts(); close(); renderYearPicker(); renderAll();
        const parts = mode === "replace" ? [`${res.added} entries and ${res.receiptsAdded} receipts restored`] : [`${res.added} added`, `${res.skipped} unchanged`, `${res.conflicts} conflict${res.conflicts === 1 ? "" : "s"} kept for review`, `${res.receiptsAdded} receipts added`];
        if (res.staleRemoveFailed) parts.push(`${res.staleRemoveFailed} old receipt files could not be removed`);
        if (res.rejected) parts.push(`${res.rejected} malformed entries skipped`);
        if (res.receiptsFailed.length) parts.push(`${res.receiptsFailed.length} receipts unreadable`);
        toast(parts.join(", "), true);
      } catch (e) { toast(e.message || "Couldn't read that file", true); }
      finally { ev.target.value = ""; }
    };
    $("bkImport").addEventListener("change", doImport("merge")); $("bkReplace").addEventListener("change", doImport("replace"));
    $("bkSamples").addEventListener("click", () => { close(); loadSamples(); });
    $("bkClear").addEventListener("click", async () => {
      const b = $("bkClear"); if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Really delete everything?"; setTimeout(() => { delete b.dataset.confirm; b.textContent = "Delete all data"; }, 4000); return; }
      const before = state; state = { entries: [], settings: {} };
      if (!persist()) { state = before; return; }
      await window.Store.clearReceipts().catch(() => {}); await refreshReceipts(); close(); await resetForm(); renderYearPicker(); renderAll(); toast("All data deleted");
    });
  });

  /* ---------- samples ---------- */
  function loadSamples() {
    const y = year === "all" ? thisYear : year;
    const now = new Date().toISOString();
    const mk = (o) => window.Store.sanitizeEntry(Object.assign({ id: window.Store.uid(), sample: true, createdAt: now, updatedAt: now, receiptIds: [] }, o));
    const samples = [
      mk({ kind: "cash", date: `${y}-01-14`, donor: "Sample · Joint", org: "Greater Lakes Food Bank", amount: 500, method: "card", benefit: 0, bankRecord: true, ackReceived: true, notes: "Annual gift, thank-you letter on file" }),
      mk({ kind: "cash", date: `${y}-03-22`, donor: "Sample · Maria", org: "St. Brigid Parish", amount: 40, method: "check", checkNo: "1187", benefit: 0, bankRecord: true, ackReceived: false }),
      mk({ kind: "cash", date: `${y}-05-09`, donor: "Sample · Joint", org: "Riverside Arts Center", amount: 300, method: "online", benefit: 120, bankRecord: true, ackReceived: false, notes: "Spring gala — two dinner tickets valued at $60 each" }),
      mk({ kind: "cash", date: `${y}-06-15`, donor: "Sample · David", org: "Community Chest street collection", amount: 100, method: "cash", benefit: 0, bankRecord: false, ackReceived: false, notes: "Cash in a collection bucket, no receipt" }),
      mk({ kind: "noncash", date: `${y}-04-18`, donor: "Sample · David", org: "Goodwill Industries", items: [{ desc: "Men's suits", category: "Men's clothing", condition: "good", qty: 2, unitValue: 35 }, { desc: "Women's coats", category: "Women's clothing", condition: "excellent", qty: 2, unitValue: 30 }, { desc: "Hardcover books", category: "Books, media & toys", condition: "good", qty: 20, unitValue: 2 }], benefit: 0, howValued: window.FMV_METHODS[0], ackReceived: true, hasReceiptDecl: true, notes: "Drop-off receipt on file" }),
      mk({ kind: "stock", date: `${y}-06-03`, donor: "Sample · Joint", org: "Lakeshore Land Trust", amount: 4200, stock: { ticker: "20 sh VTI", costBasis: 1900, longTerm: true }, ackReceived: true }),
      mk({ kind: "mileage", date: `${y}-02-07`, donor: "Sample · Maria", org: "Meals on Wheels", miles: 38, parkingTolls: 0, purpose: "Saturday delivery route", route: "Home → kitchen → 12 stops → home", ackReceived: false }),
      mk({ kind: "mileage", date: `${y}-02-14`, donor: "Sample · Maria", org: "Meals on Wheels", miles: 41, parkingTolls: 4, purpose: "Saturday delivery route", route: "Home → kitchen → 13 stops → home", ackReceived: false, hasReceiptDecl: true }),
      mk({ kind: "expense", date: `${y}-07-19`, donor: "Sample · David", org: "Habitat for Humanity", amount: 486.4, expenseCategory: "transport", expenseDesc: "Flight to week-long build in Tulsa", awayOvernight: true, personalPleasure: false, reimbursed: false, ackReceived: true, hasReceiptDecl: true }),
      mk({ kind: "expense", date: `${y}-07-20`, donor: "Sample · David", org: "Habitat for Humanity", amount: 58.2, expenseCategory: "meals", expenseDesc: "Meals during build week", awayOvernight: true, reimbursed: false, ackReceived: true }),
      mk({ kind: "expense", date: `${y}-08-30`, donor: "Sample · Maria", org: "Meals on Wheels", amount: 14.5, expenseCategory: "meals", expenseDesc: "Lunch after delivery shift", awayOvernight: false, reimbursed: false })
    ];
    const before = state.entries; state.entries = before.concat(samples); state.settings.samples = true;
    if (!persist()) { state.entries = before; return; }
    renderYearPicker(); renderAll(); showView("ledger"); toast("Sample entries loaded");
  }
  $("clearSamples").addEventListener("click", () => { const before = state.entries; state.entries = before.filter(e => !e.sample); state.settings.samples = false; if (!persist()) { state.entries = before; return; } renderYearPicker(); renderAll(); toast("Sample entries removed"); });

  /* ---------- render all ---------- */
  function renderAll() {
    freeUrls();
    $("sampleBanner").hidden = !state.entries.some(e => e.sample);
    renderLedger(); renderVolunteer(); renderGuide(); renderReceipts(); renderSummary();
    if (form.parentElement && form.parentElement.id) renderThumbs();
  }

  /* ---------- boot ---------- */
  (async function init() {
    const orphans = await window.Store.cleanupOrphans(state).catch(() => 0);
    await refreshReceipts();
    if (orphans) toast(`Removed ${orphans} receipt file${orphans > 1 ? "s" : ""} left over from an interrupted restore.`, true);
    renderYearPicker();
    $("f_date").value = new Date().toISOString().slice(0, 10);
    setKind("cash"); updateExpenseVisibility();
    const v = location.hash.slice(1);
    showView($("view-" + v) ? v : "ledger");
    renderAll();
    if (!window.Store.saveState(state)) toast("Heads up: this browser is blocking storage, so nothing you enter will be kept.", true);
  })();
})();
