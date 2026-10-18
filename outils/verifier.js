#!/usr/bin/env node
// verifier.js <maquette.html|maquette.json> <version|-> <shareUrl|compositionUuid|compiled.json> [dossier_sortie] [--tol 2] [--emprise-modele-avert] [--quiet]
//
// Vérifie, SANS navigateur, qu'un design partagé du planificateur IKEA (home-design) reproduit une version de la maquette :
// sens de la pièce (anti-miroir), longueurs des murs (1 cm), plafond = H, ouvertures, chaque meuble (position, emprise,
// rotation ; tolérance 2 cm, + décollement mural 4,5 cm / plinthe 2,5 cm côté dos), meubles en trop / manquants,
// ref posée contre refs du panier (substitution, teinte). Lit le JSON public du design (sans compte).
// <version> = '-' : pièce seule (murs, plafond, ouvertures ; meubles ignorés).
// Sorties : verif.json, verif.txt, plan-verif.svg (+ plan-verif.png si ImageMagick avec rsvg est présent) dans dossier_sortie.
// Code de sortie : 0 conforme, 2 écart(s), 1 erreur.
//
// Format minimal de maquette (JSON) si le HTML n'est pas au format attendu :
//   { "H": 250,                                  hauteur sous plafond (cm)
//     "P": [[x,z], ...],                         polygone intérieur (cm), dans l'ordre du contour
//     "OPEN": { "<i>": [{"a":cm,"b":cm,"h":cm,"glass":bool,"y0":cm}] },  ouvertures du segment P[i]->P[i+1], a/b depuis P[i]
//     "ITEMS": [{ "id":"…", "w":cm(x), "d":cm(z), "h":cm, "<VERSION>":{"x":coin x,"z":coin z,"y":bas},
//                 "face":"+x|-x|+z|-z", "refs":[{"itemNo":"123.456.78","q":1}], "st":"own", "sub3d":"…", "legs":cm, "on":true }] }
"use strict";
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";
const path = require("path"),
  fs = require("fs"),
  { execFileSync } = require("child_process");
const { verifierDesign, texte } = require("./lib/verif.js");

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const pos = argv.filter((a, i) => !a.startsWith("--") && !["--tol"].includes(argv[i - 1]));
if (argv.includes("--help") || pos.length < 3) {
  const L = fs.readFileSync(__filename, "utf8").split("\n").slice(1);
  console.error(
    L.slice(
      0,
      L.findIndex((l) => !l.startsWith("//")),
    )
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(argv.includes("--help") ? 0 : 1);
}
const [maq, version, cible, sortie0] = pos;
const sortie = path.resolve(sortie0 || path.join(process.cwd(), "verif-" + version));
(async () => {
  const options = {};
  if (opt("--tol")) options.tolMeuble = +opt("--tol");
  if (argv.includes("--emprise-modele-avert")) options.empriseModeleBloquante = false; // « modèle IKEA ≠ maquette » non bloquant
  const r = await verifierDesign({ maquette: path.resolve(maq), version, cible, sortie, options });
  try {
    execFileSync(
      "convert",
      ["-density", "96", path.join(sortie, "plan-verif.svg"), path.join(sortie, "plan-verif.png")],
      { stdio: "ignore", timeout: 20000 },
    );
  } catch (e) {
    /* SVG seul */
  }
  if (!argv.includes("--quiet")) process.stdout.write(texte(r));
  console.log(
    `Fichiers : ${sortie}/verif.json, verif.txt, plan-verif.svg${fs.existsSync(path.join(sortie, "plan-verif.png")) ? ", plan-verif.png" : ""}`,
  );
  process.exit(r.ok ? 0 : 2);
})().catch((e) => {
  console.error("ERREUR", e.stack || e.message);
  process.exit(1);
});
