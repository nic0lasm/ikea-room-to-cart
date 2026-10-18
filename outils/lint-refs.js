#!/usr/bin/env node
// lint-refs.js <maquette.html> <version> [--teinte chene|chene-blanchi|blanc|noir|…] [--quincaillerie noir] [--textile …]
//              [--exclure METOD,MAXIMERA] [--json sortie.json] [--offline]
// Contrôle les références IKEA d'une version AVANT de construire le design ou le panier :
// format des refs et quantités, fiche ikea.fr (nom, coloris réel, prix, vendu par N, vendable en ligne), présence dans le
// catalogue 3D du planificateur, teinte conforme à la cible, compléments oubliés (charnières, glissières, pieds, rails,
// transformateurs/câbles…), prix maquette ≠ prix réel ; alternative dans la bonne teinte et équivalent 3D si besoin.
// Cible : options CLI, sinon objet PROJET de la maquette, ex.
//   const PROJET={teinte:'chene', quincaillerie:'noir', exclure:['METOD','MAXIMERA','VOXTORP','KARLBY']};
// Code de sortie : 0 = aucune erreur bloquante, 2 = erreurs, 1 = usage / maquette illisible.
"use strict";
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";
const fs = require("fs"),
  vm = require("vm");
const args = process.argv.slice(2);
const VAL = ["--teinte", "--quincaillerie", "--textile", "--exclure", "--json"];
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
if (args.includes("--offline")) process.env.IKEA_REFS_OFFLINE = "1";
const T = require("./lib/teintes.js");
const [FILE, V] = args.filter((a, i) => !a.startsWith("--") && !VAL.includes(args[i - 1]));
if (!FILE || !V) {
  console.error(
    "usage: node lint-refs.js <maquette.html> <version> [--teinte chene] [--quincaillerie noir] [--exclure METOD,…] [--json f] [--offline]",
  );
  process.exit(1);
}

function loadItems(html) {
  const a = html.search(/(?:const|let|var)\s+ITEMS\s*=/);
  if (a < 0) throw new Error("tableau ITEMS introuvable");
  const s = html.indexOf("[", a);
  let d = 0,
    i = s,
    q = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") {
      d--;
      if (!d) break;
    }
  }
  const ctx = {};
  return vm.runInNewContext(
    "(" + html.slice(s, i + 1) + ")",
    new Proxy(ctx, {
      has: () => true,
      get: (t, k) => (k in t ? t[k] : k === Symbol.unscopables ? undefined : 0),
    }),
    { timeout: 1000 },
  );
}

(async () => {
  const t0 = Date.now();
  let html, items;
  try {
    html = fs.readFileSync(FILE, "utf8");
    items = loadItems(html);
  } catch (e) {
    console.error("maquette illisible : " + e.message);
    process.exit(1);
  }
  const P = T.lireProjet(html) || {};
  const o = {
    teinte: opt("--teinte") || P.teinte,
    quincaillerie: opt("--quincaillerie") || P.quincaillerie,
    textile: opt("--textile") || P.textile,
    exclure: opt("--exclure")
      ? opt("--exclure")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : P.exclure || [],
  };
  const r = await T.lintRefs(items, V, o);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const eur = (x) => (x == null ? "?" : x.toFixed(2).replace(".", ",") + " €");
  const mark = { ok: "OK", voisine: "~ voisine", mixte: "~ mixte", non: "NON", na: "—" };
  console.log(
    `Version ${V} · cible teinte ${r.projet.teinte || "(non fixée)"} · quincaillerie ${r.projet.quincaillerie || "(non fixée)"}${r.projet.exclure.length ? " · exclus " + r.projet.exclure.join(", ") : ""}`,
  );
  console.log(
    `${new Set(r.lignes.map((l) => l.entree)).size} entrées, ${r.lignes.length} lignes, total relu ${eur(r.total)} · ${dt} s (${r.stats.requetes} requêtes, ${r.stats.cache} lectures en cache)\n`,
  );
  const cols = [
    "entrée",
    "réf.",
    "q",
    "article",
    "coloris IKEA",
    "teinte",
    "prix",
    "vendu par",
    "dispo",
    "3D",
    "alternative / équivalent 3D",
  ];
  console.log(cols.join(" | "));
  for (const l of r.lignes) {
    const alt = [];
    if (l.alternative)
      alt.push(
        `→ ${l.alternative.ref} ${l.alternative.nom} ${eur(l.alternative.prix)}${l.alternative.memeGamme ? "" : " (autre gamme)"}${l.alternative.memeType ? "" : " (autre type)"}${l.alternative.memesDims ? "" : " (dims ≠)"} 3D:${l.alternative.en3d ? "oui" : "non"}`,
      );
    else if (l.conforme === "non") alt.push("→ aucune variante dans la teinte cible");
    if (l.alt3d && l.alt3d.composant) alt.push("3D : composant");
    else if (l.alt3d)
      alt.push(
        `3D: ${l.alt3d.itemNo3d ? T.fmtNo(l.alt3d.itemNo3d) + " " + (l.alt3d.teinte3d || "") : "aucun"}${l.alt3d.avertissement ? " [" + l.alt3d.avertissement + "]" : ""}`,
      );
    console.log(
      [
        l.entree,
        l.ref,
        l.q,
        l.article,
        l.coloris,
        mark[l.conforme] + (l.cible && l.conforme !== "na" ? ` (${l.cible})` : ""),
        eur(l.prix),
        l.parN > 1 ? `par ${l.parN}` : l.parN === 1 ? "unité" : "?",
        l.dispo,
        l.en3d == null ? "?" : l.en3d ? "oui" : "NON",
        alt.join(" ; "),
      ].join(" | "),
    );
  }
  const grp = (L) => {
    const m = new Map();
    for (const x of L) {
      const k = x.entree || "(général)";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  };
  if (r.erreurs.length) {
    console.log(`\nERREURS BLOQUANTES (${r.erreurs.length})`);
    for (const [k, L] of grp(r.erreurs)) {
      console.log(`  ${k}`);
      L.forEach((x) => console.log("    - " + x.msg));
    }
  }
  if (r.avertissements.length) {
    console.log(`\nAVERTISSEMENTS (${r.avertissements.length})`);
    for (const [k, L] of grp(r.avertissements)) {
      console.log(`  ${k}`);
      L.forEach((x) => console.log("    - " + x.msg));
    }
  }
  if (r.infos && r.infos.length) {
    console.log(`\nINFOS (${r.infos.length})`);
    r.infos.forEach((x) => console.log(`  ${x.entree} : ${x.msg}`));
  }
  const compo = r.lignes.filter((l) => l.composants);
  if (compo.length) {
    console.log("\nCOMBINAISONS (articles inclus)");
    compo.forEach((l) => console.log(`  ${l.entree} ${l.ref} : ${l.composants}`));
  }
  console.log(
    `\n${r.erreurs.length ? "ÉCHEC" : "OK"} : ${r.erreurs.length} erreur(s), ${r.avertissements.length} avertissement(s).`,
  );
  if (opt("--json"))
    fs.writeFileSync(
      opt("--json"),
      JSON.stringify(
        { ...r, maquette: FILE, date: new Date().toISOString(), duree_s: +dt },
        null,
        1,
      ),
    );
  process.exit(r.erreurs.length ? 2 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
