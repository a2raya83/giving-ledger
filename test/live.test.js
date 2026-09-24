// Live integration test against a REAL Supabase project, using raw HTTP (REST, Auth, Storage) so
// the permissions are tested directly, not through the app's client.
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... node test/live.test.js
// The secret key is used ONLY here, on your machine, to create and delete throwaway users. Never
// put it in the site. Test users are gl-test-<n>@example.com and are removed at the end.
const URL_ = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !ANON || !SERVICE) { console.error("Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY."); process.exit(2); }
let fails = 0;
const t = (name, cond, extra) => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond || extra == null ? "" : "   → " + JSON.stringify(extra).slice(0, 200))); if (!cond) fails++; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function api(method, path, { token, body, headers, raw } = {}) {
  const res = await fetch(URL_ + path, { method, headers: Object.assign({ apikey: ANON, Authorization: "Bearer " + (token || ANON), "Content-Type": "application/json" }, headers || {}), body: body == null ? undefined : (raw ? body : JSON.stringify(body)) });
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}
const rest = (method, table, token, body, query = "", prefer) => api(method, "/rest/v1/" + table + (query ? "?" + query : ""), { token, body, headers: prefer ? { Prefer: prefer } : {} });
const rpc = (fn, token, args) => api("POST", "/rest/v1/rpc/" + fn, { token, body: args || {} });

// ---- users via the admin API (secret key), sessions via magic-link token hashes (no password provider needed) ----
const created = [];
async function makeUser(label) {
  const email = `gl-test-${label}-${uid()}@example.com`;
  const r = await api("POST", "/auth/v1/admin/users", { token: SERVICE, headers: { apikey: SERVICE }, body: { email, email_confirm: true } });
  if (!r.ok) throw new Error("create user failed: " + JSON.stringify(r.data));
  created.push(r.data.id);
  const link = await api("POST", "/auth/v1/admin/generate_link", { token: SERVICE, headers: { apikey: SERVICE }, body: { type: "magiclink", email } });
  if (!link.ok) throw new Error("generate_link failed: " + JSON.stringify(link.data));
  const hashed = (link.data.properties && link.data.properties.hashed_token) || link.data.hashed_token;
  const ver = await api("POST", "/auth/v1/verify", { body: { type: "magiclink", token_hash: hashed } });
  if (!ver.ok || !ver.data.access_token) throw new Error("verify failed: " + JSON.stringify(ver.data));
  return { id: r.data.id, email, token: ver.data.access_token };
}
async function cleanup() {
  for (const id of created) await api("DELETE", "/auth/v1/admin/users/" + id, { token: SERVICE, headers: { apikey: SERVICE } }).catch(() => {});
}
const entry = (id, amount) => ({ id, body: { kind: "cash", date: "2026-03-01", org: "Food Bank", amount, bankRecord: true, receiptIds: [] }, version: 1 });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const upload = (token, path) => api("POST", "/storage/v1/object/receipts/" + path, { token, body: png, raw: true, headers: { "Content-Type": "image/png" } });
const download = (token, path) => api("GET", "/storage/v1/object/authenticated/receipts/" + path, { token });

(async () => {
  console.log("Creating test users…");
  const alice = await makeUser("alice"), bob = await makeUser("bob"), carol = await makeUser("carol"), dave = await makeUser("dave");

  // ---- households ----
  const hA = (await rpc("create_household", alice.token, { p_name: "Alice household" })).data;
  const hB = (await rpc("create_household", bob.token, { p_name: "Bob household" })).data;
  t("create_household returns an id for each owner", typeof hA === "string" && typeof hB === "string" && hA !== hB);
  const seedA = await rest("POST", "entries", alice.token, [Object.assign({ household_id: hA }, entry("a1", 100))]);
  const seedB = await rest("POST", "entries", bob.token, [Object.assign({ household_id: hB }, entry("b1", 200))]);
  t("owners can insert entries into their own household", seedA.status === 201 && seedB.status === 201, [seedA.data, seedB.data]);
  const upA = await upload(alice.token, hA + "/ra1");
  const recA = await rest("POST", "receipts", alice.token, [{ id: "ra1", household_id: hA, name: "ra1.png", type: "image/png", size: png.length, path: hA + "/ra1" }]);
  t("owner can upload a receipt file and record it", upA.ok && recA.status === 201, [upA.data, recA.data]);

  // ---- 1. two unrelated households ----
  const bobReadsA = await rest("GET", "entries", bob.token, null, "household_id=eq." + hA + "&select=id");
  t("1: Bob cannot read Alice's entries (empty result)", bobReadsA.ok && Array.isArray(bobReadsA.data) && bobReadsA.data.length === 0, bobReadsA.data);
  const bobAll = await rest("GET", "entries", bob.token, null, "select=id,household_id");
  t("1: Bob's unfiltered read returns only his household", bobAll.ok && bobAll.data.every(r => r.household_id === hB), bobAll.data);
  const bobWritesA = await rest("POST", "entries", bob.token, [Object.assign({ household_id: hA }, entry("bx", 5))]);
  t("1: Bob cannot insert into Alice's household", !bobWritesA.ok, bobWritesA.data);
  const bobUpdatesA = await rest("PATCH", "entries", bob.token, { body: { kind: "cash", amount: 1 } }, "household_id=eq." + hA + "&id=eq.a1", "return=representation");
  t("1: Bob cannot update Alice's entry (0 rows affected)", bobUpdatesA.ok ? bobUpdatesA.data.length === 0 : true, bobUpdatesA.data);
  const bobDeletesA = await rest("DELETE", "entries", bob.token, null, "household_id=eq." + hA + "&id=eq.a1", "return=representation");
  t("1: Bob cannot delete Alice's entry", bobDeletesA.ok ? bobDeletesA.data.length === 0 : true, bobDeletesA.data);
  const stillThere = await rest("GET", "entries", alice.token, null, "household_id=eq." + hA + "&id=eq.a1&select=id,body");
  t("1: Alice's entry is intact after Bob's attempts", stillThere.data.length === 1 && stillThere.data[0].body.amount === 100);
  const bobDl = await download(bob.token, hA + "/ra1");
  t("1: Bob cannot download Alice's receipt file", !bobDl.ok, bobDl.status);
  const bobUp = await upload(bob.token, hA + "/rbx");
  t("1: Bob cannot upload into Alice's storage folder", !bobUp.ok, bobUp.status);
  const bobRecs = await rest("GET", "receipts", bob.token, null, "household_id=eq." + hA + "&select=id");
  t("1: Bob cannot list Alice's receipt records", bobRecs.ok && bobRecs.data.length === 0);
  const bobMembers = await rpc("household_member_list", bob.token, { p_household: hA });
  t("1: Bob cannot list Alice's members", !bobMembers.ok || (Array.isArray(bobMembers.data) && bobMembers.data.length === 0), bobMembers.data);

  // ---- 2. viewer account (Carol, invited by Alice as viewer) ----
  const inv = await rest("POST", "invitations", alice.token, { household_id: hA, email: carol.email, role: "viewer" }, "select=token", "return=representation");
  t("owner can create an invitation", inv.status === 201 && inv.data[0].token, inv.data);
  const badAccept = await rpc("accept_invitation", dave.token, { p_token: inv.data[0].token });
  t("2: a different email cannot accept the invitation", !badAccept.ok, badAccept.data);
  const acc = await rpc("accept_invitation", carol.token, { p_token: inv.data[0].token });
  t("2: the invited email can accept", acc.ok && acc.data === hA, acc.data);
  const carolReads = await rest("GET", "entries", carol.token, null, "household_id=eq." + hA + "&select=id");
  t("2: viewer can read entries", carolReads.ok && carolReads.data.length === 1);
  const carolDl = await download(carol.token, hA + "/ra1");
  t("2: viewer can download receipts (export works)", carolDl.ok, carolDl.status);
  const carolWrite = await rest("POST", "entries", carol.token, [Object.assign({ household_id: hA }, entry("c1", 1))]);
  t("2: viewer cannot insert entries", !carolWrite.ok, carolWrite.data);
  const carolUpd = await rest("PATCH", "entries", carol.token, { body: { kind: "cash", amount: 2 } }, "household_id=eq." + hA + "&id=eq.a1", "return=representation");
  t("2: viewer cannot update entries", carolUpd.ok ? carolUpd.data.length === 0 : true, carolUpd.data);
  const carolUp = await upload(carol.token, hA + "/rc1");
  t("2: viewer cannot upload receipts", !carolUp.ok, carolUp.status);
  const carolDelRec = await rest("DELETE", "receipts", carol.token, null, "household_id=eq." + hA + "&id=eq.ra1", "return=representation");
  t("2: viewer cannot delete receipt records", carolDelRec.ok ? carolDelRec.data.length === 0 : true, carolDelRec.data);
  const carolInv = await rest("POST", "invitations", carol.token, { household_id: hA, email: dave.email, role: "member" });
  t("2: viewer cannot invite", !carolInv.ok, carolInv.data);
  const carolRename = await rest("PATCH", "households", carol.token, { name: "hijacked" }, "id=eq." + hA, "return=representation");
  t("2: viewer cannot rename the household", carolRename.ok ? carolRename.data.length === 0 : true, carolRename.data);

  // ---- 3. simultaneous edits from two devices (both as Alice; the version check is per row) ----
  const d1 = await rest("PATCH", "entries", alice.token, { body: { kind: "cash", amount: 150, bankRecord: true, date: "2026-03-01", org: "Food Bank", receiptIds: [] }, version: 2 }, "household_id=eq." + hA + "&id=eq.a1&version=eq.1", "return=representation");
  const d2 = await rest("PATCH", "entries", alice.token, { body: { kind: "cash", amount: 175, bankRecord: true, date: "2026-03-01", org: "Food Bank", receiptIds: [] }, version: 2 }, "household_id=eq." + hA + "&id=eq.a1&version=eq.1", "return=representation");
  t("3: first write with the expected version succeeds", d1.ok && d1.data.length === 1 && d1.data[0].version === 2, d1.data);
  t("3: second write with the stale version affects 0 rows (client keeps it as a conflict copy)", d2.ok && d2.data.length === 0, d2.data);
  const afterRace = await rest("GET", "entries", alice.token, null, "household_id=eq." + hA + "&id=eq.a1&select=body,version");
  t("3: server holds exactly one version of the entry", afterRace.data.length === 1 && afterRace.data[0].body.amount === 150 && afterRace.data[0].version === 2);

  // ---- 4. plan fields are not client-editable ----
  const planHack = await rest("PATCH", "households", alice.token, { plan_status: "active", plan_renews_at: "2099-01-01T00:00:00Z" }, "id=eq." + hA, "return=representation");
  t("4: owner cannot change plan fields from the client", !planHack.ok || planHack.data.length === 0, planHack.data);
  const rename = await rest("PATCH", "households", alice.token, { name: "Alice & co" }, "id=eq." + hA, "return=representation");
  t("4: owner can still rename", rename.ok && rename.data.length === 1 && rename.data[0].name === "Alice & co", rename.data);
  // canceled household → read-only (set via service key, as a billing webhook would)
  await api("PATCH", "/rest/v1/households?id=eq." + hA, { token: SERVICE, headers: { apikey: SERVICE, Prefer: "return=minimal" }, body: { plan_status: "canceled", canceled_at: new Date().toISOString() } });
  const canceledWrite = await rest("POST", "entries", alice.token, [Object.assign({ household_id: hA }, entry("a9", 9))]);
  const canceledRead = await rest("GET", "entries", alice.token, null, "household_id=eq." + hA + "&select=id");
  t("4: canceled household → owner can still read", canceledRead.ok && canceledRead.data.length === 1);
  t("4: canceled household → owner cannot add entries (retention = read-only)", !canceledWrite.ok, canceledWrite.data);
  await api("PATCH", "/rest/v1/households?id=eq." + hA, { token: SERVICE, headers: { apikey: SERVICE, Prefer: "return=minimal" }, body: { plan_status: "beta", canceled_at: null } });

  // ---- 5. migration retried: same entry ids → conflict, receipts keyed by source_id ----
  const mig1 = await rest("POST", "receipts", alice.token, [{ id: "m1", household_id: hA, name: "m.png", type: "image/png", size: 1, path: hA + "/m1", source_id: "local-1" }]);
  const mig2 = await rest("POST", "receipts", alice.token, [{ id: "m2", household_id: hA, name: "m.png", type: "image/png", size: 1, path: hA + "/m2", source_id: "local-1" }]);
  t("5: a second copy of the same local receipt is rejected (unique source_id per household)", mig1.status === 201 && !mig2.ok, mig2.data);
  const dupEntry = await rest("POST", "entries", alice.token, [Object.assign({ household_id: hA }, entry("a1", 100))]);
  t("5: re-inserting an already-migrated entry id is rejected, not duplicated", !dupEntry.ok, dupEntry.data);
  const priorLookup = await rest("GET", "receipts", alice.token, null, "household_id=eq." + hA + "&source_id=not.is.null&select=id,source_id");
  t("5: a retry can find previously migrated receipts by source id", priorLookup.ok && priorLookup.data.some(r => r.source_id === "local-1"));

  // ---- 6. member removed (Dave joins as member, then is removed) ----
  const inv2 = await rest("POST", "invitations", alice.token, { household_id: hA, email: dave.email, role: "member" }, "select=token", "return=representation");
  await rpc("accept_invitation", dave.token, { p_token: inv2.data[0].token });
  const daveWrite1 = await rest("POST", "entries", dave.token, [Object.assign({ household_id: hA }, entry("d1", 7))]);
  t("6: member can write before removal", daveWrite1.status === 201, daveWrite1.data);
  const rm = await rest("DELETE", "household_members", alice.token, null, "household_id=eq." + hA + "&user_id=eq." + dave.id, "return=representation");
  t("6: owner can remove a member", rm.ok && rm.data.length === 1, rm.data);
  const daveRead = await rest("GET", "entries", dave.token, null, "household_id=eq." + hA + "&select=id");
  const daveWrite2 = await rest("POST", "entries", dave.token, [Object.assign({ household_id: hA }, entry("d2", 8))]);
  const daveUpd = await rest("PATCH", "entries", dave.token, { body: { kind: "cash", amount: 0 } }, "household_id=eq." + hA + "&id=eq.d1", "return=representation");
  t("6: removed member reads nothing", daveRead.ok && daveRead.data.length === 0, daveRead.data);
  t("6: removed member cannot insert (a queued change would be rejected, not applied)", !daveWrite2.ok, daveWrite2.data);
  t("6: removed member cannot update their old entry", daveUpd.ok ? daveUpd.data.length === 0 : true, daveUpd.data);
  const daveDl = await download(dave.token, hA + "/ra1");
  t("6: removed member cannot download receipts", !daveDl.ok, daveDl.status);

  // ---- cleanup ----
  await api("DELETE", "/rest/v1/households?id=in.(" + hA + "," + hB + ")", { token: SERVICE, headers: { apikey: SERVICE } });
  await api("DELETE", "/storage/v1/object/receipts", { token: SERVICE, headers: { apikey: SERVICE }, body: { prefixes: [hA + "/ra1", hA + "/m1"] } }).catch(() => {});
  await cleanup();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})().catch(async e => { console.error("CRASH", e); await cleanup(); process.exit(1); });
