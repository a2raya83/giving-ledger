// Site configuration.
window.SITE_CONFIG = {
  // Cloud mode: accounts, household ledgers, private receipt storage, live sync.
  // Leave both empty to run in device-only mode. See README → "Accounts and household ledgers".
  cloud: {
    url: "",       // e.g. "https://abcdefghijklmnop.supabase.co"
    anonKey: ""    // the project's anon (public) key — safe to ship; row-level security does the protecting
  },

  // Optional "support this site" ask. Set enabled to true once you've added at least one link.
  // Links open in a new tab. Nothing is gated behind it.
  support: {
    enabled: false,
    heading: "Support Giving Ledger",
    message: "Giving Ledger is free and stores nothing on a server. If it saved you time at tax season, a tip of any size keeps it online — entirely optional.",
    footer: "Free to use. If it helped, a small tip keeps it running.",
    links: [
      // { label: "Buy me a coffee", url: "https://buymeacoffee.com/yourname" },
      // { label: "Ko-fi", url: "https://ko-fi.com/yourname" },
      // { label: "PayPal", url: "https://paypal.me/yourname" }
    ]
  }
};
