"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const RACINE = path.join(__dirname, "..");
const MAQUETTE = path.join(RACINE, "projets/bureau/maquette.html");
const geom = require("../outils/piece/geom.js");
const plan = require("../outils/lib/plan.js");

const lancer = (script, ...args) =>
  execFileSync(process.execPath, [path.join(RACINE, "outils", script), ...args], {
    encoding: "utf8",
  });
const dossierTemporaire = () => fs.mkdtempSync(path.join(os.tmpdir(), "ikea-room-to-cart-"));

test("la géométrie de la pièce est lue dans la maquette", () => {
  const m = geom.readMaquette(MAQUETTE);
  assert.equal(m.H, 238);
  assert.equal(m.P.length, 8);
  assert.deepEqual([...m.P[0]], [0, 3]);
  assert.ok(m.DOOR.x1 > m.DOOR.x0);
  assert.ok(m.WIN.x1 > m.WIN.x0);
});

test("le gabarit du room-builder reprend chaque mur de la pièce", () => {
  const t = geom.toTemplate(geom.readMaquette(MAQUETTE));
  assert.equal(t.vertices.length, 8);
  assert.equal(t.walls.length, 8);
  assert.equal(t.ceiling.height, 2.38);
});

test("chaque article coché d'une version a une emprise et une position", () => {
  const items = plan.loadItems(MAQUETTE);
  for (const V of ["A", "V"]) {
    const sel = items.filter((it) => plan.isOn(it, V));
    assert.ok(sel.length > 10, `version ${V} : ${sel.length} articles`);
    for (const it of sel) {
      for (const k of ["w", "d", "h"]) assert.ok(it[k] > 0, `${it.id}.${k}`);
      assert.equal(typeof it[V].x, "number", `${it.id}.${V}.x`);
      assert.equal(typeof it[V].z, "number", `${it.id}.${V}.z`);
    }
  }
});

test("les données extraites suivent la maquette", () => {
  const out = dossierTemporaire();
  lancer("extraire-donnees.js", MAQUETTE, out);
  const versions = JSON.parse(fs.readFileSync(path.join(out, "versions.json"), "utf8"));
  const articles = JSON.parse(fs.readFileSync(path.join(out, "articles.json"), "utf8"));
  const piece = JSON.parse(fs.readFileSync(path.join(out, "piece.json"), "utf8"));
  assert.ok(Array.isArray(articles) && articles.length > 0);
  assert.equal(piece.plafond, 238);
  assert.equal(piece.contour.length, 8);
  assert.ok(JSON.stringify(versions).includes("1188.92"));
});

test("le lien panier de la version finale correspond au panier publié", () => {
  // Sans réseau ni cache, les prix sont inconnus : le script le signale (code 2) mais produit le lien.
  const dossier = dossierTemporaire();
  const out = path.join(dossier, "V.json");
  const r = spawnSync(
    process.execPath,
    [path.join(RACINE, "outils/liste-achat.js"), MAQUETTE, "V", "--offline", "--json", out],
    { encoding: "utf8", env: { ...process.env, IKEA_CACHE_DIR: dossier } },
  );
  assert.equal(r.status, 2, r.stderr);
  const panier = JSON.parse(fs.readFileSync(out, "utf8"));
  const liens = require("../projets/bureau/donnees/liens-ikea.json");
  assert.equal(panier.lienRemplace, liens.versions.V.panier);
  assert.equal(panier.totalIncomplet, true);
  assert.match(
    panier.lien,
    /^https:\/\/www\.ikea\.com\/fr\/fr\/shoppingcart\/\?items=(\d{8}:\d+,)*\d{8}:\d+$/,
  );
});
