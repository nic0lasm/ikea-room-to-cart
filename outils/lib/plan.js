// Décomposition d'une version de la maquette en meubles 3D posés (sans réseau : les fiches sont fournies).
// Repère maquette (cm) : x depuis le mur gauche, z depuis le mur de la porte, y = hauteur. Monde glTF du planificateur : X = x/100, Y = y/100, Z = z/100.
"use strict";
const fs = require("fs"),
  vm = require("vm");

// tableau ITEMS : `const|let|var ITEMS = [` (ou `ITEMS=window.ITEMS=[`), fermé en comptant les crochets (chaînes et commentaires respectés)
function loadItems(file) {
  const h = fs.readFileSync(file, "utf8");
  const a = h.search(/(?:const|let|var)\s+ITEMS\s*=/);
  if (a < 0) throw new Error("tableau ITEMS introuvable dans " + file);
  const s = h.indexOf("[", a);
  let d = 0,
    q = null,
    i = s;
  for (; i < h.length; i++) {
    const c = h[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "/" && h[i + 1] === "/") {
      i = h.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && h[i + 1] === "*") {
      i = h.indexOf("*/", i) + 1;
      if (i <= 0) break;
    } else if (c === "[") d++;
    else if (c === "]" && --d === 0) break;
  }
  if (s < 0 || d !== 0) throw new Error("tableau ITEMS non fermé dans " + file);
  const src = h.slice(s, i + 1);
  return vm.runInNewContext(
    "(" + src + ")",
    new Proxy({}, { has: () => true, get: (t, k) => (k === Symbol.unscopables ? undefined : 0) }),
    { timeout: 1000 },
  );
}
const isOn = (it, V) => !!it[V] && (it.def && V in it.def ? it.def[V] : it.on) !== false;

// ---------- géométrie 2D ----------
function rayToPoly(P, o, dir) {
  // distance du point o au premier mur dans la direction dir
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i],
      b = P[(i + 1) % P.length];
    const ex = b[0] - a[0],
      ez = b[1] - a[1];
    const den = dir[0] * ez - dir[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - o[0]) * ez - (a[1] - o[1]) * ex) / den,
      u = ((a[0] - o[0]) * dir[1] - (a[1] - o[1]) * dir[0]) / den;
    if (t >= -1 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.min(best, Math.max(0, t));
  }
  return best;
}
function inPoly(P, p) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i],
      b = P[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      c = !c;
  }
  return c;
}
function distSeg(p, a, b) {
  const ex = b[0] - a[0],
    ez = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / (ex * ex + ez * ez)),
  );
  return Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ez);
}
// > 0 : dedans (distance au mur le plus proche) ; < 0 : dehors
function signedDist(P, p) {
  let d = Infinity;
  for (let i = 0; i < P.length; i++) d = Math.min(d, distSeg(p, P[i], P[(i + 1) % P.length]));
  return inPoly(P, p) ? d : -d;
}

const DIRS = { "+x": [1, 0], "-x": [-1, 0], "+z": [0, 1], "-z": [0, -1] };
const dirName = (d) => Object.keys(DIRS).find((k) => DIRS[k][0] === d[0] && DIRS[k][1] === d[1]);
// boîte de l'entrée (cm)
function entryBox(it, V) {
  const p = it[V];
  const y = p.y != null ? p.y : it.ty != null ? it.ty : 0;
  return { x0: p.x, x1: p.x + it.w, z0: p.z, z1: p.z + it.d, y0: y, y1: y + it.h };
}
// distance de chaque côté de l'emprise au mur situé derrière lui
function sideDists(P, b) {
  const xc = (b.x0 + b.x1) / 2,
    zc = (b.z0 + b.z1) / 2,
    out = {};
  const probe = (pts, dir) => Math.min(...pts.map((p) => rayToPoly(P, p, dir)));
  out["-x"] = probe(
    [
      [b.x0, b.z0 + 1],
      [b.x0, zc],
      [b.x0, b.z1 - 1],
    ],
    [-1, 0],
  );
  out["+x"] = probe(
    [
      [b.x1, b.z0 + 1],
      [b.x1, zc],
      [b.x1, b.z1 - 1],
    ],
    [1, 0],
  );
  out["-z"] = probe(
    [
      [b.x0 + 1, b.z0],
      [xc, b.z0],
      [b.x1 - 1, b.z0],
    ],
    [0, -1],
  );
  out["+z"] = probe(
    [
      [b.x0 + 1, b.z1],
      [xc, b.z1],
      [b.x1 - 1, b.z1],
    ],
    [0, 1],
  );
  return out; // clé = côté du DOS (direction vers le mur)
}
const gap = (a, b) =>
  Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)) +
  Math.max(0, Math.max(a.z0, b.z0) - Math.min(a.z1, b.z1));

// orientation : face donnée, sinon dos au mur le plus proche ; un meuble isolé (> 25 cm de tout mur) regarde le meuble voisin le plus proche
function facade(it, V, P, others) {
  const b = entryBox(it, V);
  if (it.face && DIRS[it.face]) return { f: DIRS[it.face], why: "face " + it.face + " (maquette)" };
  const sd = sideDists(P, b);
  const back = Object.keys(sd).sort((a, c) => sd[a] - sd[c])[0];
  if (sd[back] <= 25) {
    const d = DIRS[back];
    return { f: [-d[0], -d[1]], why: `dos au mur (${back}, ${sd[back].toFixed(1)} cm)` };
  }
  let best = null;
  for (const o of others) {
    const ob = entryBox(o, V);
    const g = gap(b, ob);
    if (!best || g < best.g) best = { g, o, ob };
  }
  if (best && best.g < 60) {
    // direction principale vers le voisin
    const dx = (best.ob.x0 + best.ob.x1 - (b.x0 + b.x1)) / 2,
      dz = (best.ob.z0 + best.ob.z1 - (b.z0 + b.z1)) / 2;
    const f = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)];
    return { f, why: `isolé : tourné vers ${best.o.id} (${best.g.toFixed(0)} cm)` };
  }
  const d = DIRS[back];
  return { f: [d[0], d[1]], why: "isolé : tourné vers le mur le plus proche" };
}
// yaw glTF (rotation autour de Y) qui envoie la façade du modèle (+z) sur f=(fx,fz)
const yawOf = (f) => Math.atan2(f[0], f[1]);

module.exports = {
  loadItems,
  isOn,
  entryBox,
  sideDists,
  facade,
  yawOf,
  DIRS,
  dirName,
  signedDist,
  inPoly,
  rayToPoly,
};
