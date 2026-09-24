// IRS record-keeping rules for charitable contributions (Publication 526, Publication 561,
// Form 8283 instructions). Plain-English rules engine — informational, not tax advice.
(function () {
  const RULES = {
    MILEAGE_RATE: 0.14,          // Charitable standard mileage rate, set by statute (IRC §170(i)) — 14¢ per mile.
    ACK_THRESHOLD: 250,          // Contemporaneous written acknowledgment required for any single gift of $250+.
    QUID_PRO_QUO_DISCLOSURE: 75, // Charity must disclose value of goods/services when payment exceeds $75.
    FORM_8283_THRESHOLD: 500,    // Total non-cash gifts for the year above $500 → Form 8283.
    APPRAISAL_THRESHOLD: 5000,   // Single item OR group of similar items (across the year, all charities) above $5,000 → qualified appraisal + Section B.
    VEHICLE_THRESHOLD: 500,      // Car/boat/plane above $500 → Form 1098-C from the charity.
    NONITEMIZER_CASH_LIMIT: { single: 1000, joint: 2000 }, // Tax year 2026+: above-the-line cash deduction for non-itemizers.
    ITEMIZER_AGI_FLOOR: 0.005,   // Tax year 2026+: itemized charitable deductions reduced by 0.5% of AGI.
    AGI_LIMIT_CASH: 0.60,        // Cash gifts to public charities limited to 60% of AGI.
    AGI_LIMIT_PROPERTY: 0.30,    // Appreciated property (stock held >1 yr) limited to 30% of AGI.
    CARRYFORWARD_YEARS: 5
  };

  const KINDS = {
    cash:    { label: "Cash / check / card", short: "Cash", color: 1 },
    noncash: { label: "Goods (non-cash)",    short: "Goods", color: 2 },
    stock:   { label: "Stock / securities",  short: "Stock", color: 3 },
    mileage: { label: "Volunteer mileage",   short: "Mileage", color: 4 },
    expense: { label: "Volunteer expense",   short: "Expense", color: 5 }
  };

  const EXPENSE_CATEGORIES = {
    supplies:  { label: "Supplies & materials", note: "Stamps, paper, ingredients for a bake sale, craft supplies, printing — deductible if unreimbursed." },
    uniform:   { label: "Uniform (not everyday wear)", note: "Deductible only if the uniform has no general use (e.g. a scout leader shirt, not khakis). Cleaning counts too." },
    gas:       { label: "Gas & oil (actual cost, instead of mileage)", note: "You may claim actual gas & oil OR 14¢/mile for the same trip — never both. No repairs, insurance or depreciation." },
    parking:   { label: "Parking & tolls", note: "Deductible on top of mileage or actual gas costs." },
    transport: { label: "Travel away from home (air, rail, bus, taxi)", note: "Deductible if you're on genuine charity duty throughout and the trip has no significant element of personal pleasure, recreation or vacation." },
    lodging:   { label: "Lodging while away overnight", note: "Deductible under the same travel rules — reasonable cost, no significant personal element." },
    meals:     { label: "Meals", note: "Only deductible while traveling away from home overnight on charity business. A local meal grabbed during a volunteer shift is not deductible." },
    convention:{ label: "Convention / conference costs", note: "Deductible only if you attend as a chosen representative (delegate) of the charity, not as a member for your own benefit." },
    other:     { label: "Other out-of-pocket", note: "Must be unreimbursed, directly connected with the volunteer service, and incurred only because of it." }
  };

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const isBlank = v => v === null || v === undefined || v === "";
  const money = n => "$" + num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const itemValue = it => num(it.qty || 1) * num(it.unitValue);

  function itemsTotal(entry) {
    if (!Array.isArray(entry.items) || !entry.items.length) return num(entry.amount);
    return entry.items.reduce((s, it) => s + itemValue(it), 0);
  }

  // Recorded value of the gift before any reductions.
  function grossValue(entry) {
    switch (entry.kind) {
      case "cash":    return num(entry.amount);
      case "noncash": return itemsTotal(entry);
      case "stock":   return num(entry.amount);
      case "mileage": return num(entry.miles) * RULES.MILEAGE_RATE + num(entry.parkingTolls);
      case "expense": return num(entry.amount);
      default: return num(entry.amount);
    }
  }

  // Evaluate one entry.
  //   opts.files — number of receipt files actually present for this entry (defaults to receiptIds length)
  // Returns { gross, eligible, deductible, status, flags }
  //   gross      recorded value
  //   eligible   what the rules allow before documentation problems (e.g. after quid-pro-quo, basis limits)
  //   deductible eligible, or 0 when a "stop" condition (no records, reimbursed, not a qualifying expense) applies
  //   status     "ok" | "warn" | "stop"
  function evaluate(entry, opts = {}) {
    const flags = [];
    const gross = grossValue(entry);
    let eligible = gross;
    const benefit = num(entry.benefit);
    const files = opts.files != null ? opts.files : (Array.isArray(entry.receiptIds) ? entry.receiptIds.length : 0);
    const hasReceipt = files > 0;

    if (entry.kind === "cash") {
      if (benefit > 0) {
        eligible = Math.max(0, gross - benefit);
        flags.push({ level: "info", text: `You received ${money(benefit)} in goods or services (dinner, auction item, tickets). Only the excess, ${money(eligible)}, is deductible.` });
        if (gross > RULES.QUID_PRO_QUO_DISCLOSURE) flags.push({ level: "info", text: "Payments over $75 with something received in return: the charity must give you a written disclosure of the value. Keep it." });
      }
      if (!entry.bankRecord && !entry.ackReceived && !hasReceipt) {
        flags.push({ level: "stop", text: "No bank record, receipt or written acknowledgment. Cash gifts are not deductible at all without one — a cancelled check, card or bank statement, or a letter/receipt from the charity. Cash in a collection plate needs a receipt." });
      }
      if (gross >= RULES.ACK_THRESHOLD && !entry.ackReceived) {
        flags.push({ level: "warn", text: `Gift of ${money(gross)} is $250 or more: you need a contemporaneous written acknowledgment from the charity stating the amount and whether any goods or services were provided. Request it before you file.` });
      }
      if (entry.method === "payroll") flags.push({ level: "info", text: "Payroll deduction: keep the pay stub or W-2 plus the pledge card naming the charity. Each paycheck is a separate gift for the $250 rule." });
    }

    if (entry.kind === "noncash") {
      const items = entry.items || [];
      if (benefit > 0) {
        eligible = Math.max(0, gross - benefit);
        flags.push({ level: "info", text: `Value received in return (${money(benefit)}) reduces the deduction to ${money(eligible)}.` });
      }
      const fairItems = items.filter(it => it.condition === "fair");
      if (fairItems.length) {
        const fairValue = fairItems.reduce((s, it) => s + itemValue(it), 0);
        const stillOk = fairItems.every(it => itemValue(it) > 500 && entry.appraised);
        if (!stillOk) {
          eligible = Math.max(0, eligible - fairValue);
          flags.push({ level: "warn", text: `${fairItems.length} item${fairItems.length > 1 ? "s" : ""} marked “fair” condition (${money(fairValue)}) excluded. Clothing and household items must be in good used condition or better to be deductible, unless a single item is worth over $500 and you have a qualified appraisal.` });
        }
      }
      if (gross >= RULES.ACK_THRESHOLD && !entry.ackReceived) flags.push({ level: "warn", text: "Goods worth $250 or more: you need a written acknowledgment from the charity describing the items (it doesn't have to state a value) and whether you received anything in return." });
      if (gross > RULES.FORM_8283_THRESHOLD) flags.push({ level: "info", text: "Over $500 of goods: this gift will go on Form 8283 (Section A). Record how you acquired the items, roughly when, and what you paid — the form asks." });
      const big = items.filter(it => itemValue(it) > RULES.APPRAISAL_THRESHOLD);
      if (big.length || (gross > RULES.APPRAISAL_THRESHOLD && !items.length)) flags.push({ level: "warn", text: "A single item or group of similar items over $5,000 needs a qualified appraisal, and Form 8283 Section B signed by the appraiser and the charity. Publicly traded stock is the exception." });
      if (entry.vehicle) flags.push({ level: "warn", text: "Vehicle, boat or airplane over $500: your deduction is generally limited to what the charity sells it for. You need Form 1098-C from the charity within 30 days of the sale and must attach it to your return." });
      if (!items.length && gross > 0) flags.push({ level: "info", text: "Add an itemized list with condition and how you valued each item — the IRS expects a description, condition, and the method used to arrive at fair market value." });
      if (!entry.ackReceived && !hasReceipt && gross > 0) flags.push({ level: "warn", text: "No receipt or acknowledgment attached. Goods need a receipt from the charity (name, date, location, description) unless it was genuinely impractical to get one, like an unattended drop box." });
    }

    if (entry.kind === "stock") {
      const st = entry.stock || {};
      const longTerm = !!st.longTerm;
      if (!longTerm) {
        if (isBlank(st.costBasis)) {
          flags.push({ level: "warn", text: "Held one year or less: the deduction is limited to your cost basis. Enter the basis — until then the full market value is shown, which is probably too high." });
        } else {
          const basis = Math.max(0, num(st.costBasis));
          if (basis < gross) { eligible = basis; flags.push({ level: "warn", text: `Held one year or less: the deduction is limited to your cost basis, ${money(basis)}, not the ${money(gross)} market value. Gifts of stock held over a year deduct at full fair market value with no capital-gains tax.` }); }
        }
      } else {
        flags.push({ level: "ok", text: "Held over one year: deduct the full fair market value and skip capital-gains tax on the appreciation. This category is limited to 30% of AGI (5-year carryforward)." });
      }
      if (gross >= RULES.ACK_THRESHOLD && !entry.ackReceived) flags.push({ level: "warn", text: "Gift of $250 or more: get a written acknowledgment from the charity describing the securities (number of shares, name) and the transfer date." });
      if (gross > RULES.FORM_8283_THRESHOLD) flags.push({ level: "info", text: "Over $500: report on Form 8283 Section A. Publicly traded securities never need an appraisal. Value = average of the high and low price on the transfer date." });
      if (!hasReceipt) flags.push({ level: "info", text: "Attach the broker transfer confirmation showing the date the shares left your account." });
    }

    if (entry.kind === "mileage") {
      if (!num(entry.miles)) flags.push({ level: "warn", text: "Enter the miles driven. The charitable rate is 14¢ per mile (set by statute, unchanged for decades)." });
      if (!entry.purpose) flags.push({ level: "warn", text: "Add the purpose of the trip. A mileage log needs date, organization, purpose, and miles (odometer or map distance)." });
      if (gross >= RULES.ACK_THRESHOLD && !entry.ackReceived) flags.push({ level: "warn", text: "Out-of-pocket costs of $250 or more for a single event or trip need a written acknowledgment from the charity describing the services you provided." });
      if (num(entry.parkingTolls)) flags.push({ level: "ok", text: `Parking and tolls (${money(entry.parkingTolls)}) are deductible on top of the mileage rate.` });
    }

    if (entry.kind === "expense") {
      const cat = entry.expenseCategory || "other";
      if (entry.reimbursed) flags.push({ level: "stop", text: "Reimbursed by the charity — nothing to deduct. If only part was reimbursed, log the unreimbursed part alone." });
      if (["transport", "lodging", "meals"].includes(cat)) {
        if (!entry.awayOvernight && cat !== "transport") flags.push({ level: "stop", text: cat === "meals" ? "Meals are only deductible while away from home overnight on the charity's business. Lunch during a local volunteer shift is a personal expense." : "Lodging is only deductible when you are away from home overnight on charity business." });
        if (entry.personalPleasure) flags.push({ level: "stop", text: "Travel with a significant element of personal pleasure, recreation or vacation is not deductible — even if you do some volunteer work along the way. The test is whether you were on real, substantial duty throughout." });
        else if (!entry.reimbursed && (entry.awayOvernight || cat === "transport")) flags.push({ level: "ok", text: "Travel counts when you are on genuine, substantial charitable duty throughout the trip. Keep an itinerary or schedule showing your duties." });
        if (entry.companions) flags.push({ level: "warn", text: "Costs for a spouse, child or friend who isn't volunteering are not deductible. Log only your own share." });
      }
      if (cat === "uniform" && !entry.uniformNoGeneralUse) flags.push({ level: "stop", text: "Clothing is deductible only if it's a required uniform with no general use. Confirm that box if it qualifies." });
      if (cat === "convention" && !entry.delegate) flags.push({ level: "stop", text: "Convention costs are deductible only if you attend as a chosen representative of the charity, not simply as a member." });
      if (cat === "gas") flags.push({ level: "info", text: "Actual gas and oil for charity driving. Don't also log mileage at 14¢ for the same trip. Repairs, insurance, depreciation and registration are never deductible." });
      if (gross >= RULES.ACK_THRESHOLD && !entry.ackReceived) flags.push({ level: "warn", text: "Out-of-pocket expense of $250 or more for a single event: get a written acknowledgment from the charity describing the services you provided (it can say whether you got anything in return; it doesn't have to value the expense)." });
      if (!hasReceipt) flags.push({ level: "warn", text: "Attach the receipt. Unreimbursed volunteer expenses need adequate records: receipts, dates, and a note tying them to the charity's work." });
    }

    if (["cash", "noncash", "stock"].includes(entry.kind) && !entry.org) flags.push({ level: "warn", text: "Name the organization. Check it's a qualified charity in the IRS Tax Exempt Organization Search — gifts to individuals, political groups, and most foreign charities are not deductible." });
    if (["cash", "noncash"].includes(entry.kind) && gross > 0 && gross < RULES.ACK_THRESHOLD && !hasReceipt && !entry.ackReceived && entry.bankRecord && entry.kind === "cash") flags.push({ level: "ok", text: "Under $250 with a bank record — that's sufficient. A receipt photo is still nice to have." });

    const status = flags.some(f => f.level === "stop") ? "stop" : flags.some(f => f.level === "warn") ? "warn" : "ok";
    const deductible = status === "stop" ? 0 : Math.max(0, eligible);
    return { gross, eligible: Math.max(0, eligible), deductible, status, flags };
  }

  // Similar-property aggregation: the $5,000 appraisal test applies to all similar items given
  // during the year, across every charity (Form 8283 instructions). "Similar" = same generic category.
  function similarPropertyGroups(entries) {
    const groups = {};
    entries.filter(e => e.kind === "noncash").forEach(e => (e.items || []).forEach(it => {
      const key = it.category || "Uncategorized";
      groups[key] = (groups[key] || 0) + itemValue(it);
    }));
    return groups;
  }

  // Year-level analysis across a set of entries (should be ONE tax year for the filing checklist).
  //   opts.filesFor(entry) → number of receipt files actually present
  function yearSummary(entries, opts = {}) {
    const filesFor = opts.filesFor || (e => (e.receiptIds || []).length);
    const byKind = {}; Object.keys(KINDS).forEach(k => byKind[k] = 0);
    let gross = 0, deductible = 0, blocked = 0, needsAck = 0, missingReceipts = 0, noncashTotal = 0, vehicle = 0;
    const byDonor = {}, byOrg = {};
    entries.forEach(e => {
      const r = evaluate(e, { files: filesFor(e) });
      byKind[e.kind] = (byKind[e.kind] || 0) + r.deductible;
      gross += r.gross; deductible += r.deductible; if (r.status === "stop") blocked += r.eligible;
      if (r.flags.some(f => /acknowledgment/i.test(f.text) && f.level === "warn" && /\$250/.test(f.text))) needsAck++;
      if (!filesFor(e) && e.kind !== "mileage" && r.deductible > 0 && !(e.kind === "cash" && e.bankRecord)) missingReceipts++;
      if (e.kind === "noncash") { noncashTotal += r.deductible; if (e.vehicle) vehicle++; }
      if (e.kind === "stock") noncashTotal += r.deductible;
      const d = e.donor || "Unassigned"; byDonor[d] = (byDonor[d] || 0) + r.deductible;
      const o = e.org || "(no organization)"; byOrg[o] = (byOrg[o] || 0) + r.deductible;
    });
    const groups = similarPropertyGroups(entries);
    const appraisalGroups = Object.entries(groups).filter(([, v]) => v > RULES.APPRAISAL_THRESHOLD);
    const cash = byKind.cash;
    const volunteer = byKind.mileage + byKind.expense;
    const checklist = [
      { key: "schedA", state: deductible > 0 ? "need" : "na", text: "Schedule A (Form 1040) — Itemized Deductions, line 11 (cash, including volunteer expenses & mileage) and line 12 (non-cash)." },
      { key: "ack", state: needsAck ? "need" : "done", text: needsAck ? `${needsAck} gift${needsAck > 1 ? "s" : ""} of $250+ still need a written acknowledgment from the charity.` : "Every gift of $250+ has a written acknowledgment on record." },
      { key: "8283", state: noncashTotal > RULES.FORM_8283_THRESHOLD ? "need" : "na", text: noncashTotal > RULES.FORM_8283_THRESHOLD ? `Form 8283 — non-cash gifts total ${money(noncashTotal)} (over $500). Section A for items ≤ $5,000 and publicly traded stock.` : "Form 8283 not required (non-cash total ≤ $500)." },
      { key: "appraisal", state: appraisalGroups.length ? "need" : "na", text: appraisalGroups.length ? `Qualified appraisal + Form 8283 Section B needed: similar items total over $5,000 for the year — ${appraisalGroups.map(([k, v]) => `${k} ${money(v)}`).join(", ")}. The test adds up similar items across all charities.` : "No single item or group of similar items over $5,000 — no appraisal needed." },
      { key: "1098c", state: vehicle ? "need" : "na", text: vehicle ? "Form 1098-C from the charity for each donated vehicle, boat or plane — attach to the return." : "No vehicle donations." },
      { key: "receipts", state: missingReceipts ? "need" : "done", text: missingReceipts ? `${missingReceipts} entr${missingReceipts > 1 ? "ies" : "y"} without a receipt or acknowledgment attached.` : "Every entry has a receipt, bank record or acknowledgment on file." }
    ];
    return { byKind, byDonor, byOrg, gross, deductible, blocked, cash, noncash: noncashTotal, volunteer, needsAck, missingReceipts, appraisalGroups, checklist };
  }

  window.RULES = RULES;
  window.KINDS = KINDS;
  window.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
  window.Rules = { evaluate, grossValue, itemsTotal, itemValue, similarPropertyGroups, yearSummary, money, num, isBlank };
})();
