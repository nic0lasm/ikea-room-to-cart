// Quaternions [x,y,z,w] et surfaces (sol, murs) d'une scène du planificateur.
"use strict";
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q, v) => {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [p[0], p[1], p[2]];
};
const qaxis = (ax, a) => {
  const s = Math.sin(a / 2);
  return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(a / 2)];
};
const add = (a, b) => a.map((v, i) => v + b[i]),
  sub = (a, b) => a.map((v, i) => v - b[i]);

// transforms globaux des noeuds glTF de surface (repère monde glTF : y vers le haut ; X = x maquette/100, Z = z maquette/100)
function surfaces(gltf) {
  const ex = (n) => (typeof n.extras === "string" ? JSON.parse(n.extras) : n.extras) || {};
  const parent = {};
  gltf.nodes.forEach((n, i) =>
    (n.children || []).forEach((c) => {
      parent[c] = i;
    }),
  );
  const world = (i) => {
    let T = [0, 0, 0],
      R = [0, 0, 0, 1];
    for (let k = i; k !== undefined; k = parent[k]) {
      const n = gltf.nodes[k];
      const r = n.rotation || [0, 0, 0, 1],
        t = n.translation || [0, 0, 0];
      T = add(qrot(r, T), t);
      R = qmul(r, R);
    }
    return { T, R };
  };
  const out = [];
  gltf.nodes.forEach((n, i) => {
    const e = ex(n);
    if (e.geomagicalSurface !== undefined && (e.class === "floor" || e.class === "wall"))
      out.push({ id: e.geomagicalSurface, cls: e.class, name: n.name, ...world(i) });
  });
  return out;
}
const toLocal = (s, P) => qrot(qconj(s.R), sub(P, s.T));
const toWorld = (s, p) => add(qrot(s.R, p), s.T);
module.exports = { qmul, qconj, qrot, qaxis, surfaces, toLocal, toWorld };
