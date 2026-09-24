# Giving Ledger

Live site: https://a2raya83.github.io/giving-ledger/ · Source: https://github.com/a2raya83/giving-ledger

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
| `js/cloud.js` | Cloud layer: sign-in, household ledgers, invitations, private receipts, realtime, versioned sync with conflicts |
| `supabase/schema.sql` | Database schema, row-level security, storage policies and helper functions for cloud mode |
| `js/config.js` | Site settings: cloud project keys and the optional "support this site" tip links |
| `js/app.js` | UI logic |
| `test/rules.test.js` | Rules-engine tests (`node test/rules.test.js`) |
| `test/data.test.js` | Storage-layer tests: nested-change signatures, merge conflicts, conflict exclusion (`node test/data.test.js`) |
| `test/cloud.test.js` | Cloud sync tests against a fake Supabase client: diffing, versions, conflicts, retry, offline queue, per-user queues, revoked access (`node test/cloud.test.js`) |
| `test/live.test.js` | Live integration test against a real Supabase project through the raw REST/Auth/Storage APIs (see Tests) |
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

## Accounts and household ledgers (cloud mode)

Without cloud settings the app runs in device-only mode. Add a free [Supabase](https://supabase.com)
project and it gains sign-in, household ledgers shared between people, private receipt storage,
automatic saving with a status indicator, live updates between devices, and read-only access for an
accountant. Setup takes about ten minutes:

1. Create a Supabase project (free tier is fine). In **SQL Editor**, paste and run
   `supabase/schema.sql`. It creates the tables, the row-level-security policies, the private
   `receipts` storage bucket, and the helper functions.
2. In **Authentication → URL Configuration**, set the Site URL to where the app is hosted (for
   example `https://a2raya83.github.io/giving-ledger/`) and add it to the redirect allow list.
   Magic-link email sign-in is on by default; no password provider is needed.
3. **Email delivery (required for public sign-in).** Supabase's built-in email sender only delivers
   to your own project team and is for testing. In **Authentication → SMTP Settings**, enable custom
   SMTP with a provider such as Resend, using a verified sender address. Without this, magic links
   never reach real users.
4. In **Project Settings → API Keys**, copy the Project URL and the **publishable** key (or the
   legacy `anon` key) into `js/config.js` under `cloud`. Both are client-side keys meant to ship in
   the page; the row-level-security policies in the schema are what protect the data. Never put a
   secret or `service_role` key in the site.
5. Run the live integration test (below) against the new project before enabling public sign-ups.
6. Push. The app shows a **Sign in** button. The first sign-in creates a household ledger and offers
   to copy the browser's records into it, verifying the copy before offering to remove the local one.

### Plans

The plan belongs to the household, so invited members don't each pay:

| Plan | Includes | Price |
|---|---|---|
| Free | Device-only tracking, value guide, exports, manual backups | $0 |
| Household | Cloud saving, phone/computer access, household sharing, receipt storage, viewer access, year-end export | Free during beta; intended price shown in the app (a hypothesis to test, set in `js/config.js`) |

`households.plan_status` drives enforcement server-side: `beta` and `active` allow writes; `past_due`
and `canceled` make the household read-only while keeping every record and export available
(retention). Billing fields can only be changed by a server-side billing process, never from the
browser. Payment collection is not built yet; when it is, a webhook updates those fields.

### Live integration test

`test/live.test.js` exercises a real project through the raw REST, Auth and Storage APIs, without the
app's own client, so it tests the permissions themselves: two unrelated households can't see or
change each other's entries or receipts; a viewer can read and export but not write, upload, delete
or invite; two devices editing the same entry produce one winner and one preserved conflict; a
removed member is denied on the next read and write; a migration retried after an interruption
produces no duplicates. It needs the project URL, the publishable key and, for creating throwaway
test users, the secret key, passed as environment variables on your own machine only:

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... node test/live.test.js
```

It creates users named `gl-test-*@example.com`, cleans up after itself, and never touches real data.

How it behaves:

- **Household ledger.** Entries and receipts belong to a household, not a person. Owners invite
  people by email with a link; members can add and edit; viewers (an accountant) can only read and
  export. Invitations expire after 14 days and must be accepted by the invited email address.
- **Saving.** Every change is written through immediately. The pill in the top bar shows Saving,
  Saved, Save failed (click to retry) or Offline (retries when back online). Unsent writes survive a
  reload.
- **Simultaneous edits.** Each entry carries a version. If two devices edit the same entry, the
  first write wins and the second is kept as an "Import conflict" copy for the user to resolve, the
  same workflow as backup merges. Other devices see changes live.
- **Receipts** are stored in a private bucket under the household's folder; only members can read
  them, via short-lived signed links.
- **Backups and exports** still work in cloud mode (Replace and Delete-all are disabled on a shared
  ledger). Merge from a backup uploads its receipts under fresh ids.
- **Account recovery** is the sign-in email itself: a new magic link restores access.
- **Account switching on one browser.** Unsent edits are parked under the user and household they
  belong to, in storage and in memory. Another person signing in, a retry, a reconnect, or switching
  households can never submit them; they resume only when that person opens that household again.
- **Migration** treats a local entry whose id already exists in the household as identical (skipped)
  or different (kept as an import conflict); it never overwrites or drops it. Every referenced receipt
  is downloaded back and compared by SHA-256 before the app offers to remove the device copy.

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
node test/cloud.test.js
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

- **Read-only share links** for a preparer without an account, and email notifications for invitations.
- **PDF tax packet**: generate a one-page summary plus receipt images with a client-side PDF library.
- **Organization lookup**: query the IRS Tax Exempt Organization Search data set to confirm EINs.
- **Receipt OCR**: extract date, organization and amount from a photo.

Not tax advice. Confirm deductions with a qualified preparer.
