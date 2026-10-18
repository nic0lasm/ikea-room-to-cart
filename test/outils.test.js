"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const T = require("../outils/lib/teintes.js");
const V = require("../outils/lib/verif.js");
const G = require("../outils/lib/geo3.js");

const MAQUETTE = path.join(__dirname, "../projets/bureau/maquette.html");

test("les références passent d'une écriture à l'autre", () => {
  assert.equal(T.no8("306.275.47"), "30627547");
  assert.equal(T.fmtNo("30627547"), "306.275.47");
  assert.match("306.275.47", T.REF_OK);
  assert.doesNotMatch("306.275.4", T.REF_OK);
});

test("les dimensions et les teintes se lisent dans les noms IKEA", () => {
  assert.deepEqual([...T.parseSize("140x50x75 cm")], [140, 50, 75]);
  assert.equal(T.teinteDe("motif chêne"), "chene");
  assert.equal(T.teinteDe("effet chêne blanchi"), "chene-blanchi");
});

test("le vérificateur lit la pièce et les meubles de la maquette", () => {
  const m = V.lireMaquette(MAQUETTE, "V");
  assert.equal(m.H, 238);
  assert.equal(m.P.length, 8);
  assert.ok(m.ITEMS.some((it) => it.id === "stork" && it.V));
});

test("un quart de tour autour de la verticale envoie +x sur -z", () => {
  const [x, y, z] = G.qrot(G.qaxis([0, 1, 0], Math.PI / 2), [1, 0, 0]);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9);
  assert.ok(Math.abs(z + 1) < 1e-9);
});
