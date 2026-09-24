// Resolve the origin that serves `/embed/<token>`.
//
// Captured ONCE at module load: in the IIFE loader bundle this runs during the
// script's synchronous execution, so `document.currentScript` is the loader
// `<script>` tag — even when the widget is later created in an async callback
// where `currentScript` is null. Capturing only makes sense
// when the script is served by the Lookalike app itself (self-hosted
// `/widget/v1.js`); when it comes off a public CDN (the npm-package snippet),
// the script origin is the CDN, not the service — skip it and fall through to
// the default.
const CDN_HOSTS = /(^|\.)(unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|esm\.sh|jspm\.io)$/i

let captured = ""
if (typeof document !== "undefined") {
  const cs = document.currentScript as HTMLScriptElement | null
  if (cs?.src) {
    try {
      const u = new URL(cs.src)
      // Only our deployment's loader path implies a service origin. A bundled
      // customer app (or a copied npm loader) can also be a classic script.
      if (/^\/widget\/v\d+\.js$/.test(u.pathname) && !CDN_HOSTS.test(u.hostname)) captured = u.origin
    } catch {
      /* ignore */
    }
  }
}

// npm/ESM consumers have no <script> tag to capture from (currentScript is
// null at module load), and falling back to the embedding page's own origin
// would aim every /embed request at the customer's domain —
// the widget would silently never render. Default to the hosted service;
// self-hosted and dev setups pass `origin` explicitly.
const DEFAULT_ORIGIN = "https://lookalike.com"

/** The origin serving the widget, normalized (no trailing slash). */
export function scriptOrigin(explicit?: string): string {
  if (explicit) return explicit.replace(/\/$/, "")
  if (captured) return captured
  return DEFAULT_ORIGIN
}
