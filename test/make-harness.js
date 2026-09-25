// Generates test/cloud-harness.html: the real app (index.html) wired to the fake Supabase client,
// so the form → app state → queue → server → refreshed UI flow can be driven in a browser.
// Run: node test/make-harness.js   then serve the site and open /test/cloud-harness.html
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
let h = fs.readFileSync(path.join(root, "index.html"), "utf8");
h = h.replace(/href="css\//g, 'href="../css/').replace(/src="js\//g, 'src="../js/');
h = h.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>\s*/, "");
h = h.replace('<script src="../js/config.js"></script>', `<script src="fake-supabase.js"></script>
<script>
  // Test harness: a fake Supabase client stands in for the real one. Nothing leaves this page.
  window.FAKE = window.FakeSupabase.createFake();
  window.supabase = { createClient: () => window.FAKE.client };
  window.SITE_CONFIG = { cloud: { url: "https://fake.supabase.co", anonKey: "fake" }, plans: { betaFree: true, intendedPrice: "$19/year" }, support: { enabled: false, links: [] } };
  // The fake server lives in memory: a test that reloads the page re-seeds it from sessionStorage.
  try {
    const seed = JSON.parse(sessionStorage.getItem("gl_cloud_seed") || "null");
    if (seed) {
      window.FAKE.seedHousehold(seed.hh, seed.name || "Alice household", [[seed.user || "user-alice", "owner"]]);
      (seed.entries || []).forEach(r => window.FAKE.tables.entries.set(r.id, r));
      window.FAKE.session = { user: { id: seed.user || "user-alice", email: (seed.user || "user-alice") + "@example.test" } };
      sessionStorage.removeItem("gl_cloud_seed");
    }
  } catch (e) {}
</script>`);
h = h.replace("<title>Giving Ledger</title>", "<title>Giving Ledger — cloud test harness</title>");
fs.writeFileSync(path.join(root, "test/cloud-harness.html"), h);
console.log("wrote test/cloud-harness.html");
