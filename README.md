# Giving Ledger

A public, static web app for tracking charitable donations the way the IRS expects:
cash gifts, donated goods with fair-market-value guidance, gifts of stock, volunteer
mileage, and out-of-pocket volunteer expenses, with receipts attached to each entry.

Everything runs in the visitor's browser. Entries are stored in `localStorage`, receipt
files in IndexedDB. Nothing is uploaded anywhere, which is the right default for tax
records on a site you don't run a backend for. Backup & restore moves data between devices.

## Files

| Path | What it is |
|---|---|
| `index.html` | The page: app bar, tabs, all six views, and the entry form |
| `css/app.css` | Styles, light and dark palettes |
| `js/rules.js` | IRS rules engine: thresholds, per-entry evaluation, appraisal grouping, year summary and filing checklist |
| `js/fmv.js` | Fair-market-value ranges for ~130 commonly donated items, plus the appraisal-group map |
| `js/data.js` | Storage layer: localStorage entries, IndexedDB receipts, staged backup import/export |
| `js/config.js` | Site settings: the optional "support this site" tip links |
| `js/app.js` | UI logic |
| `test/rules.test.js` | Rules-engine tests (`node test/rules.test.js`) |
| `test/data.test.js` | Storage-layer tests: nested-change signatures, merge conflicts, conflict exclusion (`node test/data.test.js`) |
| `test/browser-failure-tests.js` | Failure-mode tests to paste into the browser console on a running copy |
| `serve.js` | Local preview server (`node serve.js`, then open http://localhost:8765) |
| `original-donation-tracker.html` | The single-file tracker this replaced, kept for reference |

## Run locally

```bash
node serve.js
```

Then open http://localhost:8765. Any static server works; the app has no build step.

## Deploy as a public website (free options)

**GitHub Pages**
1. Create a repository and push this folder (skip `serve.js` and `.claude/` if you like).
2. Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. The site appears at `https://<you>.github.io/<repo>/`.

**Netlify or Cloudflare Pages**
Drag the folder onto the Netlify dashboard, or connect the repo. No build command, publish directory `/`.

Add a custom domain from either dashboard when you're ready.

## Optional donation ask

Open `js/config.js`, set `support.enabled` to `true`, and add one or more links (Buy Me a Coffee,
Ko-fi, PayPal.me, GitHub Sponsors, or any URL). A dismissible card appears at the bottom of the
Tax summary tab and a one-line note in the footer. It sits outside the entry and export flows and
nothing is gated behind it.

## Entry status: eligibility is separate from documentation

Every entry gets one of three statuses.

- **Records OK** — eligible, and the records the IRS asks for are on file.
- **Documentation needed** — eligible and counted in every total, but something is missing before
  filing: a written acknowledgment for a $250+ gift, a bank record or receipt for cash, the cost
  basis for short-term stock, a purpose on a mileage log. The summary shows how much of the total
  is in this state.
- **Not eligible** — a disqualifying condition: reimbursed, a meal not away overnight, travel with a
  significant vacation element, a uniform with everyday use, a convention attended as a member.
  Counts $0; the recorded value is shown separately.

Having a receipt is a declaration ("I have a receipt or record for this"), not an upload.
Attaching a file also counts, and is encouraged because attachments travel with the backup, but a
paper receipt in a folder is a receipt.

## Data integrity rules

- A save is only reported after the write to browser storage is verified; on failure the form keeps
  the entry and the stored ledger is untouched.
- Removing a receipt while editing is staged: Cancel keeps the original attachments, Save applies it.
- Backups fail loudly if receipt files can't be read, and report entry/receipt counts.
- Restore is staged, then switched over in one write. The file is validated and decoded in memory
  first. Incoming receipts are written under fresh ids, marked "staged", and never overwrite an
  existing file; incoming entries are re-pointed to the new ids. The ledger is then committed in a
  single localStorage write, which is the switch-over. Only after that does "Replace" delete the
  previous receipts. If a step fails, the staged writes are rolled back. If the tab closes before the
  commit, the previous ledger still points at its own files and the staged orphans are removed on the
  next load. Each restore has a batch id that the committed ledger records, so a receipt whose batch
  was committed is kept even if it links to no entry and the flag-clearing step was interrupted.
  This is not one atomic transaction across both stores; the commit point is the ledger write, and
  everything before it is invisible to the old ledger.
- Merge never overwrites. New ids are added; identical entries (compared field by field at every
  nesting level, including items and stock details) are skipped; an entry with the same id but
  different content is kept as a separate "Import conflict" copy with Keep this / Keep mine
  buttons. Device clocks are not trusted to pick a winner. Until resolved, a conflict copy is not
  counted in any total, appraisal aggregation, checklist or export; the checklist lists it as an
  open item and exports say how many were left out. Editing a conflict copy keeps it a conflict copy;
  only Keep this / Keep mine resolves it.
- A receipt file is deleted only when no remaining entry references it. A conflict copy and its
  original share files, so deleting or resolving either one never removes a file the other needs.
- Rows whose receipt file is missing from this browser say so, rather than counting the id as a file.

## Tax rules encoded

The rules engine reflects IRS Publication 526, Publication 561 and the Form 8283 instructions,
plus the 2026 changes from the 2025 tax law (non-itemizer cash deduction, 0.5% AGI floor, 35% cap).
Thresholds live at the top of `js/rules.js`:

- Written acknowledgment for any single gift or expense of $250+
- Quid-pro-quo disclosure over $75; deduction reduced by value received
- Form 8283 when non-cash gifts exceed $500; qualified appraisal over $5,000
- Similar-property aggregation for the $5,000 test uses appraisal groups, not shopping categories:
  men's, women's and children's clothing are one group; books, media and toys are three. The map and
  keyword overrides live in `js/fmv.js`. Uncategorized goods are flagged rather than silently grouped.
- Form 1098-C for vehicles over $500
- Charitable mileage at the statutory 14¢/mile plus parking and tolls
- Volunteer travel: deductible only with no significant personal-pleasure element; meals and lodging only when away overnight
- Stock held ≤ 1 year limited to cost basis (a $0 basis counts; a blank basis prompts for it)
- Filing checklists run per tax year even when "All years" is selected

The fair-market-value ranges in `js/fmv.js` are typical thrift-store resale prices from published
charity valuation guides, reviewed September 2026. Refresh them against the current Salvation Army or
Goodwill guide once a year.

## Tests

```bash
node test/rules.test.js
node test/data.test.js
```

For the failure-mode tests (storage failing midway through a restore, ledger write failing after
receipts were written, save failing after a staged receipt removal, nested-change merge conflicts,
conflicts excluded from totals and exports, editing and deleting conflict copies, a restore
interrupted before commit and one interrupted right after commit with an unlinked receipt, similar
goods across categories and charities), run the site locally, open the browser console, and paste
`test/browser-failure-tests.js`. It resets the browser's copy of the data first, so don't run it
where real entries live. The script reloads the page once to test startup cleanup for real; paste
it a second time after the reload to see the final results.

## Roadmap ideas

- **Accounts and sync** (so a family shares one ledger live): add Supabase or Firebase auth,
  move entries to a table keyed by user, and receipts to object storage. `js/data.js` is the only
  file that needs to change. Until then, backup files are a hand-off, not sync.
- **PDF tax packet**: generate a one-page summary plus receipt images with a client-side PDF library.
- **Organization lookup**: query the IRS Tax Exempt Organization Search data set to confirm EINs.
- **Receipt OCR**: extract date, organization and amount from a photo.

Not tax advice. Confirm deductions with a qualified preparer.
