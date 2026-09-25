// A fake Supabase client for tests, usable from Node (require) and the browser (script tag).
// Models the query-builder / auth / storage / realtime subset that js/cloud.js uses, with knobs to
// hold responses (in-flight requests), fail writes, deny writes (revoked access), corrupt downloads,
// switch the signed-in user, and fire realtime change events.
(function (root) {
  function createFake() {
    const tables = { entries: new Map(), receipts: new Map(), households: new Map(), household_members: new Map(), invitations: new Map() };
    const keyOf = (name, r) => name === "household_members" ? r.household_id + "|" + r.user_id : r.id;
    const objects = new Map();
    const F = { tables, objects, _failNext: 0, _deny: false, _corrupt: false, session: null, _authCb: null, _gate: null, _channels: [] };
    F.failNext = n => { F._failNext = n; };
    F.denyWrites = b => { F._deny = !!b; };
    F.corrupt = b => { F._corrupt = !!b; };
    F.holdWrites = () => { let release; F._gate = new Promise(r => { release = r; }); return () => { const g = F._gate; F._gate = null; release(); return g; }; };
    F.signIn = (id, email) => { F.session = { user: { id, email } }; if (F._authCb) F._authCb("SIGNED_IN", F.session); };
    F.signOut = () => { F.session = null; if (F._authCb) F._authCb("SIGNED_OUT", null); };
    F.triggerRealtime = table => { F._channels.forEach(ch => ch.handlers.forEach(h => { if (!h.filter || h.filter.table === table) h.cb({ table }); })); };
    F.seedHousehold = (id, name, members) => { tables.households.set(id, { id, name, plan: "household", plan_status: "beta", created_at: new Date().toISOString() }); (members || []).forEach(([user_id, role]) => tables.household_members.set(id + "|" + user_id, { household_id: id, user_id, role, joined_at: new Date().toISOString() })); };
    F.seedEntry = (household_id, id, body, version) => tables.entries.set(id, { id, household_id, body: Object.assign({}, body), version: version || 1, updated_at: new Date().toISOString() });

    function builder(name) {
      const q = { _op: null, _payload: null, _filters: [], _select: null, _single: false };
      const chain = {
        select(cols) { if (!q._op) q._op = "select"; q._select = cols; return chain; },
        insert(rows) { q._op = "insert"; q._payload = rows; return chain; },
        update(patch) { q._op = "update"; q._payload = patch; return chain; },
        delete() { q._op = "delete"; return chain; },
        eq(col, v) { q._filters.push({ col, v, m: "eq" }); return chain; },
        in(col, vs) { q._filters.push({ col, v: vs, m: "in" }); return chain; },
        not(col, op, v) { q._filters.push({ col, v, m: "not-" + op }); return chain; },
        is(col, v) { q._filters.push({ col, v, m: "is" }); return chain; },
        order() { return chain; },
        maybeSingle() { q._single = true; return chain; }, single() { q._single = true; return chain; },
        then(res, rej) { const run = () => exec(); const p = (F._gate && ["insert", "update", "delete"].includes(q._op)) ? F._gate.then(run) : Promise.resolve().then(run); return p.then(res, rej); }
      };
      const match = row => q._filters.every(f => f.m === "in" ? f.v.includes(row[f.col]) : f.m === "is" ? row[f.col] == f.v : f.m === "not-is" ? row[f.col] != f.v : row[f.col] === f.v);
      const embed = row => { if (name === "household_members" && /households\(/.test(q._select || "")) return Object.assign({}, row, { households: tables.households.get(row.household_id) || null }); return Object.assign({}, row); };
      function exec() {
        const tbl = tables[name]; if (!tbl) return { data: [], error: null };
        const write = ["insert", "update", "delete"].includes(q._op);
        if (write && F._failNext > 0) { F._failNext--; return { data: null, error: { message: "simulated network failure" } }; }
        if (write && F._deny) return { data: null, error: { code: "42501", status: 403, message: "new row violates row-level security policy" } };
        if (q._op === "select") { const rows = [...tbl.values()].filter(match).map(embed); return { data: q._single ? (rows[0] || null) : rows, error: null }; }
        if (q._op === "insert") {
          const rows = Array.isArray(q._payload) ? q._payload : [q._payload];
          for (const r of rows) if (tbl.has(keyOf(name, r))) return { data: null, error: { code: "23505", message: "duplicate key" } };
          if (name === "receipts") for (const r of rows) if (r.source_id && [...tbl.values()].some(x => x.household_id === r.household_id && x.source_id === r.source_id)) return { data: null, error: { code: "23505", message: "duplicate source_id" } };
          rows.forEach(r => tbl.set(keyOf(name, r), Object.assign({ created_at: new Date().toISOString() }, r)));
          return { data: q._single ? { version: rows[0].version, token: rows[0].token } : rows.map(r => ({ version: r.version, token: r.token })), error: null };
        }
        if (q._op === "update") { const rows = [...tbl.values()].filter(match); rows.forEach(r => Object.assign(r, q._payload)); return { data: rows.map(r => ({ version: r.version })), error: null }; }
        if (q._op === "delete") { [...tbl.values()].filter(match).forEach(r => tbl.delete(keyOf(name, r))); return { data: null, error: null }; }
      }
      return chain;
    }
    F.client = {
      auth: {
        getSession: async () => ({ data: { session: F.session } }),
        onAuthStateChange(cb) { F._authCb = cb; },
        signOut: async () => { F.signOut(); },
        signInWithOtp: async () => ({ error: null })
      },
      from: builder,
      rpc: async (fn, args) => {
        if (fn === "create_household") { const id = "hh-" + Math.random().toString(36).slice(2, 8); F.seedHousehold(id, args.p_name, [[F.session.user.id, "owner"]]); return { data: id, error: null }; }
        if (fn === "household_member_list") return { data: [...tables.household_members.values()].filter(m => m.household_id === args.p_household).map(m => ({ user_id: m.user_id, email: m.user_id + "@example.test", role: m.role, joined_at: m.joined_at })), error: null };
        if (fn === "accept_invitation") return { data: null, error: { message: "not modelled" } };
        return { data: null, error: null };
      },
      channel() { const ch = { handlers: [], on(_t, filter, cb) { ch.handlers.push({ filter, cb }); return ch; }, subscribe() { F._channels.push(ch); return ch; } }; return ch; },
      removeChannel: async ch => { F._channels = F._channels.filter(c => c !== ch); },
      storage: { from() { return {
        createSignedUrls: async paths => ({ data: paths.map(p => ({ signedUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" })), error: null }),
        upload: async (p, blob) => { if (objects.has(p)) return { error: { message: "exists" } }; objects.set(p, blob); return { error: null }; },
        remove: async ps => { ps.forEach(p => objects.delete(p)); return {}; },
        download: async p => { const b = objects.get(p); if (!b) return { data: null, error: { message: "not found" } }; return { data: F._corrupt ? new Blob(["corrupted"]) : b, error: null }; }
      }; } }
    };
    return F;
  }
  root.FakeSupabase = { createFake };
  if (typeof module !== "undefined" && module.exports) module.exports = { createFake };
})(typeof globalThis !== "undefined" ? globalThis : this);
