// Lit la géométrie de la maquette et construit le roomTemplate du room-builder IKEA
const fs = require("fs"),
  vm = require("vm");
exports.readMaquette = (file) => {
  const src = fs.readFileSync(file, "utf8");
  const pick = (re) => {
    const m = src.match(re);
    if (!m) throw new Error("introuvable: " + re);
    return m[0];
  };
  const code =
    [
      pick(/const H=[^\n]*;/),
      pick(/const P=\[[^\n]*;/),
      pick(/const DOOR=\{[^\n]*?\};/),
      pick(/const WIN=\{[^\n]*?\};/),
      pick(/const OPEN=\{[^\n]*;/),
    ].join("\n") + "\n;({H,T,P,DOOR,WIN,OPEN})";
  return vm.runInNewContext(code, {});
};
// Repère planificateur : monde X = x maquette, monde Z = z maquette (m) ; 2D roomDefinition : (x, y) = (X, -Z)
exports.toTemplate = (g) => {
  const n = g.P.length;
  const seg = (i) => {
    const a = g.P[i],
      b = g.P[(i + 1) % n];
    return { a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  };
  const els = [];
  for (const k of Object.keys(g.OPEN))
    for (const o of g.OPEN[k]) {
      const s = seg(+k);
      // a,b = distances le long du segment, mesurées sur l'axe principal (x pour ces deux murs) : on corrige l'inclinaison
      const dx = Math.abs(s.b[0] - s.a[0]),
        f = s.len / (dx || s.len);
      const mid = ((o.a + o.b) / 2) * f,
        w = o.b - o.a; // largeur produit inchangée
      els.push({ wall: +k, glass: !!o.glass, center: mid, w, h: o.h });
    }
  const assets = [
    { type: "material", uuid: "68cbaec3-2792-4e2f-81dd-be4a5a655be1" },
    { type: "material", uuid: "8fd31b9a-28c9-4d44-aab0-cf6e6d5b1acb" },
    { type: "material", uuid: "ac77f0f2-97d4-4176-9dee-e668e7150af3" },
    {
      type: "wall-element",
      uuid: "96aee4f2-6a5a-4c81-9935-9ba12df57452" /* porte-fenêtre 2 vantaux */,
    },
    { type: "wall-element", uuid: "8aa4897f-9aec-4c1e-8024-44006b8bd7a2" /* porte simple */ },
  ];
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  return {
    floor: { asset: 0 },
    ceiling: { asset: 1, height: g.H / 100 },
    version: "2.0",
    assets,
    vertices: g.P.map((p, i) => ({ id: i, position: { x: r6(p[0] / 100), y: r6(-p[1] / 100) } })),
    walls: g.P.map((_, i) => ({
      id: i,
      asset: 2,
      color: { b: 255, g: 255, r: 255 },
      vertices: [i, (i + 1) % n],
    })),
    wallElements: els.map((e, i) => ({
      id: i,
      wall: e.wall,
      asset: e.glass ? 3 : 4,
      class: "door",
      size: { w: r6(e.w / 100), h: r6(e.h / 100) },
      position: { x: r6(e.center / 100), y: r6(e.h / 200) },
    })),
  };
};
// cotes attendues (cm) pour la vérification
exports.expected = (g) => {
  const n = g.P.length,
    walls = [];
  for (let i = 0; i < n; i++) {
    const a = g.P[i],
      b = g.P[(i + 1) % n];
    walls.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { walls, ceiling: g.H };
};
