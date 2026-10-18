#!/usr/bin/env node
// liste-achat.js <maquette.html> <version> [--html sortie.html] [--json sortie.json] [--offline]
// Décompose une version de la maquette en articles IKEA France, récupère les prix actuels
// (API de recherche publique ikea.fr) et produit un lien qui remplit le panier ikea.fr :
//   https://www.ikea.com/fr/fr/shoppingcart/?items=<8 chiffres>:<qté>,...
// (paramètre lu par la page panier d'ikea.fr elle-même, testé le 18/10/2026).
// Références : champ `refs:[{itemNo:'123.456.78', q:<paquets pour toute l'entrée>}]` d'une entrée ITEMS s'il existe,
// sinon table BOM ci-dessous (par id), sinon recherche par nom sur ikea.fr (signalée « à vérifier »).
"use strict";
const fs = require("fs"),
  path = require("path"),
  vm = require("vm");

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const OFFLINE = args.includes("--offline");
const [FILE, VERSION] = args.filter(
  (a, i) => !a.startsWith("--") && !["--html", "--json"].includes(args[i - 1]),
);
if (!FILE || !VERSION) {
  console.error(
    "usage: node liste-achat.js <maquette.html> <version> [--html out.html] [--json out.json] [--offline]",
  );
  process.exit(1);
}
const CACHE = path.join(__dirname, "cache-prix.json");

// ---------- Articles par paquet (on commande des paquets, les besoins sont en pièces) ----------
const PACK = { 90338417: 2, 70556067: 2, 80524882: 2, 60293566: 2, 80261258: 2 };

// ---------- Repli pour les entrées sans refs (maquettes plus anciennes, voir projets/bureau/archives) ----------
// id maquette -> articles pour UNE unité (multipliée par it.q)
// [n° article sans points, quantité en pièces, rôle]
const KNOB = "90338417",
  LEG = "70556067",
  HINGE = "80524882",
  BHINGE = "80261258",
  STUB = "60293566";
const light = (baguette) => [
  [baguette, 1, "éclairage"],
  ["50356187", 1, "driver TRÅDFRI 10 W"],
  ["50446881", 1, "câble d’alimentation FÖRNIMMA"],
  ["70463600", 1, "câble VÅGDAL"],
];
const caisson80_3t = [
  ["10205633", 1, "caisson 80"],
  ["20285040", 2, "tiroirs moyens"],
  ["70285028", 1, "tiroir haut"],
  ["30559162", 2, "façades 80×20"],
  ["10559163", 1, "façade 80×40"],
  [LEG, 4, "pieds"],
  [KNOB, 3, "boutons"],
];
const caisson30_porte = [
  ["50417195", 1, "caisson 30"],
  ["40559133", 1, "porte 30×80"],
  ["30417399", 1, "tablette 30"],
  [HINGE, 2, "charnières"],
  [LEG, 4, "pieds"],
  [KNOB, 1, "bouton"],
];
const eket = [
  ["80428852", 1, "cube EKET"],
  ["00340047", 1, "rail EKET"],
];
const BOM = {
  metod: caisson80_3t,
  top: [["70335189", 1, "plan KARLBY 186"]],
  topB: [["70335189", 1, "plan KARLBY 186"]],
  topE: [["70335189", 1, "plan KARLBY 186"]],
  billyo: [["90477385", 1, "BILLY 80×106"]],
  spool: [["90477385", 1, "BILLY 80×106"]],
  eket,
  eketN: eket,
  eketB: eket,
  eketG2: eket,
  eketG: [...eket, ["30428901", 1, "porte vitrée EKET"]],
  niche: light("70528611"),
  biblio: [
    ["20477379", 1, "BILLY 40×106"],
    ["10508932", 1, "BILLY 80×202"],
  ],
  metodE: [...caisson80_3t, ...caisson30_porte, ["90559121", 1, "panneau finition 62×80"]],
  metodG: [
    ["10205633", 1, "caisson 80"],
    ["70285028", 2, "tiroirs hauts"],
    ["10559163", 2, "façades 80×40"],
    [LEG, 4, "pieds"],
    [KNOB, 2, "boutons"],
    ...caisson30_porte,
    ["90559121", 1, "panneau finition 62×80"],
  ],
  tall: [
    ["90212564", 1, "armoire 60×60×220"],
    ["30285025", 2, "tiroirs hauts"],
    ["70559160", 2, "façades 60×40"],
    ["00559149", 1, "porte haute 60×40"],
    [HINGE, 2, "charnières"],
    ["50205612", 2, "tablettes niche"],
    ["70559117", 1, "panneau finition 62×220"],
    [LEG, 4, "pieds"],
    [KNOB, 3, "boutons"],
    ...light("70528569"),
  ],
  tallG: [
    ["90212564", 1, "armoire 60×60×220"],
    ["60559151", 1, "porte basse 60×80"],
    ["00559149", 1, "porte haute 60×40"],
    [HINGE, 4, "charnières"],
    ["50205612", 2, "tablettes"],
    ["70559117", 1, "panneau finition 62×220"],
    [LEG, 4, "pieds"],
    [KNOB, 2, "boutons"],
    ...light("70528569"),
  ],
  rug: [["30555282", 1, "tapis"]],
  lamp: [["00146776", 1, "lampe"]],
  chevet: [
    ["80247413", 1, "structure BESTÅ 64"],
    ["40291691", 1, "porte LAPPVIKEN 64"],
    [BHINGE, 2, "charnières"],
    [STUB, 4, "pieds"],
    [KNOB, 1, "bouton"],
  ],
  colonne: [
    ["80247413", 2, "structures BESTÅ 64"],
    ["40291691", 2, "portes LAPPVIKEN 64"],
    [BHINGE, 4, "charnières"],
    [STUB, 4, "pieds"],
    [KNOB, 2, "boutons"],
  ],
  fond: [
    ["80247408", 2, "structures BESTÅ 38"],
    ["90291684", 2, "portes LAPPVIKEN 38"],
    ["70488318", 2, "rails BESTÅ"],
    [BHINGE, 4, "charnières"],
    [KNOB, 2, "boutons"],
    ...light("60528584"),
  ],
  fridhult: [["00575446", 1, "canapé (Skiftebo jaune ; Knisa gris clair = 70351725)"]],
  lycksele: [
    ["70032682", 1, "structure"],
    ["30102078", 1, "matelas"],
    ["80483136", 1, "housse Ransta"],
  ],
  glostad: [["50489012", 1, "canapé"]],
  hammarn: [["90354327", 1, "convertible"]],
  // malm : cadre 120×200 non trouvé sur ikea.fr ; sally : hors IKEA
};

// ---------- Lecture de la maquette ----------
function loadItems(file) {
  const h = fs.readFileSync(file, "utf8");
  const a = h.indexOf("const ITEMS=window.ITEMS=[");
  const b = h.indexOf("];", a);
  if (a < 0 || b < 0) throw new Error("tableau ITEMS introuvable");
  const src = h.slice(h.indexOf("[", a), b + 1);
  const ctx = { OAK: 0, BRASS: 0 };
  return vm.runInNewContext(
    "(" + src + ")",
    new Proxy(ctx, {
      has: () => true,
      get: (t, k) => (k in t ? t[k] : k === Symbol.unscopables ? undefined : 0),
    }),
    { timeout: 1000 },
  );
}

// ---------- Prix en ligne ----------
const fmtNo = (n) => n.replace(/^(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3");
async function lookup(no, cache) {
  if (cache[no] || OFFLINE) return cache[no] || null;
  const r = await fetch(
    `https://sik.search.blue.cdtapps.com/fr/fr/search-result-page?q=${no}&size=10&types=PRODUCT`,
  );
  const j = await r.json();
  for (const i of j.searchResultPage.products.main.items) {
    const p = i.product;
    if (!p) continue;
    for (const v of [p, ...((p.gprDescription && p.gprDescription.variants) || [])]) {
      if (v.itemNo === no) {
        const d = {
          no,
          name: v.name,
          type: v.typeName || p.typeName,
          size: v.itemMeasureReferenceText || "",
          design: v.validDesignText || p.validDesignText || "",
          price: v.salesPrice ? v.salesPrice.numeral : null,
          sellable: !!v.onlineSellable,
          lastChance: !!v.lastChance,
          url: v.pipUrl,
        };
        cache[no] = d;
        await new Promise((s) => setTimeout(s, 250));
        return d;
      }
    }
  }
  return null;
}

async function searchName(nm, cache, dim = "", col = "") {
  const q = (nm + " " + dim + " " + col).replace(/\(.*?\)/g, "").trim();
  const r = await fetch(
    `https://sik.search.blue.cdtapps.com/fr/fr/search-result-page?q=${encodeURIComponent(q)}&size=24&types=PRODUCT`,
  );
  const j = await r.json();
  const all = j.searchResultPage.products.main.items
    .map((i) => i.product)
    .filter(Boolean)
    .flatMap((p) => [
      p,
      ...((p.gprDescription && p.gprDescription.variants) || []).map((v) => ({ ...p, ...v })),
    ]);
  const score = (p) =>
    (p.name === nm.toUpperCase() ? 4 : 0) +
    (dim && (p.itemMeasureReferenceText || "").startsWith(dim) ? 2 : 0) +
    (col &&
    (p.pipUrl || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .includes(
        col
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/ /g, "-"),
      )
      ? 1
      : 0);
  const p0 = all.sort((a, b) => score(b) - score(a))[0];
  const p = p0 && {
    ...p0,
    validDesignText: decodeURIComponent((p0.pipUrl || "").split("/p/")[1] || "")
      .replace(/-s?\d{8}\/?$/, "")
      .split("-")
      .slice(2)
      .join(" "),
  };
  if (!p) return null;
  const d = {
    no: p.itemNo,
    name: p.name,
    type: p.typeName,
    size: p.itemMeasureReferenceText || "",
    design: p.validDesignText || "",
    price: p.salesPrice ? p.salesPrice.numeral : null,
    sellable: !!p.onlineSellable,
    lastChance: !!p.lastChance,
    url: p.pipUrl,
  };
  cache[p.itemNo] = d;
  return d;
}

(async () => {
  const items = loadItems(FILE);
  const V = VERSION;
  const sel = items.filter(
    (it) => it[V] && it.st !== "own" && (it.def && V in it.def ? it.def[V] : it.on) !== false,
  );
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch (e) {}
  const offCache = cache;
  if (!OFFLINE) cache = {}; // prix toujours relus en ligne, le cache sert seulement pour --offline

  const need = new Map(); // no -> pièces
  const perItem = [],
    warn = [];
  for (const it of sel) {
    // 1) champ refs:[{itemNo,q}] de la maquette : q = nombre de paquets à commander pour TOUTE l'entrée (non multiplié par it.q)
    if (Array.isArray(it.refs) && it.refs.length) {
      const bom = it.refs.map((r) => [
        String(r.itemNo).replace(/\D/g, "").padStart(8, "0"),
        r.q || 1,
        "refs",
      ]);
      for (const [no, n] of bom) {
        need.set(no, (need.get(no) || 0) + n * (PACK[no] || 1));
      }
      perItem.push({
        it,
        bom: bom.map(([no, n, r]) => [no, (n * (PACK[no] || 1)) / (it.q || 1), r]),
      });
      continue;
    }
    // 2) table de décomposition intégrée ; 3) recherche par nom (premier résultat, à vérifier)
    let bom = BOM[it.id];
    if (!bom && !OFFLINE) {
      const dim = ((it.ds || "").match(
        /\d+(?:[.,]\d+)?\s*×\s*\d+(?:[.,]\d+)?(?:\s*×\s*\d+(?:[.,]\d+)?)?/,
      ) || [""])[0].replace(/\s*×\s*/g, "x");
      const col = ((it.ds || "").match(/motif chêne|effet chêne blanchi|noir|blanc/) || [""])[0];
      const d = await searchName(it.nm.split(/\s+/)[0], cache, dim, col);
      if (d) {
        bom = [[d.no, 1, "recherche par nom"]];
        warn.push(
          `« ${it.nm} » : pas de refs, pris le 1er résultat de recherche ${fmtNo(d.no)} ${d.name} ${d.type} ${d.design}, à vérifier`,
        );
      }
    }
    if (!bom) {
      warn.push(`« ${it.nm} » (${it.id}) : aucune référence IKEA trouvée, à ajouter à la main`);
      perItem.push({ it, bom: null });
      continue;
    }
    for (const [no, n] of bom) need.set(no, (need.get(no) || 0) + n * (it.q || 1));
    perItem.push({ it, bom });
  }
  const lines = [];
  for (const [no, pieces] of need) {
    const d = await lookup(no, cache);
    const qty = Math.ceil(pieces / (PACK[no] || 1));
    if (!d) warn.push(`${fmtNo(no)} introuvable sur ikea.fr`);
    else if (!d.sellable) warn.push(`${fmtNo(no)} ${d.name} non vendable en ligne`);
    else if (d.lastChance) warn.push(`${fmtNo(no)} ${d.name} : dernière chance (fin de série)`);
    lines.push({
      no,
      ref: fmtNo(no),
      name: d
        ? `${d.name} ${d.type}${d.design ? ", " + d.design : ""}${d.size ? ", " + d.size : ""}`
        : "?",
      qty,
      pieces,
      pack: PACK[no] || 1,
      unit: d ? d.price : null,
      total: d && d.price != null ? Math.round(d.price * qty * 100) / 100 : null,
      url: d ? d.url : `https://www.ikea.com/fr/fr/search/?q=${no}`,
    });
  }
  if (!OFFLINE) fs.writeFileSync(CACHE, JSON.stringify(Object.assign(offCache, cache), null, 1));
  const total = Math.round(lines.reduce((s, l) => s + (l.total || 0), 0) * 100) / 100;
  // comparaison avec la maquette (prix des paquets répartis au prorata des pièces)
  const priceOf = Object.fromEntries(lines.map((l) => [l.no, (l.unit || 0) / l.pack]));
  const cmp = perItem.map(({ it, bom }) => {
    const m = Math.round((it.price || 0) * (it.q || 1) * 100) / 100;
    const r = bom
      ? Math.round(bom.reduce((s, [no, n]) => s + priceOf[no] * n * (it.q || 1), 0) * 100) / 100
      : null;
    return {
      nm: it.nm,
      id: it.id,
      maquette: m,
      ikea: r,
      ecart: r == null ? null : Math.round((r - m) * 100) / 100,
    };
  });
  const maqTotal = Math.round(cmp.reduce((s, c) => s + c.maquette, 0) * 100) / 100;
  const q = lines.map((l) => `${l.no}:${l.qty}`).join(",");
  const link = `https://www.ikea.com/fr/fr/shoppingcart/?items=${q}`;
  const linkReplace = link + "&replaceItems=true";

  const eur = (x) => (x == null ? "?" : x.toFixed(2).replace(".", ",") + " €");
  console.log(
    `Version ${V} : ${sel.length} éléments de la maquette, ${lines.length} références IKEA\n`,
  );
  console.log(["Réf.", "Article", "Qté", "Prix unit.", "Total"].join("\t"));
  for (const l of lines)
    console.log(
      [
        l.ref,
        l.name + (l.pack > 1 ? ` (paquet de ${l.pack}, ${l.pieces} pièces nécessaires)` : ""),
        l.qty,
        eur(l.unit),
        eur(l.total),
      ].join("\t"),
    );
  console.log(
    `\nTOTAL ikea.fr : ${eur(total)}   (maquette : ${eur(maqTotal)}, écart ${eur(Math.round((total - maqTotal) * 100) / 100)})`,
  );
  console.log("\nÉcarts par élément de la maquette :");
  for (const c of cmp)
    console.log(
      `  ${c.nm} : maquette ${eur(c.maquette)} → ikea.fr ${eur(c.ikea)}${c.ecart ? ` (${c.ecart > 0 ? "+" : ""}${eur(c.ecart)})` : ""}`,
    );
  if (warn.length) {
    console.log("\nÀ signaler :");
    warn.forEach((w) => console.log("  - " + w));
  }
  console.log(`\nLIEN PANIER (ajoute au panier ikea.fr, ouvrir dans son navigateur) :\n${link}`);
  console.log(`\nVariante qui VIDE d’abord le panier existant :\n${linkReplace}`);
  console.log(
    "\nSecours : panier ikea.fr > « Ajouter par la référence de l’article », saisir chaque réf. et sa quantité.",
  );

  const out = {
    version: V,
    lines,
    total,
    maquetteTotal: maqTotal,
    comparaison: cmp,
    alertes: warn,
    lien: link,
    lienRemplace: linkReplace,
    date: new Date().toISOString(),
  };
  if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify(out, null, 1));
  if (opt("--html")) fs.writeFileSync(opt("--html"), html(out));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function html(o) {
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const eur = (x) => (x == null ? "?" : x.toFixed(2).replace(".", ",") + " €");
  const rows = o.lines
    .map(
      (l) =>
        `<tr><td class="ref">${l.ref}</td><td><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a>${l.pack > 1 ? `<div class="sub">paquet de ${l.pack} · ${l.pieces} pièces nécessaires</div>` : ""}</td><td class="n">${l.qty}</td><td class="n">${eur(l.unit)}</td><td class="n">${eur(l.total)}</td></tr>`,
    )
    .join("\n");
  const cmp = o.comparaison
    .map(
      (c) =>
        `<tr><td>${esc(c.nm)}</td><td class="n">${eur(c.maquette)}</td><td class="n">${eur(c.ikea)}</td><td class="n ${c.ecart > 0 ? "up" : c.ecart < 0 ? "down" : ""}">${c.ecart == null ? "–" : (c.ecart > 0 ? "+" : "") + eur(c.ecart)}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Liste d'achat ${esc(o.version)}</title><style>
:root{--bg:#fafaf7;--fg:#1d1d1f;--mut:#6b6b6b;--line:#e3e1da;--acc:#0058a3;--accfg:#fff;--up:#a0361b;--down:#2f7a3b}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#17181a;--fg:#ececec;--mut:#a0a0a0;--line:#33343a;--acc:#4f9be6;--accfg:#0b0b0b;--up:#f08c6c;--down:#7cc98a}}
:root[data-theme="dark"]{--bg:#17181a;--fg:#ececec;--mut:#a0a0a0;--line:#33343a;--acc:#4f9be6;--accfg:#0b0b0b;--up:#f08c6c;--down:#7cc98a}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:960px;margin:auto}
h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut)}a{color:var(--acc)}
.cta{display:inline-block;background:var(--acc);color:var(--accfg);padding:12px 18px;border-radius:999px;font-weight:600;text-decoration:none;margin:16px 8px 4px 0}
.cta.alt{background:none;color:var(--acc);border:1px solid var(--acc)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:12px 0 24px}th,td{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}.n{text-align:right;white-space:nowrap}.ref{font-family:ui-monospace,monospace;white-space:nowrap}
.sub{font-size:12px;color:var(--mut)}.up{color:var(--up)}.down{color:var(--down)}tfoot td{font-weight:700}li{margin:4px 0}
</style></head><body>
<h1>Liste d'achat IKEA, version ${esc(o.version)}</h1>
<div class="mut">${o.lines.length} références · prix ikea.fr relevés le ${o.date.slice(0, 10)} · total ${eur(o.total)}</div>
<a class="cta" href="${esc(o.lien)}" target="_blank" rel="noopener">Remplir mon panier ikea.fr</a>
<a class="cta alt" href="${esc(o.lienRemplace)}" target="_blank" rel="noopener">Vider puis remplir le panier</a>
<p class="mut">Le premier lien ajoute les articles au panier du navigateur, sans compte. Un second clic double les quantités : « Vider puis remplir » repart d'un panier vide. Rien n'est commandé avant la validation sur ikea.fr.</p>
<div class="wrap"><table><thead><tr><th>Réf.</th><th>Article</th><th class="n">Qté</th><th class="n">Prix unit.</th><th class="n">Total</th></tr></thead><tbody>
${rows}</tbody><tfoot><tr><td></td><td>Total</td><td></td><td></td><td class="n">${eur(o.total)}</td></tr></tfoot></table></div>
<h2>Écarts avec la maquette</h2>
<div class="wrap"><table><thead><tr><th>Élément</th><th class="n">Maquette</th><th class="n">ikea.fr</th><th class="n">Écart</th></tr></thead><tbody>${cmp}</tbody>
<tfoot><tr><td>Total</td><td class="n">${eur(o.maquetteTotal)}</td><td class="n">${eur(o.total)}</td><td class="n">${(o.total - o.maquetteTotal > 0 ? "+" : "") + eur(Math.round((o.total - o.maquetteTotal) * 100) / 100)}</td></tr></tfoot></table></div>
${o.alertes.length ? `<h2>À vérifier</h2><ul>${o.alertes.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
<h2>Si le lien ne marche pas</h2><p>Panier ikea.fr → « Ajouter par la référence de l'article » → saisir chaque référence et sa quantité.</p>
</body></html>`;
}
