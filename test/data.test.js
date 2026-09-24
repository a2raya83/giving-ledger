// Storage-layer tests that need no browser: signatures, merge conflicts, conflict exclusion.
// Run: node test/data.test.js
const fs = require("fs"), path = require("path");
global.window = {}; global.indexedDB = {}; global.localStorage = {};
for (const f of ["fmv", "rules", "data"]) eval(fs.readFileSync(path.join(__dirname, "../js/" + f + ".js"), "utf8"));
const S = window.Store, R = window.Rules;
let fails = 0;
const t = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) fails++; };
const goods = (items, extra = {}) => S.sanitizeEntry(Object.assign({ id: "g1", kind: "noncash", date: "2026-03-01", org: "Thrift", items, ackReceived: true, hasReceiptDecl: true }, extra));
const stock = (st) => S.sanitizeEntry({ id: "s1", kind: "stock", date: "2026-03-01", org: "Trust", amount: 1000, stock: st, ackReceived: true, hasReceiptDecl: true });
const cash = (id, amount) => S.sanitizeEntry({ id, kind: "cash", date: "2026-03-01", org: "Food Bank", amount, bankRecord: true });

// --- signature sees nested changes ---
t("same entry → same signature", S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10 }])) === S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10 }])));
t("item description/value change → different signature", S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10 }])) !== S.signature(goods([{ desc: "Coat", qty: 1, unitValue: 100 }])));
t("item quantity change → different signature", S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10 }])) !== S.signature(goods([{ desc: "Shirt", qty: 2, unitValue: 10 }])));
t("item condition change → different signature", S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10, condition: "good" }])) !== S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10, condition: "fair" }])));
t("stock cost basis change → different signature", S.signature(stock({ ticker: "VTI", costBasis: 500, longTerm: true })) !== S.signature(stock({ ticker: "VTI", costBasis: 900, longTerm: true })));
t("stock holding period change → different signature", S.signature(stock({ ticker: "VTI", costBasis: 500, longTerm: true })) !== S.signature(stock({ ticker: "VTI", costBasis: 500, longTerm: false })));
t("timestamps alone do not change the signature", S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10 }], { updatedAt: "2026-01-01T00:00:00Z" })) === S.signature(goods([{ desc: "Shirt", qty: 1, unitValue: 10 }], { updatedAt: "2026-06-01T00:00:00Z" })));
t("key order does not matter", S.stableStringify({ b: [{ y: 1, x: 2 }], a: 1 }) === S.stableStringify({ a: 1, b: [{ x: 2, y: 1 }] }));

// --- merge produces conflicts for nested changes ---
let m = S.mergeEntries([goods([{ desc: "Shirt", qty: 1, unitValue: 10 }])], [goods([{ desc: "Coat", qty: 1, unitValue: 100 }])]);
t("merge: changed item → 1 conflict, 0 skipped, both kept", m.conflicts === 1 && m.skipped === 0 && m.entries.length === 2 && m.entries[1].conflictOf === "g1");
m = S.mergeEntries([stock({ ticker: "VTI", costBasis: 500, longTerm: true })], [stock({ ticker: "VTI", costBasis: 500, longTerm: false })]);
t("merge: changed holding period → conflict", m.conflicts === 1);
m = S.mergeEntries([goods([{ desc: "Shirt", qty: 1, unitValue: 10 }])], [goods([{ desc: "Shirt", qty: 1, unitValue: 10 }], { updatedAt: "2030-01-01T00:00:00Z" })]);
t("merge: identical content with a newer timestamp → skipped, no conflict", m.skipped === 1 && m.conflicts === 0);

// --- conflict copies never count ---
m = S.mergeEntries([cash("c1", 100)], [cash("c1", 150)]);
let s = R.yearSummary(m.entries);
t("conflict copy excluded from totals ($100, not $250)", s.deductible === 100 && s.conflicts === 1);
t("checklist lists the unresolved conflict", s.checklist.some(c => c.key === "conflicts" && c.state === "need"));
const big = goods([{ desc: "Suits", category: "Men's clothing", qty: 1, unitValue: 4000 }]);
m = S.mergeEntries([big], [goods([{ desc: "Suits", category: "Men's clothing", qty: 1, unitValue: 4500 }])]);
s = R.yearSummary(m.entries);
t("conflict copy excluded from appraisal aggregation (4000, not 8500)", s.groups.Clothing === 4000 && s.checklist.find(c => c.key === "appraisal").state === "na");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
