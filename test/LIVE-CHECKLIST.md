# Live backend checklist

Run this against a **separate Supabase test project**, not the one you'll use for real users.
Do the automated part first, then the manual part in two real browser sessions (for example, a
normal Chrome window and a private window, or Chrome and Edge). Keep public sign-ups closed
until every line passes.

## 0. Project setup (once)

1. Create the test project at supabase.com.
2. SQL Editor → paste and run `supabase/schema.sql`. It should finish with no errors.
3. Authentication → URL Configuration: Site URL and redirect list include where you'll open the
   app (for local testing `http://localhost:8765`, for the live site `https://a2raya83.github.io/giving-ledger/`).
4. Authentication → SMTP Settings: custom SMTP on, with a verified sender (Resend). Without this,
   magic links only reach your own team's addresses.
5. Project Settings → API Keys: copy the Project URL and the publishable (or legacy anon) key into
   `js/config.js` under `cloud`. Never the secret key.

## 1. Automated live suite

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... node test/live.test.js
```

Expected: `ALL PASS`. It creates and deletes its own `gl-test-*@example.com` users. The secret
key is used only by this script on your machine.

## 2. Manual, two real browser sessions

Use two email addresses you control: **A** (owner) and **B** (spouse).

### Sign-in
- [ ] A: open the app, Sign in, enter A's email. The magic link arrives (custom SMTP working).
- [ ] A: open the link on the same device. The app shows "Name your household ledger". Create one.
- [ ] A: reload the page. Still signed in, household opens, Saved pill visible.
- [ ] A: sign out. Page returns to device-only mode with the "Saved on this device only" hint.

### Household invitations
- [ ] A: account menu → Invite someone → B's email, "Can add and edit" → copy the link.
- [ ] B (second browser): open the link. Sign in with B's email. After the magic link, B lands in
      A's household with the same entries.
- [ ] B: try the link a second time → "already used".
- [ ] A: invite a third address as "Read-only". Sign in as that address in a private window:
      the read-only banner shows, the form is disabled, exports still work.
- [ ] A: remove B from the household. B's next save shows "Access removed" and B's ledger list
      no longer includes the household.

### Receipt access
- [ ] A: add an entry with a photo receipt. It appears under Receipts with a thumbnail.
- [ ] B (re-invited): sees the same receipt, can open it, can attach a second one.
- [ ] Read-only user: can open receipts but cannot add or delete them.
- [ ] Signed out / a different account: pasting the receipt's signed URL after it expires (1 hour)
      returns an error, not the file.
- [ ] Backup & data → Download backup in cloud mode: the file contains the receipts.

### Simultaneous edits
- [ ] A and B both open the same entry's edit form. A saves a change. B's ledger row updates
      live; B's form keeps the old values. B saves. Expect: A's value stays, B's draft appears as
      an "Import conflict" row, banner shows one conflict. B resolves it with Keep mine / Keep this.
- [ ] A creates an entry while B has the page open: B's ledger shows it within a second or two.
- [ ] B goes offline (DevTools → Network → Offline), edits an entry, closes the tab, reopens it
      online: the edit is sent, Saved pill returns, A sees the change.
- [ ] B goes offline, edits entry X; meanwhile A edits X and saves; B comes back online. Expect:
      A's value stays, B's edit becomes a conflict copy, nothing silently overwritten.
- [ ] A deletes an entry while B is editing it. B's save re-creates it or conflicts, never errors
      out silently; B's Saved pill returns.

### Migration
- [ ] On a browser with device-only entries and receipts, sign in. The app offers to copy them.
      Accept. Expect a "Copied and verified" dialog with matching counts before any offer to remove
      the device copy. Decline removal once, reload, accept the offer again: no duplicates.

## Results so far (test project giving-ledger-test, 2026-09-26)

Automated live suite (no-secret mode): **39 pass, 1 skipped** (the canceled-plan retention check
needs the secret key). Manual checks below were driven through the real UI in two browsers with two
password test accounts, because magic-link email delivery is not set up yet (see "Still open").

| Check | Result |
|---|---|
| First sign-in creates a household; reload keeps the session; Saved pill visible | pass |
| Owner saves an entry with a photo receipt; receipt listed with a signed thumbnail | pass |
| Invitation link opened by the invited account joins the household with entries and receipts | pass, after two fixes (token read before the router rewrote the hash; link opened in an already-loaded tab) |
| Member can open the receipt via a short-lived signed link | pass |
| Simultaneous edit: A saves while B's form is open → B's row updates live, B's draft keeps old values, B's save becomes a conflict copy, A's value stays, no double counting | pass |
| Conflict resolved on A; B's ledger clears live | pass, after a schema fix (full replica identity so filtered DELETE events are delivered) |
| Owner removes member → member's next save shows "Access removed", unsent change discarded, household gone from their list | pass |
| Entry added on A appears on B live; deleted on A disappears on B live | pass |

Still open:
- **Magic-link email delivery is unverified.** A sign-in request for the owner's own address created
  the user but no email arrived within ~15 minutes on Supabase's built-in sender. Custom SMTP
  (Resend, verified sender) must be configured and this check repeated before any public sign-in.
- Offline edit → reconnect was not exercised against the real backend (covered by the fake-client
  suite only).
- The canceled-plan retention check needs the secret key on your own terminal.

## 3. Then

Send the reviewer the results of sections 1 and 2. If everything passes, flip the sign-up gate
open: push the `js/config.js` with the **production** project's URL and key (a different project
from the test one, set up the same way).
