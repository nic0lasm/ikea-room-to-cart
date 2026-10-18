#!/usr/bin/env node
// Usage : node outils/extraire-donnees.js <projets/xxx/maquette.html> [dossier_sortie]
// Lit la maquette 3D (seule source de vérité) et régénère les fichiers JSON du dossier donnees/ du projet
// (par défaut, à côté de la maquette) :
//   piece.json     contour, ouvertures, plafond (cm)
//   articles.json  tous les articles d'ITEMS (refs IKEA, prix, dimensions, positions par version)
//   versions.json  pour chaque version : articles posés, cochés par défaut, total maquette
// Repère : x depuis le mur gauche (0) vers le renfoncement, z depuis le mur de la porte (0)
// vers le mur porte-fenêtre (343), y = hauteur de pose. Tout en cm.
const fs = require("fs"),
  path = require("path"),
  vm = require("vm");
const root = path.join(__dirname, "..");
const file = process.argv[2] || path.join(root, "projets/bureau/maquette.html");
const out = process.argv[3] || path.join(path.dirname(file), "donnees");
const src = fs.readFileSync(file, "utf8");

// Bloc des constantes : de « const H= » jusqu'à la fin du tableau ITEMS
const a = src.indexOf("const H="),
  b = src.indexOf("ITEMS.forEach(it=>it.on0");
if (a < 0 || b < 0) throw new Error("Bloc ITEMS introuvable dans " + file);
const ctx = { window: {} };
vm.runInNewContext(src.slice(a, b) + ";this.R={H,W,D,P,DOOR,WIN,OPEN,REC,ITEMS};", ctx);
const { H, W, D, P, DOOR, WIN, OPEN, REC, ITEMS } = ctx.R;

const LABELS = {
  cur: "État actuel",
  A: "Bureau côté porte",
  B: "Bureau côté fenêtre",
  C: "Côté porte + imprimante",
  D: "Version ultime",
  E: "Niche imprimante",
  F: "Version libre",
  G: "Budget optimisé",
  V: "Vdef, version finale",
};
const POS = Object.keys(LABELS);

const piece = {
  unite: "cm",
  plafond: H,
  largeurMurPorte: W,
  profondeur: D,
  contour: P,
  porte: DOOR,
  porteFenetre: WIN,
  ouverturesParSegment: OPEN,
  renfoncement: REC,
};

const articles = ITEMS.map((it) => {
  const o = {
    id: it.id,
    nom: it.nm,
    description: it.ds,
    prixUnitaire: it.price,
    quantite: it.q,
    statutPrix: { ok: "vérifié", est: "estimé", own: "déjà possédé" }[it.st] || it.st,
    dimensions: { w: it.w, d: it.d, h: it.h },
    type: it.kind,
    refs: it.refs || [],
    groupe: it.grp || null,
    cocheParDefaut: it.on,
    positions: {},
  };
  if (it.def) o.cocheParDefautParVersion = it.def;
  if (it.face) o.face = it.face;
  POS.forEach((k) => {
    if (it[k]) o.positions[k] = it[k];
  });
  return o;
});

const coche = (it, k) => (it.def && k in it.def ? it.def[k] : it.on);
const versions = POS.filter((k) => ITEMS.some((it) => it[k])).map((k) => {
  const its = ITEMS.filter((it) => it[k]);
  const on = its.filter((it) => coche(it, k));
  return {
    version: k,
    titre: LABELS[k],
    articles: its.map((it) => it.id),
    cochesParDefaut: on.map((it) => it.id),
    totalMaquette: Math.round(on.reduce((s, it) => s + it.price * it.q, 0) * 100) / 100,
  };
});

fs.mkdirSync(out, { recursive: true });
const w = (n, v) => fs.writeFileSync(path.join(out, n), JSON.stringify(v, null, 1) + "\n");
w("piece.json", piece);
w("articles.json", articles);
w("versions.json", versions);
versions.forEach((v) =>
  console.log(v.version.padEnd(3), String(v.totalMaquette).padStart(8), "€", v.titre),
);
