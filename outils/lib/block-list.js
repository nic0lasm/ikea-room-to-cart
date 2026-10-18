// Requêtes dont le planificateur n'a pas besoin (habillage du site, consentement, mesure d'audience, widgets, polices, médias).
const HOSTS = [
  "cdn.cookielaw.org",
  "geolocation.onetrust.com",
  "web-api.ikea.com",
  "favs.oneweb.ingka.com",
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.net",
  "facebook.com",
  "hotjar.com",
  "bing.com",
  "pinterest.com",
  "tiktok.com",
  "snapchat.com",
  "criteo.com",
  "adsrvr.org",
  "sentry.io",
  "datadoghq",
  "newrelic",
  "nr-data.net",
  "optimizely",
  "contentsquare",
  "clarity.ms",
  "mpeasylink",
  "mixpanel",
];
const PATHS = [
  "/global/assets/dwf/nav/",
  "/global/assets/dwf/lower-funnel-fragments/",
  "/global/assets/dwf/in-clude/",
  "/recommendations/",
  "/shoppingcart/agent",
  "/ingka-isx-billie-widget/",
  "/favs-agent/",
  "/experiment-fragment/",
  "/nudge/",
  "/loyalty/",
  "/content-rec/",
  "/marketing-tags/",
  "/cookieconsent/",
  "/search/v2/",
  "/global/assets/fonts/",
];
const TYPES = new Set(["font", "media"]);
function shouldBlock(url, type) {
  if (TYPES.has(type)) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h) || u.hostname.includes(h)))
    return true;
  if (u.hostname === "www.ikea.com" && PATHS.some((p) => u.pathname.includes(p))) return true;
  return false;
}
module.exports = { shouldBlock, HOSTS, PATHS, TYPES };
