// Vérificateur indépendant d'un design du planificateur IKEA (home-design) contre une maquette, SANS navigateur.
// Lit le JSON public du design partagé (compositions/<uuid>/compiled, sans authentification) et compare à la maquette :
// sens de la pièce (anti-miroir), murs, plafond, ouvertures, meubles (position, emprise, rotation, en trop / manquants),
// refs posées contre refs du panier (substitution, teinte). Générique : rien du projet n'est codé en dur.
//
// Maquette acceptée (voir verifier.js --help) :
//  - HTML contenant des déclarations `const H=…;`, `const P=[…];`, `const OPEN={…};` (une ligne chacune, constantes en
//    MAJUSCULES éventuellement utilisées : DOOR, WIN, D…) et `const ITEMS=[…];` (ou `ITEMS=window.ITEMS=[…]`) ;
//  - ou JSON minimal {H, P, OPEN, ITEMS}.
// Repère maquette (cm) : x, z au sol (P = polygone intérieur), y = hauteur. Repère IKEA attendu (cf. acceleration §1-2) :
// sommets de la pièce (x, y) m -> maquette (100x, -100y) ; meubles posés au sol idem (centre de l'emprise) ; monde glTF (X,Y,Z) -> (100X, 100Z, 100Y).
"use strict";
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  vm = require("vm");

const GEO = "3d,2d_wall,wall_placeable";
const DEF = {
  tolMur: 1,
  tolMeuble: 2,
  tolRot: 2,
  decolleMur: 4.5,
  plinthe: 2.5,
  distDos: 25,
  empriseModeleBloquante: true,
};
const r1 = (v) => (v == null || !isFinite(v) ? v : Math.round(v * 10) / 10);
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const no8 = (n) => String(n).replace(/\D/g, "").padStart(8, "0");

// ---------------------------------------------------------------- maquette
function extraireTableau(src, idx) {
  // tableau littéral à partir de l'index du '[' (chaînes et commentaires respectés)
  let d = 0,
    q = null;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) - 1;
    else if (c === "[") d++;
    else if (c === "]" && --d === 0) return src.slice(idx, i + 1);
  }
  throw new Error("tableau non fermé");
}
function lireMaquette(file) {
  const src = fs.readFileSync(file, "utf8");
  if (/\.json$/i.test(file)) {
    const j = JSON.parse(src);
    for (const k of ["H", "P"])
      if (j[k] == null) throw new Error(`maquette JSON : champ ${k} manquant`);
    return { H: j.H, P: j.P, OPEN: j.OPEN || {}, ITEMS: j.ITEMS || [] };
  }
  // constantes en majuscules déclarées sur une ligne, évaluées dans l'ordre (les échecs sont ignorés)
  const ctx = {};
  vm.createContext(ctx);
  for (const m of src.matchAll(
    /^[ \t]*const[ \t]+([A-Z][A-Z0-9_]*[ \t]*=[^\n]*?;)[ \t]*(\/\/[^\n]*)?$/gm,
  )) {
    if (/^(ITEMS)\b/.test(m[1])) continue;
    try {
      vm.runInContext("var " + m[1], ctx, { timeout: 200 });
    } catch (e) {
      /* ligne non évaluable : ignorée */
    }
  }
  for (const k of ["H", "P"])
    if (ctx[k] == null)
      throw new Error(
        `maquette : constante ${k} introuvable (attendu : const ${k}=… sur une ligne)`,
      );
  const a = src.search(/\bITEMS\s*=\s*(window\.ITEMS\s*=\s*)?\[/);
  if (a < 0) return { H: ctx.H, P: ctx.P, OPEN: ctx.OPEN || {}, ITEMS: [] }; // pièce seule
  const lit = extraireTableau(src, src.indexOf("[", a));
  const sandbox = new Proxy(
    {},
    {
      has: () => true,
      get: (t, k) =>
        k === Symbol.unscopables ? undefined : k in ctx ? ctx[k] : k === "Math" ? Math : 0,
    },
  );
  const ITEMS = vm.runInNewContext("with(sb){(" + lit + ")}", { sb: sandbox }, { timeout: 1000 });
  return { H: ctx.H, P: ctx.P, OPEN: ctx.OPEN || {}, ITEMS };
}
const estPresent = (it, V) => !!it[V] && (it.def && V in it.def ? it.def[V] : it.on) !== false;
function boiteEntree(it, V) {
  const p = it[V];
  const y = p.y != null ? p.y : it.ty != null ? it.ty : 0;
  return { x0: p.x, x1: p.x + it.w, z0: p.z, z1: p.z + it.d, y0: y, y1: y + it.h };
}

// ---------------------------------------------------------------- géométrie 2D
const aireSignee = (Q) => {
  let s = 0;
  for (let i = 0; i < Q.length; i++) {
    const a = Q[i],
      b = Q[(i + 1) % Q.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};
function centroide(Q) {
  const A = aireSignee(Q);
  let cx = 0,
    cz = 0;
  for (let i = 0; i < Q.length; i++) {
    const a = Q[i],
      b = Q[(i + 1) % Q.length],
      f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f;
    cz += (a[1] + b[1]) * f;
  }
  return [cx / (6 * A), cz / (6 * A)];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function rayon(P, o, dir) {
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i],
      b = P[(i + 1) % P.length],
      ex = b[0] - a[0],
      ez = b[1] - a[1];
    const den = dir[0] * ez - dir[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - o[0]) * ez - (a[1] - o[1]) * ex) / den,
      u = ((a[0] - o[0]) * dir[1] - (a[1] - o[1]) * dir[0]) / den;
    if (t >= -1 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.min(best, Math.max(0, t));
  }
  return best;
}
function distancesDos(P, b) {
  const xc = (b.x0 + b.x1) / 2,
    zc = (b.z0 + b.z1) / 2,
    pr = (pts, d) => Math.min(...pts.map((p) => rayon(P, p, d)));
  return {
    "-x": pr(
      [
        [b.x0, b.z0 + 1],
        [b.x0, zc],
        [b.x0, b.z1 - 1],
      ],
      [-1, 0],
    ),
    "+x": pr(
      [
        [b.x1, b.z0 + 1],
        [b.x1, zc],
        [b.x1, b.z1 - 1],
      ],
      [1, 0],
    ),
    "-z": pr(
      [
        [b.x0 + 1, b.z0],
        [xc, b.z0],
        [b.x1 - 1, b.z0],
      ],
      [0, -1],
    ),
    "+z": pr(
      [
        [b.x0 + 1, b.z1],
        [xc, b.z1],
        [b.x1 - 1, b.z1],
      ],
      [0, 1],
    ),
  };
}
const DIRS = { "+x": [1, 0], "-x": [-1, 0], "+z": [0, 1], "-z": [0, -1] };
const nomDir = (d) => {
  const a = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
  for (const [k, v] of Object.entries(DIRS))
    if (Math.abs((((Math.atan2(v[1], v[0]) * 180) / Math.PI - a + 540) % 360) - 180) < 3) return k;
  return r1(a) + "°";
};
// façade attendue : `face` de la maquette, sinon dos au mur le plus proche (≤ distDos cm), sinon inconnue
// objets : si le modèle IKEA est nettement plus large que profond, sa largeur doit suivre le grand côté de l'emprise maquette
// (quart de tour imposé par l'emprise) : seuls les murs parallèles à ce grand côté peuvent alors être derrière lui
function facadeAttendue(it, b, P, o, objets) {
  if (it.face && DIRS[it.face])
    return {
      f: DIRS[it.face],
      dos: it.face.replace(/^[+-]/, (s) => (s === "+" ? "-" : "+")),
      pourquoi: "face " + it.face + " (maquette)",
    };
  const sd = distancesDos(P, b);
  let keys = Object.keys(sd).sort((a, c) => sd[a] - sd[c]),
    pourquoi = "dos au mur le plus proche";
  const ex = b.x1 - b.x0,
    ez = b.z1 - b.z0,
    long = ez > ex + 5 ? "z" : ex > ez + 5 ? "x" : null;
  const f0 = (objets || []).map((ob) => ob.fiche).find(Boolean),
    large = f0 && f0.maxX - f0.minX - (f0.maxZ - f0.minZ) > 0.05;
  if (long && large) {
    const ok = keys.filter((k) => k[1] !== long); // dos sur ±x si le grand côté est selon z, et inversement
    if (ok[0] !== keys[0]) {
      keys = ok;
      pourquoi = `quart de tour imposé par l'emprise (grand côté selon ${long}), dos au mur le plus proche`;
    }
    const k = keys[0];
    return { f: DIRS[k].map((v) => -v), dos: k, pourquoi: `${pourquoi} (${k}, ${r1(sd[k])} cm)` };
  }
  const k = keys[0];
  if (sd[k] <= o.distDos)
    return { f: DIRS[k].map((v) => -v), dos: k, pourquoi: `${pourquoi} (${k}, ${r1(sd[k])} cm)` };
  return null;
}

// ---------------------------------------------------------------- quaternions [x,y,z,w]
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q, v) => {
  const n = Math.hypot(...q) || 1;
  q = q.map((x) => x / n);
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [p[0], p[1], p[2]];
};
const add = (a, b) => a.map((v, i) => v + b[i]);
function surfaces(gltf) {
  // transforms monde des noeuds de surface (sol, murs) de la scène
  const ex = (n) => {
    try {
      return (typeof n.extras === "string" ? JSON.parse(n.extras) : n.extras) || {};
    } catch (e) {
      return {};
    }
  };
  const parent = {};
  (gltf.nodes || []).forEach((n, i) =>
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
  const out = {};
  (gltf.nodes || []).forEach((n, i) => {
    const e = ex(n);
    if (e.geomagicalSurface !== undefined)
      out[e.geomagicalSurface] = { id: e.geomagicalSurface, cls: e.class, ...world(i) };
  });
  return out;
}

// ---------------------------------------------------------------- réseau
async function getJson(url, essais = 3) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(url, {
        headers: {
          accept: "application/json",
          origin: "https://www.ikea.com",
          referer: "https://www.ikea.com/",
        },
      });
      if (r.status >= 500 && k < essais - 1) {
        await new Promise((s) => setTimeout(s, 1000));
        continue;
      }
      if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
      return await r.json();
    } catch (e) {
      if (k >= essais - 1 || /-> 4\d\d/.test(e.message)) throw e;
      await new Promise((s) => setTimeout(s, 1000));
    }
  }
}
const marcheDe = (s) => {
  const m = /ikea\.com\/([a-z]{2})\/([a-z]{2})\//.exec(s || "");
  return m ? `${m[1]}/${m[2]}` : process.env.IKEA_MARKET || "fr/fr";
};
const apiDe = (marche) => `https://api.home-design.ikea.com/${marche}/ideas/sugarcube/api`;
async function chargerDesign(cible) {
  const marche = marcheDe(cible);
  if (fs.existsSync(cible) && /\.json$/i.test(cible))
    return { json: JSON.parse(fs.readFileSync(cible, "utf8")), marche, uuid: null, url: cible };
  let uuid = (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(cible) || [])[0];
  const url = (u) =>
    `${apiDe(marche)}/compositions/${u}/compiled/?geometry_type=${GEO}&manifest_mode=manifest&material_mode=true`;
  if (uuid) {
    try {
      return { json: await getJson(url(uuid)), marche, uuid, url: url(uuid) };
    } catch (e) {
      if (!/^https?:/.test(cible)) throw e;
    }
  }
  if (/^https?:/.test(cible)) {
    // lien court ou autre forme : on lit la page et on y cherche l'uuid de la composition
    const h = await (await fetch(cible, { redirect: "follow" })).text();
    const ids = [
      ...new Set(h.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []),
    ];
    for (const id of ids) {
      try {
        const j = await getJson(url(id), 1);
        if (j && j.composition) return { json: j, marche, uuid: id, url: url(id) };
      } catch (e) {}
    }
  }
  throw new Error("design introuvable pour " + cible);
}
// fiches des refs du panier : catalogue 3D (sans auth) puis recherche ikea.fr (nom, coloris, dimensions)
const CACHE = process.env.VERIF_CACHE || path.join(os.tmpdir(), "ikea-verif-cache.json");
let cache = null;
const cacheGet = () => {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    } catch (e) {
      cache = {};
    }
  }
  return cache;
};
const cacheSave = () => {
  try {
    const t = CACHE + "." + process.pid;
    fs.writeFileSync(t, JSON.stringify(cache));
    fs.renameSync(t, CACHE);
  } catch (e) {}
};
async function fichesRefs(nos, marche) {
  const C = cacheGet(),
    out = {},
    todo3d = nos.filter((n) => !C["3d:" + marche + ":" + n]);
  for (let i = 0; i < todo3d.length; i += 20) {
    const part = todo3d.slice(i, i + 20);
    try {
      const j = await getJson(
        `${apiDe(marche)}/furniture/?local_item_number=${part.join(",")}&geometry_type=${GEO}&material_mode=true`,
      );
      const arr = Array.isArray(j) ? j : Object.values(j || {});
      for (const n of part) C["3d:" + marche + ":" + n] = { absent: true };
      for (const f of arr)
        if (f && f.localItemNumber)
          C["3d:" + marche + ":" + f.localItemNumber] = {
            nom: f.name,
            type: f.typeName,
            design: f.validDesign,
            dims: dimsFiche(f),
            geo: f.geometryTypes || [f.geometryType],
          };
    } catch (e) {
      /* hors ligne : pas d'info 3D */
    }
  }
  const [mk, lg] = marche.split("/");
  await Promise.all(
    nos
      .filter((n) => !C["fr:" + marche + ":" + n])
      .map(async (n) => {
        try {
          const j = await getJson(
            `https://sik.search.blue.cdtapps.com/${mk}/${lg}/search-result-page?q=${n}&size=10&types=PRODUCT`,
            2,
          );
          let hit = null;
          for (const i of j.searchResultPage.products.main.items || []) {
            const p = i.product;
            if (!p) continue;
            for (const v of [p, ...((p.gprDescription && p.gprDescription.variants) || [])])
              if (v.itemNo === n) {
                hit = {
                  nom: v.name || p.name,
                  type: v.typeName || p.typeName,
                  design: v.validDesignText || "",
                  taille: v.itemMeasureReferenceText || p.itemMeasureReferenceText || "",
                };
                break;
              }
            if (hit) break;
          }
          C["fr:" + marche + ":" + n] = hit || { absent: true };
        } catch (e) {
          /* hors ligne */
        }
      }),
  );
  cacheSave();
  for (const n of nos) {
    const a = C["3d:" + marche + ":" + n] || {},
      b = C["fr:" + marche + ":" + n] || {};
    out[n] = {
      no: n,
      nom: b.nom || a.nom || "",
      type: b.type || a.type || "",
      design: b.design || a.design || "",
      taille: b.taille || "",
      dims: a.dims || tailleEnDims(b.taille),
      en3d: !!(a && !a.absent && a.nom),
      inconnu: !!(a.absent !== false && !a.nom && (b.absent || !b.nom)),
    };
  }
  return out;
}
const dimsFiche = (f) => ({
  w: (f.maxX - f.minX) * 100,
  d: (f.maxZ - f.minZ) * 100,
  h: (f.maxY - f.minY) * 100,
});
function tailleEnDims(s) {
  const m = String(s || "")
    .replace(/,/g, ".")
    .match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?/);
  return m ? { w: +m[1], d: +m[2], h: m[3] ? +m[3] : null } : null;
}

// ---------------------------------------------------------------- lecture du design IKEA
// modeles-3d.json (écrit par maquette-vers-ikea.js) : { "<furnitureId>|<sol|pile|mur>": { dyaw (rad), k:[x,z] (m) } } :
// l'éditeur rend ce modèle tourné de dyaw par rapport au cap enregistré, centre de sa boîte = origine + R(cap rendu)·k
function lireModeles(m) {
  if (m && typeof m === "object") return m;
  const f = m || path.join(__dirname, "..", "modeles-3d.json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return {};
  }
}
function lireDesign(J, modeles = {}) {
  const g = J.scene.gltfManifest || (J.scene.lastSuccessfulJob || {}).gltfManifest;
  const sc = g.extras.geomagical.geomagicalScenes[0];
  const rd = sc.roomDefinition || sc.roomTemplate;
  const V = {};
  for (const v of rd.vertices) V[v.id] = [v.position.x * 100, -v.position.y * 100];
  const S = surfaces(g);
  const fiches = {};
  for (const f of J.furnitures || []) fiches[f.id] = f;
  const placed = J.composition.placedfurnitureSet || [],
    byUid = Object.fromEntries(placed.map((p) => [p.uniqueId, p]));
  const sol = Object.values(S).find((s) => s.cls === "floor");
  const objets = [];
  for (const p of placed) {
    const f = fiches[p.furnitureId];
    const itemNo = no8(
      String(p.localProductMarketItemNumber || (f && f.localItemNumber) || "")
        .split("/")
        .pop(),
    );
    const o = {
      uid: p.uniqueId,
      itemNo,
      nom: f ? `${f.name} ${f.typeName}` : "?",
      design: f ? f.validDesign : "",
      fiche: f,
      parent: p.parentId,
      pose: "",
    };
    if (!f) {
      o.erreur = "fiche absente du JSON";
      objets.push(o);
      continue;
    }
    const q = [
        p.headingI || 0,
        p.headingJ || 0,
        p.headingK || 0,
        p.heading == null ? 1 : p.heading,
      ],
      P0 = [p.x, p.y, p.z];
    let toM; // point du modèle (m, y haut, façade +z) -> maquette [x, y, z] cm
    const surf = p.parentId === "SURFACE" ? S[p.parentAttachment] : null;
    if (surf && surf.cls === "wall") {
      o.pose = "mur " + p.parentAttachment;
      toM = (v) => {
        const w = add(qrot(surf.R, add(qrot(q, v), P0)), surf.T);
        return [w[0] * 100, w[1] * 100, w[2] * 100];
      };
    } else if (p.parentId === "SURFACE") {
      o.pose = "sol";
      if (sol && p.parentAttachment !== sol.id) o.pose = "surface " + p.parentAttachment;
      toM = (v) => {
        const r = add(qrot(q, v), P0);
        return [r[0] * 100, r[2] * 100, -r[1] * 100];
      };
    } else {
      o.pose = byUid[p.parentId] ? "sur " + p.parentId : "sur " + p.parentId + " (parent absent)";
      toM = (v) => {
        const w = add(qrot(q, v), P0);
        return [w[0] * 100, w[1] * 100, w[2] * 100];
      };
    }
    const b = {
      x0: Infinity,
      x1: -Infinity,
      y0: Infinity,
      y1: -Infinity,
      z0: Infinity,
      z1: -Infinity,
    };
    for (const x of [f.minX, f.maxX])
      for (const y of [f.minY, f.maxY])
        for (const z of [f.minZ, f.maxZ]) {
          const m = toM([x, y, z]);
          b.x0 = Math.min(b.x0, m[0]);
          b.x1 = Math.max(b.x1, m[0]);
          b.y0 = Math.min(b.y0, m[1]);
          b.y1 = Math.max(b.y1, m[1]);
          b.z0 = Math.min(b.z0, m[2]);
          b.z1 = Math.max(b.z1, m[2]);
        }
    const o0 = toM([0, 0, 0]),
      oz = toM([0, 0, 1]);
    o.boite = b;
    o.facade = [oz[0] - o0[0], oz[2] - o0[2]];
    const n = Math.hypot(...o.facade) || 1;
    o.facade = o.facade.map((v) => v / n);
    o.vertical = Math.abs((oz[1] - o0[1]) / 100) < 0.05;
    const mode = /^mur/.test(o.pose) ? "mur" : /^sur/.test(o.pose) ? "pile" : "sol",
      L = modeles.__parUid ? modeles[p.uniqueId] : modeles[`${f.id}|${mode}`];
    if (L && isFinite(L.dyaw) && o.vertical) {
      // rendu prévu par la correction apprise (sinon le JSON enregistré, volontairement compensé, paraîtrait faux)
      const ps = Math.atan2(o.facade[0], o.facade[1]) + L.dyaw,
        c = Math.cos(ps),
        s = Math.sin(ps),
        k = L.k || [0, 0];
      const cx = o0[0] + (k[0] * c + k[1] * s) * 100,
        cz = o0[2] + (-k[0] * s + k[1] * c) * 100;
      const w = (f.maxX - f.minX) * 100,
        d = (f.maxZ - f.minZ) * 100,
        hx = (Math.abs(c) * w + Math.abs(s) * d) / 2,
        hz = (Math.abs(s) * w + Math.abs(c) * d) / 2;
      o.boiteEnregistree = { ...b };
      Object.assign(b, { x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz });
      o.facade = [s, c];
      o.corrige = `cap +${r1((L.dyaw * 180) / Math.PI)}° et pivot appris (modeles-3d.json)`;
    }
    objets.push(o);
  }
  return { rd, V, S, objets, composition: J.composition };
}
// cycle des sommets de la pièce IKEA (ordre des murs) -> [{id, p}] + murs dans l'ordre
function cyclePiece(rd, V) {
  const adj = {};
  for (const w of rd.walls)
    for (const [a, b] of [
      [w.vertices[0], w.vertices[1]],
      [w.vertices[1], w.vertices[0]],
    ])
      (adj[a] = adj[a] || []).push({ to: b, w });
  const start = rd.walls[0].vertices[0],
    ids = [start],
    ws = [];
  let prev = null,
    cur = start;
  for (let k = 0; k < rd.walls.length; k++) {
    const nx = (adj[cur] || []).find((e) => e.w !== prev);
    if (!nx) break;
    ws.push(nx.w);
    prev = nx.w;
    cur = nx.to;
    if (cur === start) break;
    ids.push(cur);
  }
  return { ids, murs: ws, pts: ids.map((i) => V[i]) };
}

// ---------------------------------------------------------------- contrôles de la pièce
// transformations du groupe diédral (rotations de 90° et miroir) appliquées au plan IKEA pour le recaler sur P
const DIHEDRAL = [0, 1, 2, 3].flatMap((k) =>
  [false, true].map((m) => ({
    k,
    m,
    nom: (m ? "miroir + " : "") + "rotation " + k * 90 + "°",
    f: (p) => {
      let x = m ? -p[0] : p[0],
        z = p[1];
      for (let i = 0; i < k; i++) [x, z] = [-z, x];
      return [x, z];
    },
  })),
);
function recaler(P, Q) {
  const cP = centroide(P);
  let best = null;
  for (const D of DIHEDRAL) {
    const DQ = Q.map(D.f),
      cQ = centroide(DQ);
    let t = [cP[0] - cQ[0], cP[1] - cQ[1]];
    const app = (p) => add(D.f(p), t);
    const near = () => P.map((a) => Math.min(...Q.map((q) => dist(a, app(q)))));
    // affinage : moyenne des écarts des appariements proches
    const pairs = P.map((a) => {
      const q = Q.map(app).sort((u, v) => dist(a, u) - dist(a, v))[0];
      return [a[0] - q[0], a[1] - q[1]];
    });
    const good = pairs.filter((d) => Math.hypot(...d) < 30);
    if (good.length >= 3)
      t = add(t, [
        good.reduce((s, d) => s + d[0], 0) / good.length,
        good.reduce((s, d) => s + d[1], 0) / good.length,
      ]);
    const n1 = near(),
      n2 = Q.map((q) => Math.min(...P.map((a) => dist(a, app(q)))));
    const score = Math.max(...n1, ...n2);
    if (!best || score < best.score - 1e-6) best = { D, t, score, app };
  }
  return best;
}
// signature intrinsèque (indépendante de la position) : longueurs des murs + ouvertures, parcours dans le sens trigonométrique
function signature(pts, ouv) {
  // ouv[i] = [{a,b}] distances depuis pts[i] le long du segment i
  let P = pts.map((p, i) => ({ p, o: ouv[i] || [] }));
  const sgn = Math.sign(aireSignee(pts));
  if (sgn < 0) {
    // on retourne le parcours : le segment i (P[i]->P[i+1]) devient (P[i+1]->P[i])
    const n = P.length,
      L = (i) => dist(P[i].p, P[(i + 1) % n].p);
    const segs = P.map((e, i) => ({
      len: L(i),
      o: e.o.map((o) => ({ a: L(i) - o.b, b: L(i) - o.a, verre: o.verre })),
    })).reverse();
    return segs;
  }
  return P.map((e, i) => ({ len: dist(e.p, P[(i + 1) % P.length].p), o: e.o }));
}
function compareSig(A, B, tol) {
  // meilleur décalage cyclique ; renvoie l'écart max (longueurs et ouvertures)
  if (A.length !== B.length) return { err: Infinity };
  let best = { err: Infinity };
  for (let s = 0; s < A.length; s++) {
    let e = 0;
    for (let i = 0; i < A.length; i++) {
      const a = A[i],
        b = B[(i + s) % B.length];
      e = Math.max(e, Math.abs(a.len - b.len));
      if (a.o.length !== b.o.length) e = Math.max(e, 1000);
      else {
        const sa = [...a.o].sort((u, v) => u.a - v.a),
          sb = [...b.o].sort((u, v) => u.a - v.a);
        sa.forEach((o, k) => {
          e = Math.max(e, Math.abs(o.a - sb[k].a), Math.abs(o.b - sb[k].b));
        });
      }
    }
    if (e < best.err) best = { err: e, decalage: s };
  }
  return best;
}
const miroirSig = (S) => {
  const r = S.map((s) => ({
    len: s.len,
    o: s.o.map((o) => ({ a: s.len - o.b, b: s.len - o.a, verre: o.verre })),
  })).reverse();
  return r;
};

function controlesPiece(M, D, o, checks) {
  const add = (nom, ok, attendu, obtenu, ecart, extra = {}) =>
    checks.push({ nom, ok, attendu, obtenu, ecart, ...extra });
  const P = M.P,
    n = P.length,
    cyc = cyclePiece(D.rd, D.V),
    Q = cyc.pts;
  // ouvertures IKEA par segment du cycle (distances depuis le sommet de départ du segment dans le cycle)
  const ouvQ = cyc.murs.map((w, i) => {
    const a = D.V[cyc.ids[i]],
      b = D.V[cyc.ids[(i + 1) % cyc.ids.length]],
      L = dist(a, b),
      dir = w.vertices[0] === cyc.ids[i] ? 1 : -1;
    return D.rd.wallElements
      .filter((e) => e.wall === w.id)
      .map((e) => {
        const c = dir > 0 ? e.position.x * 100 : L - e.position.x * 100,
          hw = e.size.w * 50;
        return { a: c - hw, b: c + hw };
      });
  });
  const ouvP = P.map((_, i) =>
    ((M.OPEN || {})[i] || []).map((x) => ({ a: x.a, b: x.b, verre: !!x.glass })),
  );
  // 1. sens intrinsèque (aire signée + ordre des murs et ouvertures)
  const sP = signature(P, ouvP),
    sQ = signature(Q, ouvQ);
  const sensDe = (A, B) => {
    const d = compareSig(A, B),
      m = compareSig(A, miroirSig(B));
    if (Math.min(d.err, m.err) > 10) return { s: null, d, m };
    if (Math.abs(d.err - m.err) < 0.5) return { s: "sym", d, m };
    return { s: d.err < m.err ? "même sens" : "MIROIR", d, m };
  };
  let r = sensDe(sP, sQ),
    base = "murs + ouvertures";
  if (r.s !== "même sens" && r.s !== "MIROIR") {
    // ouvertures différentes ou forme symétrique : on tranche sur la forme seule
    const nu = (S) => S.map((x) => ({ len: x.len, o: [] })),
      r2 = sensDe(nu(sP), nu(sQ));
    if (r2.s === "même sens" || r2.s === "MIROIR") {
      r = r2;
      base = "murs seuls (ouvertures différentes)";
    }
  }
  const direct = r.d,
    miroir = r.m;
  let sens =
    r.s === "sym"
      ? "indéterminable (forme et ouvertures symétriques)"
      : r.s == null
        ? "indéterminable (murs différents)"
        : r.s + (base !== "murs + ouvertures" ? " [" + base + "]" : "");
  add(
    "sens de la pièce (aire signée + ordre des murs/ouvertures)",
    !/^MIROIR/.test(sens),
    "même sens",
    sens + ` (écart direct ${r1(direct.err)} cm, en miroir ${r1(miroir.err)} cm)`,
    null,
    {
      detail: {
        aireMaquette: r1(aireSignee(P) / 1e4),
        aireIkea: r1(aireSignee(Q) / 1e4),
        unite: "m² (signe = sens de parcours)",
      },
    },
  );
  // 2. recalage dans le repère des meubles : P doit coïncider avec la pièce IKEA SANS transformation
  const fit = recaler(P, Q);
  const ident = !fit.D.m && fit.D.k === 0 && Math.hypot(...fit.t) <= o.tolMur && fit.score <= 3;
  add(
    "repère de la pièce (sommets IKEA = P, x=100·x, z=−100·y)",
    ident,
    "identité",
    ident
      ? "identité"
      : `${fit.D.nom}, translation (${r1(fit.t[0])}, ${r1(fit.t[1])}) cm, écart max ${r1(fit.score)} cm`,
    null,
    {
      detail: fit.D.m
        ? "la pièce IKEA est la MIROIR de la maquette (renfoncement / ouvertures du mauvais côté)"
        : ident
          ? ""
          : "les meubles posés en repère maquette seront décalés/tournés par rapport à la pièce",
    },
  );
  if (fit.D.m && sens === "même sens") checks[checks.length - 2].ok = false;
  // 3. murs : chaque segment de P apparié à un mur IKEA (après recalage)
  const app = fit.app,
    murDeSeg = [];
  for (let i = 0; i < n; i++) {
    const a = P[i],
      b = P[(i + 1) % n],
      L = dist(a, b);
    let best = null;
    for (const w of D.rd.walls) {
      const u = app(D.V[w.vertices[0]]),
        v = app(D.V[w.vertices[1]]);
      const d1 = Math.max(dist(u, a), dist(v, b)),
        d2 = Math.max(dist(v, a), dist(u, b)),
        d = Math.min(d1, d2);
      if (!best || d < best.d) best = { w, d, sensDirect: d1 <= d2 };
    }
    const got = best && best.d < 40 ? dist(D.V[best.w.vertices[0]], D.V[best.w.vertices[1]]) : null;
    murDeSeg[i] = best && best.d < 40 ? best : null;
    add(
      `mur ${i} (${a.map(r1)} → ${b.map(r1)})`,
      got != null && Math.abs(got - L) <= o.tolMur,
      r1(L),
      r1(got),
      got == null ? null : r1(got - L),
    );
  }
  if (D.rd.walls.length !== n)
    add("nombre de murs", false, n, D.rd.walls.length, D.rd.walls.length - n);
  // 4. plafond
  const hc = D.rd.ceiling && D.rd.ceiling.height * 100;
  add(
    "hauteur sous plafond",
    hc != null && Math.abs(hc - M.H) <= o.tolMur,
    M.H,
    r1(hc),
    r1(hc - M.H),
  );
  // 5. ouvertures
  const els = D.rd.wallElements || [],
    used = new Set();
  let nOuv = 0;
  for (let i = 0; i < n; i++)
    for (const x of (M.OPEN || {})[i] || []) {
      nOuv++;
      const nom = `ouverture mur ${i} [${r1(x.a)}–${r1(x.b)}]${x.glass ? " (vitrée)" : ""}`,
        m = murDeSeg[i];
      const cands = m ? els.filter((e) => e.wall === m.w.id && !used.has(e)) : [];
      const L = dist(P[i], P[(i + 1) % n]);
      const pos = (e) => {
        const c = m.sensDirect ? e.position.x * 100 : L - e.position.x * 100,
          hw = e.size.w * 50;
        return {
          a: c - hw,
          b: c + hw,
          h: e.size.h * 100,
          bas: (e.position.y - e.size.h / 2) * 100,
        };
      };
      const e = cands.sort((u, v) => Math.abs(pos(u).a - x.a) - Math.abs(pos(v).a - x.a))[0];
      if (!e) {
        const ail = els.filter((z) => !used.has(z));
        add(
          nom,
          false,
          "présente",
          ail.length ? "absente de ce mur (une ouverture IKEA est sur un autre mur)" : "absente",
          null,
        );
        continue;
      }
      used.add(e);
      const g = pos(e),
        ex = { a: x.a, b: x.b, h: x.h, bas: x.y0 != null ? x.y0 : x.sill != null ? x.sill : 0 };
      const d = {
        debut: g.a - ex.a,
        fin: g.b - ex.b,
        hauteur: x.h != null ? g.h - ex.h : 0,
        bas: g.bas - ex.bas,
      };
      const ok = Object.values(d).every((v) => Math.abs(v) <= o.tolMur);
      add(
        nom,
        ok,
        `${r1(ex.a)}–${r1(ex.b)} h ${r1(ex.h)} bas ${r1(ex.bas)}`,
        `${r1(g.a)}–${r1(g.b)} h ${r1(g.h)} bas ${r1(g.bas)}`,
        { debut: r1(d.debut), fin: r1(d.fin), hauteur: r1(d.hauteur), bas: r1(d.bas) },
        { type: (D.rd.assets[e.asset] || {}).uuid },
      );
    }
  if (els.length !== nOuv) add("nombre d’ouvertures", false, nOuv, els.length, els.length - nOuv);
  return { fit, cyc, ident, sens };
}

// ---------------------------------------------------------------- contrôles des meubles et des refs
async function controlesMeubles(M, Vn, D, fit, marche, o, checks, avert) {
  const add = (nom, ok, attendu, obtenu, ecart, extra = {}) =>
    checks.push({ nom, ok, attendu, obtenu, ecart, ...extra });
  // entrées « panier seulement » (kind 'none' ou emprise < 2 cm, ex. accessoires) : ni posées ni contrôlées en 3D
  const panierSeul = (it) => it.kind === "none" || Math.min(+it.w || 0, +it.d || 0, +it.h || 0) < 2;
  for (const it of M.ITEMS.filter((it) => estPresent(it, Vn) && panierSeul(it)))
    avert.push(
      `${it.id}${it.nm ? " (" + it.nm + ")" : ""} : panier seulement (kind 'none' ou emprise < 2 cm), non contrôlé en 3D`,
    );
  const entrees = M.ITEMS.filter((it) => estPresent(it, Vn) && !panierSeul(it)).map((it) => ({
    it,
    b: boiteEntree(it, Vn),
    objets: [],
  }));
  const horsVersion = M.ITEMS.filter((it) => !estPresent(it, Vn));
  // objets ramenés dans le repère de la maquette (recalage de la pièce, identité si la pièce est conforme)
  const T = (p) => fit.app(p);
  for (const ob of D.objets) {
    if (!ob.boite) continue;
    const b = ob.boite,
      cs = [
        [b.x0, b.z0],
        [b.x1, b.z0],
        [b.x0, b.z1],
        [b.x1, b.z1],
      ].map(T);
    ob.b = {
      x0: Math.min(...cs.map((c) => c[0])),
      x1: Math.max(...cs.map((c) => c[0])),
      z0: Math.min(...cs.map((c) => c[1])),
      z1: Math.max(...cs.map((c) => c[1])),
      y0: b.y0,
      y1: b.y1,
    };
    const f0 = T([0, 0]),
      f1 = T(ob.facade);
    ob.f = [f1[0] - f0[0], f1[1] - f0[1]];
  }
  const refsDe = (it) => [
    ...(it.refs || []).map((r) => no8(r.itemNo)),
    ...(it.sub3d ? [no8(it.sub3d)] : []),
  ];
  // fiches des refs du panier
  const allRefs = [...new Set(entrees.flatMap((e) => (e.it.refs || []).map((r) => no8(r.itemNo))))];
  const F = allRefs.length ? await fichesRefs(allRefs, marche) : {};
  // appariement objet -> entrée, par priorité : même ref, même nom de gamme (substitut), puis géométrie (centre dans
  // l'emprise ±8 cm et ±15 cm en hauteur, la plus petite emprise l'emporte) ; à défaut, la seule entrée de même ref / nom
  const memeNom = (it, ob) => {
    const mots = norm(ob.fiche && ob.fiche.name).split(" ");
    return (it.refs || []).some((r) => {
      const f = F[no8(r.itemNo)];
      return f && f.nom && mots.includes(norm(f.nom));
    });
  };
  const vol = (e) => (e.b.x1 - e.b.x0) * (e.b.z1 - e.b.z0) * (e.b.y1 - e.b.y0);
  const extra = [];
  for (const ob of D.objets) {
    if (!ob.b) {
      extra.push(ob);
      continue;
    }
    const c = [(ob.b.x0 + ob.b.x1) / 2, (ob.b.z0 + ob.b.z1) / 2, (ob.b.y0 + ob.b.y1) / 2];
    const xz = entrees.filter(
      (e) => c[0] >= e.b.x0 - 8 && c[0] <= e.b.x1 + 8 && c[1] >= e.b.z0 - 8 && c[1] <= e.b.z1 + 8,
    );
    const xyz = xz.filter((e) => c[2] >= e.b.y0 - 15 && c[2] <= e.b.y1 + 15);
    const parRef = xz.filter((e) => e.it.st !== "own" && refsDe(e.it).includes(ob.itemNo)),
      parNom = xz.filter((e) => e.it.st !== "own" && memeNom(e.it, ob));
    let cands = parRef.length ? parRef : parNom.length ? parNom : xyz;
    if (!cands.length) {
      const r = entrees.filter((e) => refsDe(e.it).includes(ob.itemNo));
      if (r.length === 1) cands = r;
    }
    if (!cands.length) {
      const r = entrees.filter((e) => memeNom(e.it, ob));
      if (r.length === 1) cands = r;
    }
    const e = cands.sort((a, b) => vol(a) - vol(b))[0];
    if (e) e.objets.push(ob);
    else extra.push(ob);
  }
  const lab = (it) => `${it.id}${it.nm ? " (" + it.nm + ")" : ""}`;
  const P = M.P;
  // repère des meubles (anti-miroir côté meubles, ex. W() calé sur une pièce inversée) : pour chaque transformation du groupe
  // diédral, translation de consensus entre centres des entrées et centres des objets de même ref ; on compte les entrées expliquées
  {
    const pairs = [];
    for (const E of entrees)
      for (const ob of D.objets)
        if (ob.b && (refsDe(E.it).includes(ob.itemNo) || memeNom(E.it, ob)))
          pairs.push({
            E,
            c: [(ob.b.x0 + ob.b.x1) / 2, (ob.b.z0 + ob.b.z1) / 2],
            e: [(E.b.x0 + E.b.x1) / 2, (E.b.z0 + E.b.z1) / 2],
          });
    const dedans = (q, b) =>
      q[0] >= b.x0 - 6 && q[0] <= b.x1 + 6 && q[1] >= b.z0 - 6 && q[1] <= b.z1 + 6;
    const score = (Dh, t) =>
      new Set(
        pairs
          .filter((p) => {
            const q = Dh.f(p.c);
            return dedans([q[0] + t[0], q[1] + t[1]], p.E.b);
          })
          .map((p) => p.E),
      ).size;
    let best = null;
    for (const Dh of DIHEDRAL)
      for (const p of pairs) {
        const t = [p.e[0] - Dh.f(p.c)[0], p.e[1] - Dh.f(p.c)[1]];
        const n = score(Dh, t);
        if (!best || n > best.n) best = { Dh, t, n };
      }
    const nId = score(DIHEDRAL[0], [0, 0]);
    // l'emprise d'un meuble n'est pas son centre : on tolère 6 cm ; seul un repère qui explique nettement plus d'entrées compte
    if (
      best &&
      pairs.length >= 3 &&
      best.n >= nId + 2 &&
      !(best.Dh.k === 0 && !best.Dh.m && Math.hypot(...best.t) < 6)
    )
      add(
        "repère des meubles",
        false,
        "meubles dans le repère de la pièce",
        `${best.n} entrée(s) expliquées par ${best.Dh.nom} + translation (${best.t.map(r1).join(", ")}) cm contre ${nId} sans transformation`,
        null,
        {
          detail: best.Dh.m
            ? "MEUBLES EN MIROIR par rapport à la pièce (repère de pose inversé)"
            : "meubles décalés / tournés par rapport à la pièce",
        },
      );
    else if (pairs.length)
      add(
        "repère des meubles",
        true,
        "meubles dans le repère de la pièce",
        `${nId} entrée(s) en place sans transformation`,
        null,
      );
  }
  for (const E of entrees) {
    const { it, b } = E;
    if (!E.objets.length) {
      const posable = it.st === "own" || (it.refs && it.refs.length) || it.sub3d;
      if (posable)
        add(`meuble ${lab(it)} : présence`, false, "posé", "MANQUANT", null, { entree: it.id });
      else avert.push(`${lab(it)} : ni refs ni objet possédé, non contrôlé`);
      continue;
    }
    // emprise obtenue = union des objets
    const g = E.objets.reduce(
      (u, ob) => ({
        x0: Math.min(u.x0, ob.b.x0),
        x1: Math.max(u.x1, ob.b.x1),
        z0: Math.min(u.z0, ob.b.z0),
        z1: Math.max(u.z1, ob.b.z1),
        y0: Math.min(u.y0, ob.b.y0),
        y1: Math.max(u.y1, ob.b.y1),
      }),
      { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity },
    );
    E.g = g;
    const fa = facadeAttendue(it, b, P, o, E.objets);
    E.fa = fa;
    const surMur = E.objets.some((x) => /^mur/.test(x.pose));
    // position : axe latéral = centre ; axe de profondeur = côté du dos (contre le mur) si la façade est connue, sinon centre
    const ec = {},
      connu = [];
    const axes = fa ? (fa.f[0] !== 0 ? { lat: "z", dep: "x" } : { lat: "x", dep: "z" }) : null;
    for (const k of ["x", "z"]) {
      if (axes && k === axes.dep) {
        const dosMin = fa.dos[0] === "-";
        ec[k] = dosMin ? g[k + "0"] - b[k + "0"] : g[k + "1"] - b[k + "1"];
      } else ec[k] = (g[k + "0"] + g[k + "1"] - b[k + "0"] - b[k + "1"]) / 2;
    }
    ec.y = g.y0 - b.y0;
    let limDep = o.tolMeuble;
    if (axes) {
      const dDos = distancesDos(P, b)[fa.dos];
      if (dDos < 1) limDep = surMur ? o.decolleMur : o.plinthe;
    }
    const lim = (k) => (axes && k === axes.dep ? limDep : o.tolMeuble);
    let limY = o.tolMeuble;
    if (it.legs && Math.abs(ec.y + it.legs) <= o.tolMeuble) {
      limY = it.legs + o.tolMeuble;
      connu.push(`pieds ${it.legs} cm non modélisés`);
    }
    // axe latéral (ou sans façade connue) dont la largeur IKEA diffère de la maquette : un bord aligné suffit, l'écart de taille est compté par l'emprise
    for (const k of ["x", "z"])
      if (
        !(axes && k === axes.dep) &&
        Math.abs(g[k + "1"] - g[k + "0"] - (b[k + "1"] - b[k + "0"])) > o.tolMeuble
      ) {
        const bord = [g[k + "0"] - b[k + "0"], g[k + "1"] - b[k + "1"]].sort(
          (u, v) => Math.abs(u) - Math.abs(v),
        )[0];
        if (Math.abs(bord) <= o.tolMeuble && Math.abs(ec[k]) > o.tolMeuble) {
          connu.push(`${k} : bord aligné (largeur IKEA ≠ maquette, écart de centre ${r1(ec[k])})`);
          ec[k] = bord;
        }
      }
    const badPos = ["x", "z", "y"].filter((k) => Math.abs(ec[k]) > (k === "y" ? limY : lim(k)));
    add(
      `meuble ${lab(it)} : position`,
      !badPos.length,
      `x ${r1(b.x0)}–${r1(b.x1)} z ${r1(b.z0)}–${r1(b.z1)} y ${r1(b.y0)}`,
      `x ${r1(g.x0)}–${r1(g.x1)} z ${r1(g.z0)}–${r1(g.z1)} y ${r1(g.y0)}`,
      { x: r1(ec.x), z: r1(ec.z), y: r1(ec.y) },
      {
        entree: it.id,
        reference: axes ? `centre ${axes.lat}, dos ${fa.dos}` : "centre",
        tolerance: { x: lim("x"), z: lim("z"), y: limY },
        connu: connu.join(" ; ") || undefined,
      },
    );
    // emprise : plus grande que la maquette = écart ; plus petite = avertissement (meuble catalogue plus petit que le volume réservé)
    const ds = {
      x: g.x1 - g.x0 - (b.x1 - b.x0),
      z: g.z1 - g.z0 - (b.z1 - b.z0),
      y: g.y1 - g.y0 - (b.y1 - b.y0),
    };
    if (it.legs && ds.y < 0 && Math.abs(ds.y + it.legs) <= o.tolMeuble) ds.yConnu = true;
    const trop = ["x", "z", "y"].filter((k) => ds[k] > o.tolMeuble),
      moins = ["x", "z", "y"].filter((k) => ds[k] < -o.tolMeuble && !(k === "y" && ds.yConnu));
    const own = it.st === "own";
    // modèle commandé lui-même (ref exacte) plus grand que la maquette : c'est la maquette qu'il faut corriger
    const refsIt = (it.refs || []).map((r) => no8(r.itemNo)),
      exact =
        E.objets.length && E.objets.every((ob) => refsIt.includes(ob.itemNo) || memeNom(it, ob));
    const classe =
      trop.length && !own && exact
        ? `emprise du modèle IKEA ≠ maquette : réel ${trop.map((k) => k + " " + r1(k === "x" ? g.x1 - g.x0 : k === "z" ? g.z1 - g.z0 : g.y1 - g.y0) + " cm (maquette " + r1(k === "x" ? b.x1 - b.x0 : k === "z" ? b.z1 - b.z0 : b.y1 - b.y0) + ")").join(", ")} → corriger la maquette`
        : undefined;
    add(
      `meuble ${lab(it)} : emprise${classe ? " (modèle IKEA ≠ maquette)" : ""}`,
      !trop.length || own || (!!classe && !o.empriseModeleBloquante),
      `${r1(b.x1 - b.x0)}×${r1(b.z1 - b.z0)}×${r1(b.y1 - b.y0)}`,
      `${r1(g.x1 - g.x0)}×${r1(g.z1 - g.z0)}×${r1(g.y1 - g.y0)}`,
      { x: r1(ds.x), z: r1(ds.z), y: r1(ds.y) },
      {
        entree: it.id,
        classe,
        avert:
          own && trop.length
            ? "objet déjà possédé : substitut visuel plus grand (non bloquant)"
            : moins.length
              ? `plus petit que la maquette sur ${moins.join(", ")}`
              : undefined,
      },
    );
    if (moins.length && !trop.length)
      avert.push(
        `${lab(it)} : emprise IKEA plus petite que la maquette (${moins.map((k) => k + " " + r1(ds[k])).join(", ")} cm)`,
      );
    // rotation de chaque objet
    if (fa) {
      const bad = [];
      for (const ob of E.objets) {
        if (!ob.vertical) {
          bad.push(`${ob.nom} n'est pas debout`);
          continue;
        }
        const d = Math.abs(
          ((((Math.atan2(ob.f[1], ob.f[0]) - Math.atan2(fa.f[1], fa.f[0])) * 180) / Math.PI + 540) %
            360) -
            180,
        );
        if (d > o.tolRot)
          bad.push(
            `${ob.itemNo} ${ob.nom} façade ${nomDir(ob.f)} (${r1(d)}°)${reoriente(ob) ? " [" + reoriente(ob) + "]" : ""}`,
          );
      }
      add(
        `meuble ${lab(it)} : rotation`,
        !bad.length,
        "façade " + nomDir(fa.f) + " — " + fa.pourquoi,
        bad.length ? bad.join(" ; ") : "façade " + nomDir(fa.f),
        null,
        { entree: it.id },
      );
    } else
      avert.push(
        `${lab(it)} : orientation non contrôlée (ni 'face' ni mur à moins de ${o.distDos} cm) ; obtenu ${E.objets.map((x) => nomDir(x.f)).join(", ")}`,
      );
    // refs : posée vs panier, teinte
    for (const ob of E.objets) {
      const nm = `meuble ${lab(it)} : ref ${ob.itemNo} ${ob.nom} ${ob.design}`;
      if (it.st === "own") {
        add(nm, true, "objet déjà possédé (hors panier)", "substitut visuel", null, {
          entree: it.id,
          ref: "substitut-possede",
        });
        continue;
      }
      const refs = (it.refs || []).map((r) => no8(r.itemNo));
      if (refs.includes(ob.itemNo)) {
        add(nm, true, "ref du panier", "identique", null, { entree: it.id, ref: "exacte" });
        continue;
      }
      // ref du panier que l'objet représente : même nom, dimensions les plus proches
      const od = dimsFiche(ob.fiche);
      const mots = norm(ob.fiche.name).split(" ");
      const sc = (r) => {
        const f = F[r] || {};
        let s = 0;
        if (!f.nom || !mots.includes(norm(f.nom))) s += 1000;
        if (f.dims)
          s +=
            Math.abs((f.dims.w || 0) - od.w) +
            Math.abs((f.dims.d || 0) - od.d) +
            (f.dims.h ? Math.abs(f.dims.h - od.h) : 40);
        else s += 500;
        return s;
      };
      const ref = refs.slice().sort((a, c) => sc(a) - sc(c))[0];
      const fr = F[ref] || {};
      const autreProduit = !(fr.nom && mots.includes(norm(fr.nom)));
      const memeTeinte = fr.design ? norm(fr.design) === norm(ob.design) : null;
      const force = it.sub3d && no8(it.sub3d) === ob.itemNo;
      const evitable = fr.en3d; // la ref commandée existe dans le catalogue 3D : la substitution n'était pas nécessaire
      const txt = `${ref} ${fr.nom} ${fr.type} ${fr.design} ${fr.taille || ""}`
        .replace(/\s+/g, " ")
        .trim();
      const autreVersion = horsVersion.find((h) => refsDe(h).includes(ob.itemNo));
      const verdict =
        (force ? "sub3d imposé par la maquette ; " : "") +
        (autreProduit
          ? "AUTRE PRODUIT (gamme différente de toutes les refs du panier)"
          : "substitution") +
        (memeTeinte === false
          ? ` ET TEINTE DIFFÉRENTE (posé « ${ob.design} », commandé « ${fr.design} »)`
          : memeTeinte
            ? " (même teinte)"
            : " (teinte de la ref commandée inconnue)") +
        (evitable
          ? " ; la ref commandée existe dans le catalogue 3D"
          : " ; ref commandée absente du catalogue 3D") +
        (autreVersion
          ? ` ; cette ref appartient à « ${autreVersion.id} », absente de la version ${Vn} (maquette modifiée après le design ?)`
          : "");
      const bloquant = autreProduit || (evitable && !force);
      add(nm, !bloquant, txt || "ref du panier", verdict, null, {
        entree: it.id,
        ref: "substitution",
        avert: !bloquant ? verdict : undefined,
      });
      if (!bloquant)
        avert.push(
          `${lab(it)} : ${ob.itemNo} ${ob.nom} ${ob.design} posé pour ${txt} — ${verdict}`,
        );
    }
  }
  for (const ob of extra) {
    const autre = horsVersion.find((h) => refsDe(h).includes(ob.itemNo));
    add(
      `meuble en trop : ${ob.itemNo} ${ob.nom} ${ob.design}`,
      false,
      "aucun",
      ob.b
        ? `x ${r1(ob.b.x0)}–${r1(ob.b.x1)} z ${r1(ob.b.z0)}–${r1(ob.b.z1)} y ${r1(ob.b.y0)}–${r1(ob.b.y1)}`
        : ob.erreur || "?",
      null,
      {
        detail: autre
          ? `ref de « ${autre.id} », entrée absente de la version ${Vn}`
          : "ne correspond à aucune entrée de la version",
      },
    );
  }
  return { entrees, extra };
}

// objets dont l'éditeur peut changer le cap au chargement (le JSON stocké diffère alors du rendu ; cf. 2e passe de maquette-vers-ikea.js)
function reoriente(ob) {
  const comb = ob.fiche && ((ob.fiche.metadata || {}).placeables || {}).combinations;
  if (Array.isArray(comb) && comb.some((c) => Array.isArray(c) && c.length > 1))
    return "ancrage sol+mur obligatoire : l’éditeur le replaque dos au mur, cap compensé à la pose possible";
  if (!/^SURFACE$/.test(ob.parent || ""))
    return "posé sur un autre meuble : l’éditeur peut le tourner, cap compensé à la pose possible";
  return "";
}

// ---------------------------------------------------------------- plan SVG
function planSvg(M, Vn, D, fit, res, titre) {
  const ecartE = new Set(res.ecarts.map((c) => c.entree).filter(Boolean));
  const Qp = fit.cyc.pts.map(fit.app);
  const all = [
    ...M.P,
    ...Qp,
    ...res.meubles.entrees.flatMap((e) => [
      [e.b.x0, e.b.z0],
      [e.b.x1, e.b.z1],
      ...(e.g
        ? [
            [e.g.x0, e.g.z0],
            [e.g.x1, e.g.z1],
          ]
        : []),
    ]),
    ...res.meubles.extra
      .filter((o) => o.b)
      .flatMap((o) => [
        [o.b.x0, o.b.z0],
        [o.b.x1, o.b.z1],
      ]),
  ];
  const mnx = Math.min(...all.map((p) => p[0])) - 20,
    mxx = Math.max(...all.map((p) => p[0])) + 20,
    mnz = Math.min(...all.map((p) => p[1])) - 20,
    mxz = Math.max(...all.map((p) => p[1])) + 20;
  const S = Math.min(2.2, 900 / (mxx - mnx)),
    W = (mxx - mnx) * S,
    Hh = (mxz - mnz) * S,
    X = (x) => ((x - mnx) * S).toFixed(1),
    Z = (z) => ((z - mnz) * S).toFixed(1);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${(Hh + 70).toFixed(0)}" font-family="sans-serif"><rect width="100%" height="100%" fill="#fff"/>`;
  svg += `<polygon points="${Qp.map((p) => X(p[0]) + "," + Z(p[1])).join(" ")}" fill="#f1ede4" stroke="${res.piece.ok ? "#666" : "#d11"}" stroke-width="3"/>`;
  svg += `<polygon points="${M.P.map((p) => X(p[0]) + "," + Z(p[1])).join(" ")}" fill="none" stroke="#000" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  M.P.forEach((p, i) => {
    const q = M.P[(i + 1) % M.P.length],
      L = dist(p, q);
    for (const x of (M.OPEN || {})[i] || []) {
      const a = [p[0] + ((q[0] - p[0]) * x.a) / L, p[1] + ((q[1] - p[1]) * x.a) / L],
        b = [p[0] + ((q[0] - p[0]) * x.b) / L, p[1] + ((q[1] - p[1]) * x.b) / L];
      svg += `<line x1="${X(a[0])}" y1="${Z(a[1])}" x2="${X(b[0])}" y2="${Z(b[1])}" stroke="${x.glass ? "#4f9be6" : "#c08a4a"}" stroke-width="7" stroke-opacity=".55"/>`;
    }
  });
  for (const e of res.meubles.entrees) {
    const bad = ecartE.has(e.it.id),
      b = e.b;
    svg += `<rect x="${X(b.x0)}" y="${Z(b.z0)}" width="${((b.x1 - b.x0) * S).toFixed(1)}" height="${((b.z1 - b.z0) * S).toFixed(1)}" fill="none" stroke="${bad ? "#d11" : "#000"}" stroke-dasharray="4 3"/>`;
    for (const ob of e.objets)
      svg +=
        `<rect x="${X(ob.b.x0)}" y="${Z(ob.b.z0)}" width="${((ob.b.x1 - ob.b.x0) * S).toFixed(1)}" height="${((ob.b.z1 - ob.b.z0) * S).toFixed(1)}" fill="${bad ? "#d11" : /^mur/.test(ob.pose) ? "#d9822b" : /^sur/.test(ob.pose) ? "#3a9b5a" : "#2f6fb0"}" fill-opacity="${bad ? 0.3 : 0.25}" stroke="${bad ? "#d11" : "#2f6fb0"}" stroke-width="1"/>` +
        `<line x1="${X((ob.b.x0 + ob.b.x1) / 2)}" y1="${Z((ob.b.z0 + ob.b.z1) / 2)}" x2="${X((ob.b.x0 + ob.b.x1) / 2 + ob.f[0] * 12)}" y2="${Z((ob.b.z0 + ob.b.z1) / 2 + ob.f[1] * 12)}" stroke="#a0361b" stroke-width="2"/>`;
    svg += `<text x="${(+X(b.x0) + 2).toFixed(1)}" y="${(+Z(b.z0) + 11).toFixed(1)}" font-size="10" fill="${bad ? "#d11" : "#222"}">${esc(e.it.id)}${e.objets.length ? "" : " (manquant)"}</text>`;
  }
  for (const ob of res.meubles.extra.filter((o) => o.b))
    svg += `<rect x="${X(ob.b.x0)}" y="${Z(ob.b.z0)}" width="${((ob.b.x1 - ob.b.x0) * S).toFixed(1)}" height="${((ob.b.z1 - ob.b.z0) * S).toFixed(1)}" fill="#d11" fill-opacity=".35" stroke="#d11" stroke-width="2"/><text x="${X(ob.b.x0)}" y="${(+Z(ob.b.z1) + 11).toFixed(1)}" font-size="10" fill="#d11">en trop ${ob.itemNo}</text>`;
  svg += `<text x="6" y="${(Hh + 18).toFixed(0)}" font-size="12">${esc(titre)} — ${res.ok ? "CONFORME" : res.ecarts.length + " écart(s)"}</text>`;
  svg += `<text x="6" y="${(Hh + 36).toFixed(0)}" font-size="11">Pointillés : maquette attendue. Plein : design IKEA (bleu sol, vert posé sur un meuble, orange mural). Rouge : écart. Trait brun : façade.</text>`;
  svg += `<text x="6" y="${(Hh + 52).toFixed(0)}" font-size="11">Pièce IKEA ${fit.ident ? "dans le repère maquette" : "recalée (" + esc(fit.D.nom) + ")"} ; ouvertures maquette : marron porte, bleu vitrée.</text></svg>`;
  return svg;
}

// ---------------------------------------------------------------- API
async function verifierDesign({ maquette, version, cible, sortie, options = {} }) {
  const t0 = Date.now(),
    o = { ...DEF, ...options };
  const M = typeof maquette === "string" ? lireMaquette(maquette) : maquette;
  const pieceSeule = !version || version === "-"; // '-' : pièce seule (aucun meuble attendu ni contrôlé)
  if (!pieceSeule && !M.ITEMS.some((it) => it[version]))
    throw new Error(`version ${version} absente de la maquette`);
  const { json, marche, uuid } = await chargerDesign(cible);
  const tLu = Date.now();
  const D = lireDesign(json, lireModeles(o.modeles));
  const checks = [],
    avert = [];
  for (const ob of D.objets)
    if (ob.corrige)
      avert.push(`${ob.itemNo} ${ob.nom} : rendu prévu avec la correction apprise (${ob.corrige})`);
  const pc = controlesPiece(M, D, o, checks);
  const nPiece = checks.length;
  const fit = { ...pc.fit, cyc: pc.cyc, ident: pc.ident };
  if (!pc.ident)
    avert.push(
      `meubles comparés dans le repère de la pièce IKEA recalée (${pc.fit.D.nom}, translation ${pc.fit.t.map(r1).join(", ")} cm)`,
    );
  const meubles = pieceSeule
    ? { entrees: [], extra: [] }
    : await controlesMeubles(
        M,
        version,
        D,
        pc.ident ? { app: (p) => p } : pc.fit,
        marche,
        o,
        checks,
        avert,
      );
  if (pieceSeule && D.objets.length)
    avert.push(`pièce seule : ${D.objets.length} meuble(s) présents dans le design, non contrôlés`);
  const ecarts = checks.filter((c) => !c.ok);
  const res = {
    ok: !ecarts.length,
    version,
    cible,
    compositionUuid: uuid || (json.composition || {}).uuid,
    nom: (json.composition || {}).name,
    shareUrl: (json.composition || {}).shareUrl,
    apercu: (json.composition || {}).baseImageUrl,
    piece: {
      ok: !checks.slice(0, nPiece).some((c) => !c.ok),
      sens: pc.sens,
      repere: pc.ident ? "identité" : pc.fit.D.nom,
    },
    checks,
    ecarts,
    avertissements: avert,
    durees: { lectureDesignS: (tLu - t0) / 1000, totalS: (Date.now() - t0) / 1000 },
    meubles,
  };
  const out = { ...res };
  delete out.meubles;
  out.objets = D.objets.map((ob) => ({
    uid: ob.uid,
    itemNo: ob.itemNo,
    nom: ob.nom,
    design: ob.design,
    pose: ob.pose,
    boite: ob.b && Object.fromEntries(Object.entries(ob.b).map(([k, v]) => [k, r1(v)])),
    facade: ob.f && nomDir(ob.f),
    entree: (meubles.entrees.find((e) => e.objets.includes(ob)) || {}).it?.id || null,
  }));
  if (sortie) {
    fs.mkdirSync(sortie, { recursive: true });
    const titre = `Version ${version} — ${res.nom || ""} ${res.compositionUuid || ""}`;
    fs.writeFileSync(path.join(sortie, "verif.json"), JSON.stringify(out, null, 1));
    fs.writeFileSync(path.join(sortie, "verif.txt"), texte(out));
    fs.writeFileSync(path.join(sortie, "plan-verif.svg"), planSvg(M, version, D, fit, res, titre));
    out.fichiers = ["verif.json", "verif.txt", "plan-verif.svg"].map((f) => path.join(sortie, f));
  }
  out.durees.totalS = (Date.now() - t0) / 1000;
  return out;
}
function texte(r) {
  const L = [
    `Vérification ${r.ok ? "CONFORME" : "ÉCARTS (" + r.ecarts.length + ")"} — version ${r.version} — ${r.nom || ""}`,
    `Design : ${r.shareUrl || r.cible}`,
    `Pièce : sens ${r.piece.sens}, repère ${r.piece.repere}`,
    "",
  ];
  for (const c of r.checks)
    L.push(
      `${c.ok ? (c.avert ? "OK*" : "OK ") : "KO "} ${c.nom}\n      attendu ${typeof c.attendu === "object" ? JSON.stringify(c.attendu) : c.attendu} | obtenu ${typeof c.obtenu === "object" ? JSON.stringify(c.obtenu) : c.obtenu}${c.ecart != null ? " | écart " + (typeof c.ecart === "object" ? JSON.stringify(c.ecart) : c.ecart) : ""}${c.connu ? " | connu : " + c.connu : ""}${c.classe ? " | " + c.classe : ""}${c.detail && typeof c.detail === "string" ? " | " + c.detail : ""}`,
    );
  if (r.avertissements.length) {
    L.push("", "Avertissements (non bloquants) :");
    r.avertissements.forEach((a) => L.push("  - " + a));
  }
  if (r.ecarts.length) {
    L.push("", "ÉCARTS :");
    r.ecarts.forEach((c) =>
      L.push(
        `  - ${c.nom} : obtenu ${typeof c.obtenu === "object" ? JSON.stringify(c.obtenu) : c.obtenu}${c.ecart != null ? " (écart " + (typeof c.ecart === "object" ? JSON.stringify(c.ecart) : c.ecart) + ")" : ""}${c.classe ? " — " + c.classe : ""}`,
      ),
    );
  }
  L.push(
    "",
    `Durée : ${r.durees.totalS.toFixed(2)} s (lecture du design ${r.durees.lectureDesignS.toFixed(2)} s)`,
  );
  return L.join("\n") + "\n";
}
module.exports = { verifierDesign, lireMaquette, chargerDesign, lireDesign, texte, DEF };
