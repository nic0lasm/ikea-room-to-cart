// Usage : node outils/fiche-saisie.js <maquette.html> [version]
// Lit le tableau ITEMS de la maquette 3D et imprime, pour une version, la fiche de saisie
// du planificateur IKEA : produit, dimensions, distance aux murs, hauteur de pose.
// Repère de la maquette : x depuis le mur gauche (0) vers le renfoncement, z depuis le mur de la
// porte (0, la porte d'entrée est à z = 0) vers le mur porte-fenêtre (343), y = hauteur. Tout en cm.
const fs = require("fs");
const [file, lay = "A"] = process.argv.slice(2);
if (!file) {
  console.error("Usage : node outils/fiche-saisie.js <maquette.html> [version]");
  process.exit(1);
}
const src = fs.readFileSync(file, "utf8");
const m =
  src.match(/const ITEMS=\[([\s\S]*?)\n\];/) || src.match(/ITEMS\s*=\s*\[([\s\S]*?)\n\s*\];/);
if (!m) {
  console.error("Tableau ITEMS introuvable");
  process.exit(1);
}
const OAK = 0,
  BRASS = 0;
const items = eval("[" + m[1] + "]");
console.log(`Version ${lay}`);
console.log(
  "Produit | longueur selon z × selon x × hauteur | coin depuis mur gauche (x) | coin depuis mur de la porte (z) | pose à (y)",
);
for (const it of items) {
  const p = it[lay];
  if (!p || (it.on === false && it.grp !== "sofa")) continue;
  const opt = it.on === false ? " (option, masqué par défaut)" : "";
  console.log(
    `${it.nm}${it.q > 1 ? " ×" + it.q : ""}${opt} | ${it.d} × ${it.w} × ${it.h} | ${p.x} | ${p.z} | ${p.y || 0}`,
  );
}
