// lib/teintes.js : contrôle des références IKEA d'une maquette AVANT toute construction (planificateur ou panier).
// Générique : aucune donnée propre à un projet. La cible vient de PROJET (dans la maquette) ou des options.
//
//   const T = require('./lib/teintes.js');
//   await T.lintRefs(items, 'V', { teinte: 'chene', quincaillerie: 'noir', exclure: ['METOD'] })
//        -> { erreurs:[{entree,ref,msg}], avertissements:[…], lignes:[…], projet }
//   await T.choisir3D('102.473.79', { teinte: 'chene-blanchi', dims: {w,d,h} })
//        -> { furnitureId, itemNo3d, raison, teinte3d, avertissement, fiche3d } (furnitureId null si rien)
//   await T.fiche('102.473.79') -> fiche ikea.fr + page produit + catalogue 3D (cache 24 h pour les prix)
//   T.teinteDe('teinté blanc motif chêne') -> 'chene-teinte-blanc' ; T.conforme(t, cible) -> 'ok'|'voisine'|'non'
//   T.lireProjet(html) -> objet PROJET de la maquette ou null ; T.selection(items, version) -> entrées commandées
//
// Sources (sans compte, sans panier serveur) :
//   - recherche ikea.fr  https://sik.search.blue.cdtapps.com/fr/fr/search-result-page?q=<n°>  (nom, type, coloris, prix, vendable)
//   - page produit       pipUrl : « Quantité/paquet » (vendu par N) et « Bon à savoir » (compléments vendus séparément)
//   - catalogue 3D       https://api.home-design.ikea.com/fr/fr/ideas/sugarcube/api/furniture/?local_item_number=… et /furniture/search/
// Cache : ../cache/refs.json (prix et recherches 24 h, catalogue 3D 7 j, pages produit 30 j). IKEA_REFS_OFFLINE=1 : cache seul.
"use strict";
const fs = require("fs"),
  path = require("path");

const MARKET = process.env.IKEA_MARKET || "fr/fr";
const SIK = `https://sik.search.blue.cdtapps.com/${MARKET}/search-result-page`;
const SC = `https://api.home-design.ikea.com/${MARKET}/ideas/sugarcube/api`;
const GEO = "3d,2d_wall,wall_placeable";
const CACHE_FILE =
  process.env.IKEA_REFS_CACHE ||
  path.join(
    process.env.IKEA_CACHE_DIR || path.join(require("os").tmpdir(), "ikea-planner-cache"),
    "refs.json",
  );
const H = 3600e3,
  TTL = { fr: 24 * H, recherche: 24 * H, d3: 7 * 24 * H, pip: 30 * 24 * H };
const OFFLINE = process.env.IKEA_REFS_OFFLINE === "1";

// ---------------------------------------------------------------- utilitaires
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const no8 = (n) => String(n).replace(/\D/g, "");
const fmtNo = (n) => no8(n).replace(/^(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3");
const REF_OK = /^(\d{3}\.\d{3}\.\d{2}|\d{8})$/; // forme acceptée par le lien panier (8 chiffres)
const eur = (x) => (x == null ? "?" : x.toFixed(2).replace(".", ",") + " €");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (i < list.length) {
        const k = i++;
        out[k] = await fn(list[k], k);
      }
    }),
  );
  return out;
}

const stats = { requetes: 0, cache: 0 };
async function get(url, { json = true, headers = {} } = {}) {
  if (OFFLINE) throw new Error("hors ligne (IKEA_REFS_OFFLINE=1)");
  for (let k = 0; ; k++) {
    stats.requetes++;
    try {
      const r = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: json ? "application/json" : "text/html",
          origin: "https://www.ikea.com",
          referer: "https://www.ikea.com/",
          ...headers,
        },
        signal: AbortSignal.timeout(25000),
      });
      if (r.status >= 500 || r.status === 429) throw new Error("HTTP " + r.status);
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status} ${url}`);
        e.fatal = true;
        throw e;
      }
      return json ? await r.json() : await r.text();
    } catch (e) {
      if (e.fatal || k >= 2) throw e;
      await sleep(800 * (k + 1));
    }
  }
}

// ---------------------------------------------------------------- cache (fusion à l'écriture, écriture atomique)
let C = null;
function loadCache() {
  if (C) return C;
  try {
    C = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    C = {};
  }
  C.refs ||= {};
  C.recherches ||= {};
  return C;
}
const frais = (e, ttl) => e && e.t && Date.now() - Date.parse(e.t) < ttl;
function saveCache() {
  if (!C) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    let disk = {};
    try {
      disk = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    } catch {}
    const plusRecent = (a, b) =>
      !a ? b : !b ? a : Date.parse(a.t || 0) >= Date.parse(b.t || 0) ? a : b;
    const refs = { ...(disk.refs || {}) };
    for (const [no, r] of Object.entries(C.refs)) {
      const d = refs[no] || {};
      refs[no] = {
        fr: plusRecent(r.fr, d.fr),
        pip: plusRecent(r.pip, d.pip),
        d3: plusRecent(r.d3, d.d3),
      };
    }
    const rech = { ...(disk.recherches || {}) };
    for (const [k, v] of Object.entries(C.recherches)) rech[k] = plusRecent(v, rech[k]);
    for (const [k, v] of Object.entries(rech)) if (!frais(v, 7 * 24 * H)) delete rech[k]; // purge
    const out = {
      maj: new Date().toISOString(),
      ttl: { prix_h: 24, recherches_h: 24, catalogue3d_j: 7, pages_produit_j: 30 },
      refs,
      recherches: rech,
    };
    const tmp = CACHE_FILE + "." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, CACHE_FILE);
    C = out;
  } catch (e) {
    console.error("cache non écrit : " + e.message);
  }
}

// ---------------------------------------------------------------- teintes (table générique, à étendre)
// ordre important : la première expression qui correspond l'emporte. Testée sur le libellé « validDesignText » d'ikea.fr.
const TEINTES = [
  ["chene-blanchi", /chene blanchi|blanchi.*chene/],
  [
    "chene-teinte-blanc",
    /teinte blanc.*chene|chene.*teinte blanc|blanc motif chene|motif chene blanc|chene.*blanc|blanc.*chene/,
  ],
  ["chene-fonce", /(brun|fonce|noir|gris).*chene|chene.*(teint|brun|fonce|noir)/],
  ["noyer", /noyer/],
  ["frene", /frene/],
  ["bouleau", /bouleau/],
  ["hetre", /hetre/],
  ["pin", /\bpin\b/],
  ["bambou", /bambou/],
  ["acacia", /acacia/],
  ["teck", /teck/],
  ["eucalyptus", /eucalyptus/],
  ["peuplier", /peuplier/],
  ["rotin", /rotin|osier|jonc|tresse/],
  ["chene", /chene/],
  ["effet-bois", /effet bois|motif bois/],
  ["brun-noir", /brun noir|noir brun/],
  ["noir", /\bnoir\b/],
  ["blanc", /\bblanc\b|blanc casse/],
  ["gris-fonce", /gris fonce|anthracite/],
  ["gris", /\bgris\b/],
  ["beige", /beige|naturel|lin/],
  ["brun", /\bbrun\b|marron/],
  ["acier", /acier inoxydable|inox|galvanise|couleur argent|aluminium|argent/],
  ["laiton", /laiton|dore|or\b/],
  ["vert", /\bvert/],
  ["bleu", /\bbleu/],
  ["rouge", /\brouge|rose|terracotta/],
  ["jaune", /\bjaune/],
  ["transparent", /transparent|verre/],
];
const ALIAS = {
  "chene-naturel": "chene",
  "plaque-chene": "chene",
  "motif-chene": "chene",
  "effet-chene": "chene",
  "chene-clair": "chene",
  oak: "chene",
  blanchi: "chene-blanchi",
  "white-stained-oak": "chene-blanchi",
  "noir-brun": "brun-noir",
  black: "noir",
  white: "blanc",
  anthracite: "gris-fonce",
};
// cible -> teintes acceptées sans réserve / voisines (avertissement)
const COMPAT = {
  chene: { ok: ["chene"], voisine: ["effet-bois"] },
  "chene-blanchi": { ok: ["chene-blanchi"], voisine: ["chene-teinte-blanc"] },
  "chene-teinte-blanc": { ok: ["chene-teinte-blanc"], voisine: ["chene-blanchi"] },
  noir: { ok: ["noir", "brun-noir"], voisine: ["gris-fonce"] },
  "brun-noir": { ok: ["brun-noir", "noir"], voisine: ["brun"] },
  blanc: { ok: ["blanc"], voisine: ["beige"] },
  "gris-fonce": { ok: ["gris-fonce"], voisine: ["noir", "gris"] },
};
// mots à ajouter aux recherches pour trouver une variante dans la teinte voulue
const MOTS = {
  chene: "chêne",
  "chene-blanchi": "effet chêne blanchi",
  "chene-teinte-blanc": "teinté blanc chêne",
  "chene-fonce": "chêne teinté brun",
  "brun-noir": "brun noir",
  "gris-fonce": "gris foncé",
  "effet-bois": "effet bois",
};
const canon = (t) => {
  if (!t) return null;
  const k = norm(t).replace(/ /g, "-");
  return ALIAS[k] || k;
};
function teinteDe(design) {
  const s = norm(String(design || "").split("/")[0]); // combinaison « structure/façade » : la 1re partie (structure) décide
  if (!s) return null;
  for (const [k, re] of TEINTES) if (re.test(s)) return k;
  return "autre:" + s;
}
function conforme(t, cible) {
  cible = canon(cible);
  if (!cible || !t) return "na";
  const c = COMPAT[cible] || { ok: [cible], voisine: [] };
  return c.ok.includes(t) ? "ok" : c.voisine.includes(t) ? "voisine" : "non";
}
// combinaison « structure/façade » : 'mixte' si la structure n'est pas conforme mais une autre partie (façades) l'est
function conformeDesign(design, cible) {
  const c0 = conforme(teinteDe(design), cible);
  if (c0 !== "non") return c0;
  const parts = String(design || "")
    .split("/")
    .slice(1)
    .map((x) => conforme(teinteDe(x), cible));
  return parts.includes("ok") || parts.includes("voisine") ? "mixte" : "non";
}
// rôle d'un article d'après son type : quelle cible de teinte s'applique
const ROLES = [
  ["quincaillerie", /bouton|poignee|\bpied|pieds|roulette/],
  [
    "technique",
    /charniere|glissiere|rail|fixation|support|piece de raccord|raccord|vis\b|cheville|amortisseur|butee|transformateur|cable|telecommande|interrupteur|passerelle|ampoule|baguette lum|eclairage|spot|multiprise|rallonge|prise|capteur|variateur|serre cable|range cable|organiseur|separateur|insert|kit/,
  ],
  [
    "textile",
    /canape|convertible|fauteuil|chauffeuse|housse|coussin|tapis|matelas|rideau|plaid|couette|oreiller|drap|chaise|tabouret|pouf|repose pied/,
  ],
  [
    "deco",
    /lampe|lampadaire|suspension|applique|plante|cache pot|cadre|miroir|boite|corbeille|panier|horloge|vase|bougie/,
  ],
];
// composants d'un meuble : pas d'objet 3D à part (le meuble principal les représente)
const COMPOSANT =
  /^(porte|face|facade|tablette|tiroir|structure tiroir|panneau|plinthe|insert|separateur|tringle|socle|pied|bouton|poignee|charniere|glissiere|rail|cable|transformateur|baguette|eclairage)/;
const estComposant = (f) => COMPOSANT.test(norm(f.type || ""));
const TON_FONCE = /noir|brun|gris fonce|anthracite|noyer|chene fonce|fonce/;
const ton = (t) => (TON_FONCE.test(String(t || "").replace(/-/g, " ")) ? "fonce" : "clair");
const roleDe = (f) => {
  const s = norm(`${f.type || ""}`);
  for (const [k, re] of ROLES) if (re.test(s)) return k;
  return "meuble";
};
const cibleDe = (role, projet) =>
  role === "meuble"
    ? projet.teinte
    : role === "quincaillerie"
      ? projet.quincaillerie
      : role === "textile"
        ? projet.textile
        : null;

// ---------------------------------------------------------------- dimensions
function parseSize(s) {
  const m = String(s || "")
    .replace(/,/g, ".")
    .match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?\s*cm/);
  return m ? [m[1], m[2], m[3]].filter(Boolean).map(Number) : null;
}
// écart entre deux jeux de dimensions (ordre libre : « Porte 60x64 » = largeur × hauteur)
function ecartDims(a, b) {
  if (!a || !b || !a.length || !b.length) return 50;
  const pool2 = [...b];
  let s = 0;
  for (const x of a) {
    let bi = 0;
    for (let i = 1; i < pool2.length; i++)
      if (Math.abs(pool2[i] - x) < Math.abs(pool2[bi] - x)) bi = i;
    if (!pool2.length) {
      s += 50;
      continue;
    }
    s += Math.abs(pool2[bi] - x);
    pool2.splice(bi, 1);
  }
  return s;
}
const dims3d = (f) =>
  [(f.maxX - f.minX) * 100, (f.maxZ - f.minZ) * 100, (f.maxY - f.minY) * 100].map(
    (v) => Math.round(v * 10) / 10,
  );
const dimsArr = (d) => (Array.isArray(d) ? d : d ? [d.w, d.d, d.h].filter((v) => v != null) : null);

// ---------------------------------------------------------------- fiches ikea.fr (recherche publique)
const fromSik = (v, p = {}) => ({
  no: v.itemNo,
  name: v.name || p.name,
  type: v.typeName || p.typeName,
  design: v.validDesignText || "",
  size: v.itemMeasureReferenceText || "",
  price: v.salesPrice ? v.salesPrice.numeral : null,
  prevPrice:
    v.salesPrice && v.salesPrice.previous
      ? Number(v.salesPrice.previous.wholeNumber + "." + (v.salesPrice.previous.decimals || "0"))
      : null,
  tags: (v.salesPrice && v.salesPrice.tags) || [],
  sellable: !!v.onlineSellable,
  lastChance: !!v.lastChance,
  url: v.pipUrl,
  itemType: v.itemType || p.itemType,
});
const variantes = (j) =>
  (
    (j.searchResultPage && j.searchResultPage.products && j.searchResultPage.products.main.items) ||
    []
  )
    .map((i) => i.product)
    .filter(Boolean)
    .flatMap((p) => [
      fromSik(p),
      ...((p.gprDescription && p.gprDescription.variants) || []).map((v) => fromSik(v, p)),
    ]);
async function rechercheFr(q, size = 48) {
  const c = loadCache(),
    k = "fr:" + q;
  if (frais(c.recherches[k], TTL.recherche) || (OFFLINE && c.recherches[k])) {
    stats.cache++;
    return c.recherches[k].res;
  }
  const res = variantes(await get(`${SIK}?q=${encodeURIComponent(q)}&size=${size}&types=PRODUCT`));
  c.recherches[k] = { t: new Date().toISOString(), res };
  return res;
}
async function ficheFr(no) {
  const c = loadCache(),
    e = (c.refs[no] ||= {});
  if (frais(e.fr, TTL.fr) || (OFFLINE && e.fr)) {
    stats.cache++;
    return e.fr;
  }
  const all = variantes(await get(`${SIK}?q=${no}&size=10&types=PRODUCT`));
  const v = all.find((x) => x.no === no);
  e.fr = { t: new Date().toISOString(), ...(v || { no, absent: true }) };
  // les variantes reçues au passage sont des fiches complètes : on les garde (évite des requêtes pour les alternatives)
  for (const x of all)
    if (x.no !== no && x.price != null) {
      const ee = (c.refs[x.no] ||= {});
      if (!frais(ee.fr, TTL.fr)) ee.fr = { t: e.fr.t, ...x };
    }
  return e.fr;
}
// page produit : vendu par N, « Bon à savoir »
async function fichePip(no, url) {
  const c = loadCache(),
    e = (c.refs[no] ||= {});
  if ((frais(e.pip, TTL.pip) && e.pip.v === 2) || (OFFLINE && e.pip)) {
    stats.cache++;
    return e.pip;
  }
  if (!url) return null;
  const h = await get(url, { json: false });
  let pack = 1;
  const m =
    h.match(/\{"measure":"(\d+)\s*pi[eè]ces?","name":"[^"]*"\s*,\s*"type":"00061"/) ||
    h.match(/"subscriptLabel":"\/(\d+)\s*pi[eè]ces?"/);
  if (m) pack = +m[1];
  let gtk = [];
  const g = h.match(/"goodToKnow":(\[.*?\])\}/);
  if (g)
    try {
      gtk = JSON.parse(g[1])
        .filter((x) => !/^Other information$/.test(x.name))
        .map((x) => ({ k: x.name, t: x.text }));
    } catch {}
  const colis = (h.match(/"numberOfPackages":(\d+)/) || [])[1];
  // combinaison (SPR) : articles inclus (« Ce produit est composé de… »), quantité en articles commandables
  const composants = [];
  const seenC = new Set();
  for (const m of h.matchAll(
    /\{"itemNo":"(\d{8})","visibleItemNo":"[^"]*","name":"([^"]*)","type":"ART","typeName":"([^"]*)","quantity":(\d+)/g,
  ))
    if (m[1] !== no && !seenC.has(m[1])) {
      seenC.add(m[1]);
      composants.push({ no: m[1], name: m[2], type: m[3], q: +m[4] });
    }
  e.pip = {
    v: 2,
    t: new Date().toISOString(),
    pack,
    gtk,
    colis: colis ? +colis : null,
    composants: /whats-included/.test(h) ? composants : [],
  };
  return e.pip;
}
// catalogue 3D du planificateur, par lots de 20
async function fiches3d(nos) {
  const c = loadCache(),
    out = {},
    todo = [];
  for (const no of nos) {
    const e = (c.refs[no] ||= {});
    if (frais(e.d3, TTL.d3) || (OFFLINE && e.d3)) {
      stats.cache++;
      out[no] = e.d3;
    } else todo.push(no);
  }
  for (let i = 0; i < todo.length; i += 20) {
    const lot = todo.slice(i, i + 20);
    const j = await get(
      `${SC}/furniture/?local_item_number=${lot.join(",")}&geometry_type=${GEO}&material_mode=true`,
    );
    const got = {};
    for (const f of Array.isArray(j) ? j : Object.values(j || {}))
      if (f && f.localItemNumber) got[f.localItemNumber] = f;
    const t = new Date().toISOString();
    for (const no of lot) {
      const f = got[no];
      c.refs[no].d3 = f ? { t, present: true, ...mini3d(f) } : { t, present: false };
      out[no] = c.refs[no].d3;
    }
  }
  return out;
}
const mini3d = (f) => ({
  id: f.id,
  no: f.localItemNumber,
  name: f.name,
  type: f.typeName,
  design: f.validDesign,
  dims: dims3d(f),
  size: f.measureReference && f.measureReference.metric,
  geo: f.geometryTypes || [f.geometryType],
  dispo: f.isAvailable !== false && f.availableInRegion !== false,
});
async function recherche3d(q) {
  const c = loadCache(),
    k = "3d:" + q;
  if (frais(c.recherches[k], TTL.recherche) || (OFFLINE && c.recherches[k])) {
    stats.cache++;
    return c.recherches[k].res;
  }
  const j = await get(
    `${SC}/furniture/search/?q=${encodeURIComponent(q)}&region=${encodeURIComponent(MARKET)}&size=48&geometry_type=${GEO}&sort=RELEVANCE&material_mode=true`,
  );
  const res = (Array.isArray(j) ? j : j.results || [])
    .filter((f) => f && f.localItemNumber)
    .map(mini3d);
  c.recherches[k] = { t: new Date().toISOString(), res };
  return res;
}
async function fiche(itemNo) {
  const no = no8(itemNo);
  const fr = await ficheFr(no);
  const [pip, d3] = await Promise.all([
    fr && !fr.absent ? fichePip(no, fr.url).catch(() => null) : null,
    fiches3d([no])
      .then((o) => o[no])
      .catch(() => null),
  ]);
  return {
    ...fr,
    pack: pip ? pip.pack : null,
    gtk: pip ? pip.gtk : [],
    composants: (pip && pip.composants) || [],
    d3,
    teinte: teinteDe(fr && fr.design),
  };
}

// ---------------------------------------------------------------- alternatives
// même produit (nom + type + dimensions) dans la teinte cible ; sinon même type + dimensions, autre gamme (compatibilité à vérifier)
async function alternative(f, cible, exclure = []) {
  if (!f || f.absent || !cible) return null;
  const sz = parseSize(f.size),
    mots = MOTS[canon(cible)] || String(cible).replace(/-/g, " ");
  const qs = [
    `${f.name} ${f.type} ${f.size}`.replace(/ cm$/, ""),
    `${f.name} ${f.type} ${mots}`,
    `${f.type} ${(f.size || "").replace(/ cm$/, "")} ${mots}`,
  ];
  const seen = new Map();
  for (const q of qs)
    for (const v of await rechercheFr(q.trim()).catch(() => []))
      if (!seen.has(v.no)) seen.set(v.no, v);
  const cands = [...seen.values()]
    .filter(
      (v) =>
        v.no !== f.no &&
        conforme(teinteDe(v.design), cible) === "ok" &&
        v.price != null &&
        !exclure.some((x) => norm(v.name).split(" ").includes(norm(x))),
    )
    .map((v) => ({
      v,
      s:
        (norm(v.name) === norm(f.name) ? 0 : 30) +
        (norm(v.type) === norm(f.type)
          ? 0
          : norm(v.type).includes(norm(f.type).split(" ")[0])
            ? 6
            : 20) +
        ecartDims(sz, parseSize(v.size)) +
        (v.sellable ? 0 : 50),
    }))
    .filter((c) => c.s < 45)
    .sort((a, b) => a.s - b.s);
  if (!cands.length) return null;
  const v = cands[0].v;
  const d3 = (await fiches3d([v.no]).catch(() => ({})))[v.no];
  return {
    no: v.no,
    ref: fmtNo(v.no),
    nom: `${v.name} ${v.type}, ${v.design}${v.size ? ", " + v.size : ""}`,
    prix: v.price,
    en3d: !!(d3 && d3.present),
    memeGamme: norm(v.name) === norm(f.name),
    memeType: norm(v.type) === norm(f.type),
    memesDims: ecartDims(sz, parseSize(v.size)) < 1,
    url: v.url,
  };
}

// équivalent 3D : 1) la référence elle-même si présente et dans la teinte voulue ; 2) même produit/dimensions dans la teinte voulue ;
// 3) même produit/dimensions dans une autre teinte (avertissement) ; 4) objet de même type et dimensions proches (avertissement).
async function choisir3D(itemNo, { teinte, dims } = {}) {
  const no = no8(itemNo);
  const f = await fiche(no);
  const cible = canon(teinte) || f.teinte;
  const want = dimsArr(dims) || parseSize(f.size);
  if (
    f.d3 &&
    f.d3.present &&
    (!cible || ["ok", "na"].includes(conforme(teinteDe(f.d3.design), cible)))
  )
    return {
      furnitureId: f.d3.id,
      itemNo3d: no,
      raison: "référence présente dans le catalogue 3D",
      teinte3d: f.d3.design,
      avertissement: null,
      fiche3d: f.d3,
    };
  const nm = f.name || "",
    ty = f.type || "";
  const qs = nm
    ? [
        `${nm} ${ty}`,
        `${nm} ${ty} ${(f.size || "").replace(/ cm$/, "")}`,
        cible && MOTS[cible] ? `${nm} ${ty} ${MOTS[cible]}` : null,
      ]
    : [];
  if (!qs.length && want) qs.push(ty || "meuble");
  const seen = new Map();
  if (f.d3 && f.d3.present) seen.set(no, f.d3);
  for (const q of qs.filter(Boolean))
    for (const x of await recherche3d(q).catch(() => []))
      if (!seen.has(x.no) && x.geo.some((g) => g === "3d" || g === "wall_placeable"))
        seen.set(x.no, x);
  const sc = [...seen.values()]
    .map((x) => {
      const tc = conforme(teinteDe(x.design), cible);
      const sameName = nm && norm(x.name) === norm(nm),
        sameType = ty && norm(x.type) === norm(ty);
      const ed0 = ecartDims(want, x.dims);
      const s =
        ed0 +
        (ed0 > 8 ? 20 : 0) +
        (sameName ? 0 : 40) +
        (sameType ? 0 : ty && norm(x.type).includes(norm(ty).split(" ")[0]) ? 8 : 20) +
        (tc === "ok" || tc === "na"
          ? 0
          : tc === "voisine"
            ? 6
            : 25 + (cible && ton(teinteDe(x.design)) !== ton(cible) ? 5 : 0)) +
        (x.dispo ? 0 : 5);
      return { x, s, tc, sameName, sameType };
    })
    .sort((a, b) => a.s - b.s);
  if (!sc.length)
    return {
      furnitureId: null,
      itemNo3d: null,
      raison: f.absent
        ? `${fmtNo(no)} introuvable sur ikea.fr : pas de nom pour chercher un équivalent 3D`
        : `aucun équivalent 3D trouvé pour ${fmtNo(no)} ${nm} ${ty}`,
      teinte3d: null,
      avertissement: "absent du catalogue 3D, à poser à la main ou par sub3d",
      fiche3d: null,
    };
  const b = sc[0],
    ed = ecartDims(want, b.x.dims);
  const raison = `${b.x.no === no ? "même référence" : (b.sameName && b.sameType ? "même produit" : b.sameName ? "même gamme, autre type" : "autre produit") + ` ${fmtNo(b.x.no)} ${b.x.name} ${b.x.type}`}, ${b.x.design}, ${b.x.dims.map(Math.round).join("×")} cm (écart dims ${ed.toFixed(0)} cm)`;
  const av = [];
  if (b.tc === "non" || b.tc === "voisine")
    av.push(`teinte 3D « ${b.x.design} » au lieu de « ${cible} »`);
  if (!b.sameName) av.push("autre produit que la référence commandée");
  if (ed > 4) av.push(`dimensions différentes de ${ed.toFixed(0)} cm`);
  return {
    furnitureId: b.x.id,
    itemNo3d: b.x.no,
    raison,
    teinte3d: b.x.design,
    avertissement: av.length ? av.join(" ; ") : null,
    fiche3d: b.x,
  };
}

// ---------------------------------------------------------------- maquette
function lireProjet(html) {
  const m = String(html).match(
    /(?:const|let|var)\s+PROJET\s*=\s*(?:window\.PROJET\s*=\s*)?(\{[\s\S]*?\})\s*;/,
  );
  if (!m) return null;
  try {
    return require("vm").runInNewContext("(" + m[1] + ")", {}, { timeout: 500 });
  } catch {
    return null;
  }
}
const selection = (items, V) =>
  items.filter(
    (it) => it[V] && it.st !== "own" && (it.def && V in it.def ? it.def[V] : it.on) !== false,
  );

// ---------------------------------------------------------------- règles « compléments oubliés » (génériques, à étendre)
// Chaque règle reçoit l'entrée (it, sa position p, ses lignes L avec fiche f et q en paquets) et le contexte ; renvoie [{niveau, msg}].
const has = (L, re) => L.filter((l) => l.f && re.test(norm(`${l.f.type}`)));
const pieces = (ls) => ls.reduce((s, l) => s + l.q * (l.f.pack || 1), 0);
const nb = (ls) => ls.reduce((s, l) => s + l.q, 0);
function compteFacades(L) {
  const tiroirs = nb(has(L, /^(structure tiroir|tiroir)/));
  const faces = nb(L.filter((l) => l.f && /^face de tiroir/.test(norm(l.f.type))));
  const mixtes = nb(L.filter((l) => l.f && /^porte face de tiroir/.test(norm(l.f.type))));
  const portesSeules = nb(L.filter((l) => l.f && /^porte( vitree)?$/.test(norm(l.f.type))));
  const mixtesEnTiroir = Math.min(mixtes, Math.max(0, tiroirs - faces));
  return {
    tiroirs,
    faces,
    mixtes,
    portes: portesSeules + mixtes - mixtesEnTiroir,
    facadesTiroir: faces + mixtesEnTiroir,
  };
}
const gtkTxt = (l) => (l.f.gtk || []).map((g) => g.t).join(" ");
const RULES = [
  {
    id: "charnieres",
    desc: "porte vendue sans charnières (d’après « Bon à savoir » : « Pour 1 porte il faut 1 paquet de charnières »)",
    run({ L }) {
      const portesL = L.filter(
        (l) => l.f && /^porte/.test(norm(l.f.type)) && /charni/i.test(gtkTxt(l)),
      );
      if (!portesL.length) return [];
      const { portes } = compteFacades(L);
      if (portes <= 0) return [];
      const m = gtkTxt(portesL[0]).match(
        /Pour\s+(\d+)\s+porte[^.]*?(\d+)\s+paquets?\s+de\s+charni/i,
      );
      const parPorte = m ? +m[2] / +m[1] : 1;
      const need = Math.ceil(portes * parPorte),
        have = nb(has(L, /charniere/));
      return have < need
        ? [
            {
              niveau: "erreur",
              msg: `${portes} porte(s) → ${need} paquet(s) de charnières nécessaires, ${have} dans l’entrée`,
            },
          ]
        : have > need
          ? [
              {
                niveau: "avertissement",
                msg: `${have} paquets de charnières pour ${portes} porte(s) (${need} suffisent)`,
              },
            ]
          : [];
    },
  },
  {
    id: "glissieres",
    desc: "structure tiroir sans glissières",
    run({ L }) {
      const t = L.filter((l) => l.f && /^structure tiroir/.test(norm(l.f.type)));
      if (!t.length) return [];
      const need = nb(t),
        have = nb(has(L, /glissiere/)); // une glissière = 1 paquet (paire) par tiroir
      return have < need
        ? [
            {
              niveau: "erreur",
              msg: `${need} structure(s) tiroir → ${need} paquet(s) de glissières nécessaires, ${have} dans l’entrée`,
            },
          ]
        : [];
    },
  },
  {
    id: "facades",
    desc: "tiroir sans façade",
    run({ L }) {
      const { tiroirs, faces, mixtes } = compteFacades(L);
      const sansFace = L.filter((l) => l.f && /^structure tiroir/.test(norm(l.f.type)));
      if (!sansFace.length) return [];
      return faces + mixtes < tiroirs
        ? [{ niveau: "erreur", msg: `${tiroirs} tiroir(s) pour ${faces + mixtes} façade(s)` }]
        : [];
    },
  },
  {
    id: "boutons",
    desc: "façades sans boutons/poignées, ou paquets de boutons en trop",
    run({ L, it }) {
      const k = has(L, /bouton|poignee/);
      const { portes, facadesTiroir } = compteFacades(L);
      const fronts = portes + facadesTiroir;
      if (!fronts) return [];
      if (/pression|push|sans bouton|sans poign/i.test(it.ds || "")) return [];
      if (
        L.some(
          (l) => l.f && /charniere/.test(norm(l.f.type)) && /pression|push/.test(norm(l.f.type)),
        ) &&
        !k.length
      )
        return [
          {
            niveau: "info",
            msg: `${fronts} façade(s) sans bouton : charnières à ouverture par pression, à régler en « pression »`,
          },
        ];
      const have = pieces(k),
        pack = (k[0] && k[0].f.pack) || 1;
      if (!k.length)
        return [
          {
            niveau: "avertissement",
            msg: `${fronts} façade(s) sans bouton ni poignée (normal seulement en ouverture par pression)`,
          },
        ];
      if (have < fronts)
        return [
          {
            niveau: "erreur",
            msg: `${fronts} façade(s) pour ${have} bouton(s)/poignée(s) (${nb(k)} paquet(s) de ${pack})`,
          },
        ];
      if (have - fronts >= pack)
        return [
          {
            niveau: "avertissement",
            msg: `${have} boutons pour ${fronts} façade(s) : ${Math.floor((have - fronts) / pack)} paquet(s) de trop`,
          },
        ];
      return [];
    },
  },
  {
    id: "pieds",
    desc: "pieds : nombre par structure posée au sol (« Bon à savoir » : 4 pieds pour 60 cm, 5 pour 120…)",
    run({ L, it, p }) {
      const pd = has(L, /^pied/);
      if (!pd.length) return [];
      const st = L.filter(
        (l) => l.f && /^structure$|^caisson/.test(norm(l.f.type)) && parseSize(l.f.size),
      );
      if (!st.length) return [];
      const largeur = Math.max(...st.map((l) => parseSize(l.f.size)[0]));
      const emprise = Math.max(it.w || 0, it.d || 0) || largeur * nb(st);
      const auSol = Math.max(1, Math.min(nb(st), Math.round(emprise / largeur)));
      const txt = pd.map(gtkTxt).join(" ") + " " + st.map(gtkTxt).join(" ");
      const re = new RegExp(`structures de ${largeur} cm de large,? (\\d+) pieds`, "i");
      const m = txt.match(re);
      const parStruct = m ? +m[1] : largeur <= 60 ? 4 : largeur <= 120 ? 5 : 6;
      const need = auSol * parStruct,
        have = pieces(pd),
        pack = pd[0].f.pack || 1;
      if (have < need)
        return [
          {
            niveau: "erreur",
            msg: `${auSol} structure(s) de ${largeur} au sol → ${need} pieds, ${have} commandés (${nb(pd)} paquet(s) de ${pack})`,
          },
        ];
      if (have - need >= pack)
        return [
          {
            niveau: "avertissement",
            msg: `${have} pieds pour ${need} nécessaires : ${Math.floor((have - need) / pack)} paquet(s) de trop`,
          },
        ];
      return [];
    },
  },
  {
    id: "rail",
    desc: "structure murale sans rail de suspension (« Bon à savoir » : « nécessite 1 rail de suspension »)",
    run({ L, p, appuyee }) {
      const inclus = (l) =>
        (l.f.gtk || []).some(
          (g) => /rail/i.test(g.t) && (/^Included$/.test(g.k) || /\binclus/i.test(g.t)),
        );
      const st = L.filter(
        (l) =>
          l.f &&
          /rail de suspension/i.test(gtkTxt(l)) &&
          !/rail/.test(norm(l.f.type)) &&
          !inclus(l),
      );
      if (!st.length) return [];
      if (!(p && p.y > 0) || has(L, /^pied/).length || appuyee) return [];
      const parStruct = (l) => {
        const m = gtkTxt(l).match(/n[ée]cessite\s+(\d+)\s+rails?/i);
        return m ? +m[1] : 1;
      };
      const need = st.reduce((s2, l) => s2 + l.q * parStruct(l), 0),
        have = nb(has(L, /^rail/));
      return have < need
        ? [
            {
              niveau: "erreur",
              msg: `${need} structure(s) murale(s) (y = ${p.y}) → ${need} rail(s) de suspension, ${have} dans l’entrée`,
            },
          ]
        : [];
    },
  },
  {
    id: "eclairage-quantites",
    desc: "un câble d’alimentation par transformateur",
    run({ L }) {
      const tr = has(L, /transformateur/);
      if (!tr.length) return [];
      const cab = L.filter((l) => l.f && /cable d alimentation/.test(norm(l.f.type)));
      return nb(cab) < nb(tr)
        ? [
            {
              niveau: "erreur",
              msg: `${nb(tr)} transformateur(s) pour ${nb(cab)} câble(s) d’alimentation`,
            },
          ]
        : [];
    },
  },
  {
    id: "piles",
    desc: "appareil à piles vendues séparément sans piles dans le panier",
    run({ L, autresEntrees }) {
      const a = L.filter(
        (l) => l.f && /piles?[^.]*vendues? s[ée]par[ée]ment|(\d+) piles requises/i.test(gtkTxt(l)),
      );
      if (!a.length) return [];
      if ([...L, ...autresEntrees].some((x) => x.f && /^pile/.test(norm(x.f.type)))) return [];
      return a.map((l) => {
        const m = gtkTxt(l).match(/(\d+) piles requises/i),
          mod = gtkTxt(l).match(/mod[eè]le ([A-ZÅÄÖ]{3,}[^.]*?)(?:\.|$)/);
        return {
          niveau: "avertissement",
          msg: `${fmtNo(l.no)} ${l.f.name} : piles vendues séparément${m ? ` (${m[1] * l.q} requises)` : ""}${mod ? `, modèle conseillé ${mod[1].trim()}` : ""}, aucune pile dans le panier`,
        };
      });
    },
  },
  // règle générique : tout complément OBLIGATOIRE nommé dans « Bon à savoir » (« À compléter avec le transformateur LED TRÅDFRI … vendus séparément »)
  {
    id: "bon-a-savoir",
    desc: "compléments obligatoires cités dans « Bon à savoir » absents de l’entrée",
    run({ L, autresEntrees }) {
      const out = [];
      for (const l of L) {
        if (!l.f) continue;
        for (const g of l.f.gtk || []) {
          for (const phrase of g.t.split(/(?<=\.)\s+/)) {
            if (
              !/(à|a) compl[ée]ter (avec|par)|n[ée]cessite|il faut (utiliser|ajouter)|doit être compl/i.test(
                phrase,
              )
            )
              continue;
            if (
              /^\s*si |\bsi (vous|utilis|plusieurs|le |la |les )|peut (être|s)|t[ée]l[ée]commande|passerelle|DIRIGERA|application/i.test(
                phrase,
              )
            )
              continue;
            if (/^\s*(pour )?les .*\d+\s*cm/i.test(phrase) || /\bou\b/.test(phrase)) continue; // consignes par taille ou alternatives : traitées par les règles chiffrées
            const req = [
              ...phrase.matchAll(
                /((?:[a-zàâçéèêëîïôûùüÿœ'’-]+\s){0,3})((?:[A-ZÅÄÖÆØÉÈ]{3,})(?:\s[A-ZÅÄÖÆØÉÈ]{3,})?)/gu,
              ),
            ]
              .map((m) => ({
                nom: m[2]
                  .split(/\s/)
                  .filter((w) => !/^(LED|USB|IKEA|IRC|DEL|USA)$/.test(w))
                  .join(" "),
                avant: m[1],
              }))
              .filter((r) => r.nom);
            for (const r of req) {
              const motType = norm(r.avant)
                .split(" ")
                .filter(
                  (w) =>
                    w.length > 3 &&
                    !/^(avec|pour|les|des|une|vous|votre|completer|systeme|gamme|serie|collection|produits?|deux|trois|quatre|lot|adaptees?|adaptes?)$/.test(
                      w,
                    ),
                )[0];
              const ok = (ls) =>
                ls.some(
                  (x) =>
                    x.f &&
                    norm(x.f.name).split(" ").includes(norm(r.nom)) &&
                    (!motType || norm(x.f.type).includes(motType.slice(0, 6))),
                );
              if (norm(r.nom) === norm(l.f.name) && !motType) continue;
              if (ok(L)) continue;
              const ailleurs = ok(autresEntrees);
              const oblig =
                /s[ée]par[ée]ment|n[ée]cessite|il faut|obligatoire|requis/i.test(phrase) ||
                /^Sold separately$/.test(g.k);
              out.push({
                niveau: ailleurs || !oblig ? "avertissement" : "erreur",
                msg: `${fmtNo(l.no)} ${l.f.name} : « ${phrase.trim().slice(0, 160)} » → ${motType ? motType + " " : ""}${r.nom} ${ailleurs ? "présent seulement dans une autre entrée" : "absent du panier"}`,
              });
            }
          }
        }
      }
      return out.filter((x, i, a) => a.findIndex((y) => y.msg === x.msg) === i);
    },
  },
];

// une entrée en repose sur une autre (pas besoin de rail) si son bas touche le dessus d'une entrée dont l'emprise la recouvre
function appuyee(it, p, autres, V) {
  if (!p || !(p.y > 0)) return false;
  return autres.some((o) => {
    const q = o[V];
    if (!q || o === it) return false;
    const top = (q.y || o.ty || 0) + (o.h || 0);
    const rec =
      q.x < p.x + (it.w || 0) &&
      p.x < q.x + (o.w || 0) &&
      q.z < p.z + (it.d || 0) &&
      p.z < q.z + (o.d || 0);
    return rec && Math.abs(top - p.y) <= 3;
  });
}

// ---------------------------------------------------------------- lint
async function lintRefs(items, version, opts = {}) {
  const projet = {
    teinte: canon(opts.teinte) || null,
    quincaillerie: canon(opts.quincaillerie) || null,
    textile: canon(opts.textile) || null,
    exclure: opts.exclure || [],
    ...{},
  };
  const sel = selection(items, version),
    V = version;
  const erreurs = [],
    avertissements = [],
    lignes = [],
    infos = [];
  const E = (entree, ref, msg) => erreurs.push({ entree, ref, msg }),
    A = (entree, ref, msg) => avertissements.push({ entree, ref, msg });
  // 1) formes des refs et quantités (bloquant : une seule ref mal formée invalide le lien panier)
  const valides = new Set();
  for (const it of sel) {
    if (!Array.isArray(it.refs) || !it.refs.length) {
      (it.price > 0 ? E : A)(
        it.id,
        null,
        `« ${it.nm} » sans refs:[{itemNo,q}] (prix maquette ${eur((it.price || 0) * (it.q || 1))})`,
      );
      continue;
    }
    for (const r of it.refs) {
      const raw = String(r.itemNo == null ? "" : r.itemNo).trim();
      if (!REF_OK.test(raw))
        E(
          it.id,
          raw,
          `référence mal formée « ${raw} » (attendu 123.456.78) : invaliderait tout le lien panier`,
        );
      else valides.add(no8(raw));
      if (r.q != null && !(Number.isInteger(r.q) && r.q >= 1 && r.q <= 999))
        E(it.id, raw, `quantité « ${r.q} » invalide (entier de paquets 1–999 attendu)`);
    }
    if (it.sub3d && !REF_OK.test(String(it.sub3d).trim()))
      E(it.id, it.sub3d, `sub3d mal formé « ${it.sub3d} »`);
    else if (it.sub3d) valides.add(no8(it.sub3d));
  }
  // 2) fiches (en parallèle, cache)
  const nos = [...valides];
  await fiches3d(nos).catch((e) => A(null, null, "catalogue 3D injoignable : " + e.message));
  const F = {};
  await pool(nos, 6, async (no) => {
    try {
      F[no] = await fiche(no);
    } catch (e) {
      F[no] = { no, erreur: e.message };
    }
  });
  // alternatives (teinte) et équivalents 3D : une fois par référence, en parallèle
  const ALT = {},
    C3 = {},
    jobs = [];
  for (const no of nos) {
    const f = F[no];
    if (!f || f.absent || f.erreur) continue;
    const role = roleDe(f),
      cible = cibleDe(role, projet),
      c = conformeDesign(f.design, cible);
    if (c === "non" || c === "voisine" || c === "mixte")
      jobs.push(async () => {
        ALT[no] = await alternative(f, cible, projet.exclure).catch(() => null);
      });
    if (
      !(f.d3 && f.d3.present) &&
      !estComposant(f) &&
      role !== "technique" &&
      role !== "quincaillerie"
    )
      jobs.push(async () => {
        C3[no] = await choisir3D(no, { teinte: f.teinte }).catch((e) => ({
          raison: "erreur " + e.message,
        }));
      }); // 3D fidèle au panier
  }
  await pool(jobs, 6, (j) => j());
  // 3) par entrée
  const toutes = sel.map((it) => ({
    it,
    L: (it.refs || [])
      .filter((r) => REF_OK.test(String(r.itemNo).trim()))
      .map((r) => ({ no: no8(r.itemNo), q: r.q || 1, f: F[no8(r.itemNo)] })),
  }));
  for (const { it, L } of toutes) {
    const p = it[V] || {};
    let totalReel = 0,
      prixManquant = false;
    const vues = new Set();
    for (const l of L) {
      const f = l.f,
        ref = fmtNo(l.no);
      if (vues.has(l.no)) A(it.id, ref, `${ref} listée deux fois dans « ${it.nm} »`);
      vues.add(l.no);
      const row = {
        entree: it.id,
        nom: it.nm,
        ref,
        q: l.q,
        article: "",
        coloris: "",
        teinte: null,
        role: null,
        conforme: "na",
        prix: null,
        total: null,
        parN: null,
        dispo: "",
        en3d: null,
        alternative: null,
        alt3d: null,
      };
      lignes.push(row);
      if (!f || f.erreur) {
        E(it.id, ref, `${ref} : fiche illisible (${f && f.erreur})`);
        continue;
      }
      if (f.absent) {
        E(it.id, ref, `${ref} introuvable sur ikea.fr (${MARKET})`);
        row.article = "INTROUVABLE";
        continue;
      }
      row.article = `${f.name} ${f.type}${f.size ? ", " + f.size : ""}`;
      row.coloris = f.design || "—";
      row.teinte = f.teinte;
      row.role = roleDe(f);
      row.prix = f.price;
      row.parN = f.pack;
      row.total = f.price != null ? Math.round(f.price * l.q * 100) / 100 : null;
      row.dispo = !f.sellable
        ? "NON vendable en ligne"
        : f.lastChance
          ? "dernière chance"
          : "en ligne";
      row.en3d = !!(f.d3 && f.d3.present);
      if (f.price == null) prixManquant = true;
      else totalReel += f.price * l.q;
      if (!f.sellable) E(it.id, ref, `${ref} ${f.name} non vendable en ligne`);
      if (f.lastChance) A(it.id, ref, `${ref} ${f.name} : dernière chance (fin de série)`);
      for (const x of projet.exclure)
        if (norm(f.name).split(" ").includes(norm(x)) || norm(f.type).includes(norm(x)))
          E(it.id, ref, `${ref} ${f.name} ${f.type} : gamme exclue par le projet (${x})`);
      // teinte
      const cible = cibleDe(row.role, projet);
      row.conforme = conformeDesign(f.design, cible);
      row.cible = cible;
      if (row.conforme === "non") {
        E(
          it.id,
          ref,
          `${ref} ${f.name} ${f.type} « ${f.design} » ≠ teinte ${row.role === "quincaillerie" ? "quincaillerie " : ""}« ${cible} »`,
        );
        row.alternative = ALT[l.no] || null;
      } else if (row.conforme === "mixte") {
        A(
          it.id,
          ref,
          `${ref} ${f.name} ${f.type} « ${f.design} » : façades conformes, structure/caisson « ${f.design.split("/")[0]} » ≠ « ${cible} » (visible sur les flancs et le dessous)`,
        );
        row.alternative = ALT[l.no] || null;
      } else if (row.conforme === "voisine") {
        A(
          it.id,
          ref,
          `${ref} ${f.name} « ${f.design} » : teinte voisine de « ${cible} », à confirmer`,
        );
        row.alternative = ALT[l.no] || null;
      }
      // 3D
      if (!row.en3d && estComposant(f) && row.role === "meuble")
        row.alt3d = { composant: true, raison: "composant : représenté par le meuble principal" };
      if (!row.en3d && C3[l.no]) {
        if (!it.sub3d) {
          const c3 = C3[l.no];
          row.alt3d = c3;
          A(
            it.id,
            ref,
            `${ref} ${f.name} ${f.type} absent du catalogue 3D → ${c3.itemNo3d ? fmtNo(c3.itemNo3d) + " : " + c3.raison : c3.raison}${c3.avertissement ? " [" + c3.avertissement + "]" : ""}`,
          );
        }
      }
      if (f.pack > 1) {
        row.note = `vendu par ${f.pack} : ${l.q} paquet(s) = ${l.q * f.pack} pièces`;
        infos.push({
          entree: it.id,
          ref,
          msg: `${ref} ${f.name} ${f.type} vendu par ${f.pack} : q=${l.q} → ${l.q * f.pack} pièces (q compte des PAQUETS)`,
        });
      }
      if (f.composants && f.composants.length)
        row.composants = f.composants
          .map((c) => `${c.q}× ${fmtNo(c.no)} ${c.name} ${c.type}`)
          .join(", ");
    }
    // sub3d : le modèle forcé existe-t-il, et dans quelle teinte ?
    if (it.sub3d && REF_OK.test(String(it.sub3d).trim())) {
      const s = F[no8(it.sub3d)];
      if (!s || !s.d3 || !s.d3.present)
        E(it.id, fmtNo(it.sub3d), `sub3d ${fmtNo(it.sub3d)} absent du catalogue 3D`);
      else {
        const c = conforme(teinteDe(s.d3.design), projet.teinte);
        if (projet.teinte && c !== "ok")
          A(
            it.id,
            fmtNo(it.sub3d),
            `sub3d ${fmtNo(it.sub3d)} ${s.d3.name} ${s.d3.type} affiché en « ${s.d3.design} » (cible ${projet.teinte})`,
          );
      }
    }
    // prix maquette vs ikea.fr
    const maq = Math.round((it.price || 0) * (it.q || 1) * 100) / 100,
      reel = Math.round(totalReel * 100) / 100;
    if (L.length && !prixManquant && Math.abs(maq - reel) > Math.max(0.5, 0.01 * reel))
      A(
        it.id,
        null,
        `« ${it.nm} » : prix maquette ${eur(maq)} ≠ ikea.fr ${eur(reel)} (${reel > maq ? "+" : ""}${eur(Math.round((reel - maq) * 100) / 100)})`,
      );
    if (/estim|non chiffr/i.test(it.ds || ""))
      A(
        it.id,
        null,
        `« ${it.nm} » : description mentionne un prix estimé / non chiffré, à remplacer par les prix relus (${eur(reel)})`,
      );
    // règles de compléments
    const LX = L.flatMap((l) => [
      l,
      ...((l.f && l.f.composants) || []).map((c) => ({
        no: c.no,
        q: l.q * c.q,
        sub: true,
        f: { name: c.name, type: c.type, pack: 1, gtk: [] },
      })),
    ]);
    const ctx = {
      it,
      p,
      L: LX,
      autresEntrees: toutes.filter((x) => x.it !== it).flatMap((x) => x.L),
      appuyee: appuyee(it, p, sel, V),
    };
    for (const R of RULES)
      for (const r of R.run(ctx))
        if (r.niveau !== "info") (r.niveau === "erreur" ? E : A)(it.id, null, `[${R.id}] ${r.msg}`);
        else infos.push({ entree: it.id, ref: null, msg: `[${R.id}] ${r.msg}` });
  }
  saveCache();
  const total = Math.round(lignes.reduce((s, l) => s + (l.total || 0), 0) * 100) / 100;
  return { version: V, projet, erreurs, avertissements, infos, lignes, total, stats: { ...stats } };
}

// ---------------------------------------------------------------- correctif proposé pour liste-achat.js
// Valide la liste finale AVANT de construire le lien panier : 8 chiffres exacts (pas de padStart), quantité entière 1–999,
// référence connue et vendable en ligne, prix relevé. lignes = [{no|itemNo, qty}] ; renvoie { ok, erreurs, avertissements, lignes:[{no,qty,prix,pack,nom}] }.
async function verifierPanier(lignes) {
  const erreurs = [],
    avertissements = [],
    out = [];
  const L = lignes.map((l) => ({
    raw: String(l.no != null ? l.no : l.itemNo).trim(),
    qty: l.qty != null ? l.qty : l.q,
  }));
  for (const l of L) {
    if (!REF_OK.test(l.raw) && !/^\d{8}$/.test(l.raw))
      erreurs.push(`réf. « ${l.raw} » : pas 8 chiffres, invaliderait tout le lien`);
    if (!(Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= 999))
      erreurs.push(`réf. ${l.raw} : quantité « ${l.qty} » hors 1–999 ou non entière`);
  }
  const ok8 = L.filter((l) => REF_OK.test(l.raw) || /^\d{8}$/.test(l.raw));
  await fiches3d([]).catch(() => {});
  await pool(ok8, 6, async (l) => {
    const no = no8(l.raw);
    let f = null;
    try {
      f = await fiche(no);
    } catch (e) {
      erreurs.push(`${fmtNo(no)} : fiche illisible (${e.message})`);
      return;
    }
    if (f.absent) erreurs.push(`${fmtNo(no)} introuvable sur ikea.fr`);
    else {
      if (!f.sellable) erreurs.push(`${fmtNo(no)} ${f.name} non vendable en ligne`);
      if (f.price == null) erreurs.push(`${fmtNo(no)} ${f.name} : prix non relevé`);
      if (f.lastChance) avertissements.push(`${fmtNo(no)} ${f.name} : dernière chance`);
    }
    out.push({
      no,
      qty: l.qty,
      prix: f.price,
      pack: f.pack,
      nom: f.absent ? null : `${f.name} ${f.type}`,
      total: f.price != null ? Math.round(f.price * l.qty * 100) / 100 : null,
    });
  });
  const dbl = ok8.map((l) => no8(l.raw)).filter((n, i, a) => a.indexOf(n) !== i);
  if (dbl.length)
    erreurs.push(
      `réf. en double dans le lien (à additionner) : ${[...new Set(dbl)].map(fmtNo).join(", ")}`,
    );
  saveCache();
  return { ok: !erreurs.length, erreurs, avertissements, lignes: out };
}
// paquets à commander pour un besoin en pièces, d'après « Quantité/paquet » de la page produit
async function paquetsPour(itemNo, pieces) {
  const f = await fiche(itemNo);
  const n = f.pack || 1;
  return { pack: n, paquets: Math.ceil(pieces / n) };
}

module.exports = {
  verifierPanier,
  paquetsPour,
  conformeDesign,
  lintRefs,
  choisir3D,
  fiche,
  alternative,
  teinteDe,
  conforme,
  canon,
  roleDe,
  lireProjet,
  selection,
  parseSize,
  ecartDims,
  fmtNo,
  no8,
  REF_OK,
  TEINTES,
  COMPAT,
  ROLES,
  RULES,
  saveCache,
  stats,
  CACHE_FILE,
};
