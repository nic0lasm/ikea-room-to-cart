// Fiches produits : ikea.fr (nom, type, coloris, dimensions) et catalogue 3D du planificateur, avec recherche d'équivalents.
"use strict";
const fs = require("fs"),
  path = require("path"),
  os = require("os");
const K = require("./kreativ.js");
// cache local (hors du dépôt) : IKEA_CACHE_DIR, sinon <tmp>/ikea-planner-cache
const CACHE_DIR = process.env.IKEA_CACHE_DIR || path.join(os.tmpdir(), "ikea-planner-cache");
const CACHE = path.join(CACHE_DIR, "ikeafr.json");
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
} catch (e) {}
const save = () => {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const t = CACHE + "." + process.pid;
    fs.writeFileSync(t, JSON.stringify(cache, null, 1));
    fs.renameSync(t, CACHE);
  } catch (e) {}
};
const pending = new Map();
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// fiche ikea.fr d'un article (API de recherche publique, comme liste-achat.js)
function infoFr(no) {
  no = K.no8(no);
  if (cache[no] && !cache[no].missing) return Promise.resolve(cache[no]);
  if (!pending.has(no))
    pending.set(
      no,
      infoFr0(no).finally(() => pending.delete(no)),
    );
  return pending.get(no);
}
async function infoFr0(no) {
  const r = await K.fetchRetry(
    `https://sik.search.blue.cdtapps.com/${K.MARKET}/search-result-page?q=${no}&size=10&types=PRODUCT`,
  );
  if (!r.ok) throw new Error(`recherche ikea.fr ${no} -> ${r.status}`);
  const j = JSON.parse(r.text);
  for (const i of j.searchResultPage.products.main.items || []) {
    const p = i.product;
    if (!p) continue;
    for (const v of [p, ...((p.gprDescription && p.gprDescription.variants) || [])])
      if (v.itemNo === no) {
        const d = {
          no,
          name: v.name || p.name,
          type: v.typeName || p.typeName,
          size: v.itemMeasureReferenceText || p.itemMeasureReferenceText || "",
          design: decodeURIComponent((v.pipUrl || p.pipUrl || "").split("/p/")[1] || "")
            .replace(/-s?\d{8}\/?$/, "")
            .split("-")
            .slice(1)
            .join(" "),
        };
        // le pipUrl contient nom-type-coloris : on retire le nom et le type
        const t = norm(d.type).split(" ").length;
        d.design = d.design.split(" ").slice(t).join(" ");
        cache[no] = d;
        save();
        return d;
      }
  }
  cache[no] = { no, name: "", type: "", size: "", design: "", missing: true };
  save();
  return cache[no];
}
// "60x40x64 cm" -> {w,d,h} (cm) ; 2 nombres -> {w,d}
function parseSize(s) {
  const m = String(s || "")
    .replace(/,/g, ".")
    .match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?/);
  if (!m) return null;
  return { w: +m[1], d: +m[2], h: m[3] ? +m[3] : null };
}
// meilleur équivalent 3D : mêmes nom/type/coloris/dimensions autant que possible
async function equivalent(want, token, queries) {
  const seen = new Map();
  const qs = [...new Set(queries.filter(Boolean).map((q) => q.replace(/\s+/g, " ").trim()))];
  const res = await Promise.all(qs.map((q) => K.search(q, token).catch(() => [])));
  for (const L of res)
    for (const f of L)
      if (K.has3d(f) && !seen.has(f.localItemNumber) && (!want.accept || want.accept(f)))
        seen.set(f.localItemNumber, f);
  const W = want.dims || {};
  const score = (f) => {
    const d = K.dims(f);
    let s = 0;
    if (W.w != null) s += Math.abs(d.w - W.w);
    if (W.d != null) s += Math.abs(d.d - W.d);
    if (W.h != null) s += Math.abs(d.h - W.h);
    if (want.name && !norm(f.name).split(" ").includes(norm(want.name))) s += 40;
    if (want.type && !norm(f.typeName).includes(norm(want.type))) s += 20;
    if (want.typeExact && norm(f.typeName) === norm(want.typeExact)) s -= 8;
    if (want.design && norm(f.validDesign) !== norm(want.design)) {
      s += 15;
      if (tone(f.validDesign) !== tone(want.design)) s += 5;
    }
    return s;
  };
  const all = [...seen.values()].map((f) => ({ f, s: score(f) })).sort((a, b) => a.s - b.s);
  return all[0]
    ? {
        ...all[0],
        candidates: all
          .slice(0, 5)
          .map(
            (c) =>
              `${c.f.localItemNumber} ${c.f.name} ${c.f.typeName} ${c.f.validDesign} ${fmtD(K.dims(c.f))} (score ${c.s.toFixed(1)})`,
          ),
      }
    : null;
}
// clair / foncé, pour départager deux coloris différents de celui demandé
const tone = (t) => (/noir|brun|fonce|anthracite|noyer/.test(norm(t)) ? "fonce" : "clair");
const fmtD = (d) => `${d.w.toFixed(0)}×${d.d.toFixed(0)}×${d.h.toFixed(0)}`;
module.exports = { CACHE_DIR, infoFr, parseSize, equivalent, norm, fmtD };
