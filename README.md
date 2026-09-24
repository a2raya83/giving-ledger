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
| `js/rules.js` | IRS rules engine: thresholds, per-entry evaluation, year summary and filing checklist |
| `js/fmv.js` | Fair-market-value ranges for ~130 commonly donated items |
| `js/config.js` | Site settings: the optional "support this site" tip links |
| `js/data.js` | Storage layer: localStorage entries, IndexedDB receipts, backup import/export |
| `js/app.js` | UI logic |
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

Open `js/config.js`, set `support.enabled` to `true`, and add one or more links (Buy Me a Coffee, Ko-fi, PayPal.me, GitHub Sponsors, or any URL). A dismissible card appears at the bottom of the Tax summary tab and a one-line note in the footer. Nothing is gated behind it.

## Data integrity rules

- A save is only reported after the write to browser storage is confirmed; on failure the form keeps your entry.
- Removing a receipt while editing is staged: Cancel keeps the original attachments, Save applies the removal.
- Backups fail loudly if receipt files can't be read, and report entry/receipt counts.
- Restore validates and decodes the whole file first. "Replace" only wipes existing data once every receipt decoded. "Merge" adds new entries and, for entries present in both, keeps the more recently edited one.
- An entry with a blocking problem (cash with no record, a reimbursed expense, a local meal) shows as "Not deductible" and contributes $0 to every total; its recorded value is shown separately.

## Tax rules encoded

The rules engine reflects IRS Publication 526, Publication 561 and the Form 8283 instructions,
plus the 2026 changes from the 2025 tax law (non-itemizer cash deduction, 0.5% AGI floor, 35% cap).
Thresholds live at the top of `js/rules.js`:

- Written acknowledgment for any single gift or expense of $250+
- Quid-pro-quo disclosure over $75; deduction reduced by value received
- Form 8283 when non-cash gifts exceed $500; qualified appraisal over $5,000
- Form 1098-C for vehicles over $500
- Charitable mileage at the statutory 14¢/mile plus parking and tolls
- Volunteer travel: deductible only with no significant personal-pleasure element; meals and lodging only when away overnight
- Stock held ≤ 1 year limited to cost basis (a $0 basis counts; a blank basis prompts for it)
- Similar-property aggregation: the $5,000 appraisal test adds up items of the same category across the year and all charities
- Filing checklists run per tax year even when "All years" is selected

The fair-market-value ranges in `js/fmv.js` are typical thrift-store resale prices from published
charity valuation guides. Refresh them against the current Salvation Army or Goodwill guide once a year.

## Roadmap ideas

- **Accounts and sync** (so a family shares one ledger across devices): add Supabase or Firebase auth,
  move entries to a table keyed by user, and receipts to object storage. `js/data.js` is the only
  file that needs to change.
- **PDF tax packet**: generate a one-page summary plus receipt images with a client-side PDF library.
- **Organization lookup**: query the IRS Tax Exempt Organization Search data set to confirm EINs.
- **Receipt OCR**: extract date, organization and amount from a photo.

Not tax advice. Confirm deductions with a qualified preparer.
