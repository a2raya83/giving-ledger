// Rules-engine tests. Run: node test/rules.test.js
const fs = require("fs"), path = require("path");
global.window = {};
eval(fs.readFileSync(path.join(__dirname, "../js/fmv.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../js/rules.js"), "utf8"));
const { evaluate, yearSummary, appraisalGroup } = window.Rules;
let fails = 0;
const t = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) fails++; };
const mk = (org, category, desc, unitValue) => ({ kind: "noncash", org, items: [{ desc, category, qty: 1, unitValue }], ackReceived: true, hasReceiptDecl: true, receiptIds: [] });

// --- status semantics: eligibility vs documentation ---
let r = evaluate({ kind: "cash", amount: 300, bankRecord: true, ackReceived: false, org: "X" }, { files: 0 });
t("$300 cash, bank record, no acknowledgment → documentation needed, still counted", r.status === "docs" && r.deductible === 300);
r = evaluate({ kind: "cash", amount: 100, bankRecord: false, ackReceived: false, org: "X" }, { files: 0 });
t("cash with no record at all → documentation needed (not 'not eligible'), counted", r.status === "docs" && r.deductible === 100);
r = evaluate({ kind: "cash", amount: 100, bankRecord: false, hasReceiptDecl: true, org: "X" }, { files: 0 });
t("cash with a declared paper receipt and no upload → records OK", r.status === "ok");
r = evaluate({ kind: "expense", amount: 20, expenseCategory: "meals", awayOvernight: false }, { files: 1 });
t("local meal → not eligible, $0", r.status === "stop" && r.deductible === 0);
r = evaluate({ kind: "expense", amount: 40, expenseCategory: "supplies", org: "X", hasReceiptDecl: true }, { files: 0 });
t("supplies with declared receipt, no upload → records OK", r.status === "ok" && r.deductible === 40);
r = evaluate({ kind: "expense", amount: 40, expenseCategory: "supplies", org: "X" }, { files: 0 });
t("supplies with no receipt declared → documentation needed", r.status === "docs" && r.deductible === 40);
r = evaluate({ kind: "cash", amount: 300, benefit: 120, bankRecord: true, ackReceived: true, org: "X" }, { files: 0 });
t("quid pro quo reduces to 180", r.deductible === 180 && r.status === "ok");
r = evaluate({ kind: "stock", amount: 1000, org: "X", stock: { costBasis: 0, longTerm: false }, ackReceived: true, hasReceiptDecl: true }, { files: 0 });
t("short-term stock with $0 basis → $0", r.deductible === 0);
r = evaluate({ kind: "stock", amount: 1000, org: "X", stock: { costBasis: null, longTerm: false }, ackReceived: true, hasReceiptDecl: true }, { files: 0 });
t("short-term stock with blank basis → docs flag, FMV shown", r.status === "docs" && r.deductible === 1000);
r = evaluate({ kind: "noncash", org: "X", items: [{ desc: "Shirt", condition: "fair", qty: 1, unitValue: 10 }, { desc: "Coat", condition: "good", qty: 1, unitValue: 30 }], ackReceived: true }, { files: 1 });
t("fair-condition item excluded via limit flag", r.deductible === 30 && r.flags.some(f => f.level === "limit"));

// --- appraisal grouping (similar property) ---
t("men's + women's clothing share one group", appraisalGroup({ category: "Men's clothing", desc: "Suits" }) === "Clothing" && appraisalGroup({ category: "Women's clothing", desc: "Coats" }) === "Clothing");
t("books vs toys split inside the mixed guide category", appraisalGroup({ category: "Books, media & toys", desc: "Hardcover books" }) === "Books" && appraisalGroup({ category: "Books, media & toys", desc: "Stuffed animals" }) === "Toys & games");
t("car seat is not a vehicle", appraisalGroup({ category: "Books, media & toys", desc: "Car seat" }) === "Toys & games");
t("a painting in Household is art", appraisalGroup({ category: "Household & kitchen", desc: "Oil painting" }) === "Art & collectibles");
let s = yearSummary([mk("Charity A", "Men's clothing", "Suits", 3000), mk("Charity B", "Women's clothing", "Coats", 2500)]);
const ap = s.checklist.find(c => c.key === "appraisal");
t("clothing across two guide categories and two charities → appraisal needed ($5,500)", ap.state === "need" && /Clothing \$5,500/.test(ap.text));
s = yearSummary([mk("A", "Books, media & toys", "Hardcover books", 3000), mk("B", "Books, media & toys", "Board games", 3000)]);
t("books + games in the same guide category → NOT aggregated", s.checklist.find(c => c.key === "appraisal").state === "na");
s = yearSummary([mk("A", "", "Mystery box", 6000)]);
t("uncategorized goods flagged separately, not silently aggregated", s.checklist.some(c => c.key === "uncat" && c.state === "need") && s.checklist.find(c => c.key === "appraisal").state === "na");

// --- summary splits ---
s = yearSummary([{ kind: "cash", amount: 300, bankRecord: true, org: "X", receiptIds: [] }, { kind: "expense", amount: 20, expenseCategory: "meals", awayOvernight: false, receiptIds: ["x"] }]);
t("summary separates needsDocs and notEligible", s.deductible === 300 && s.needsDocs === 300 && s.notEligible === 20);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
