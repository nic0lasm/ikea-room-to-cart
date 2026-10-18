#!/usr/bin/env node
// maquette-vers-ikea.js <maquette.html> <version> [dossier_sortie] [--port 9240] [--scene <uuid>] [--rebuild] [--no-panier]
//
// Pour une version (A, B, …) d'une maquette 3D, produit :
//   1. un design IKEA (planificateur home-design, invité, sans compte) partagé : la pièce exacte + les meubles posés au bon endroit,
//      vérifié automatiquement (boîtes englobantes réellement rendues par l'éditeur IKEA comparées à la maquette, tolérance 2 cm) ;
//   2. le lien qui remplit le panier ikea.fr (liste-achat.js, copie locale).
// Piloté uniquement par ITEMS (positions par version, emprise w×d×h, face, refs:[{itemNo,q}], st:'own').
//
// Pièce : construite une fois par build-room.js (room-builder IKEA, ~60 s) puis mémorisée dans pieces.json ; chaque design
// part d'une COPIE de cette scène pour un jeton invité neuf (--scene <uuid> force la source, --rebuild reconstruit).
// Navigateur : --port N (défaut 9240) : si un Chrome écoute déjà sur ce port CDP il est utilisé, sinon le script en lance un
//   (profil profiles/N) et l'arrête à la fin. Plusieurs instances en parallèle : un port et un dossier de sortie différents chacune.
//   (CDP=http://hôte:port reste accepté.)
// Sorties dans le dossier : rapport.txt, rapport.json, vue-dessus.png (éditeur IKEA), plan-2d.png (attendu/obtenu), panier.html/json.
"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { spawn, execFileSync } = require("child_process");
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";
const K = require("./lib/kreativ.js"),
  G = require("./lib/geo3.js"),
  C = require("./lib/catalogue.js"),
  PL = require("./lib/plan.js");
const geom = require("./piece/geom.js");

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k),
  opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : null;
  };
const pos = argv.filter(
  (a, i) => !a.startsWith("--") && !["--scene", "--port"].includes(argv[i - 1]),
);
if (opt("--port")) {
  process.env.PORT = opt("--port");
  delete process.env.CDP;
}
const [MAQ0, V, OUT0] = pos;
if (!MAQ0 || !V) {
  console.error(
    "usage: node maquette-vers-ikea.js <maquette.html> <version> [dossier_sortie] [--port 9240] [--scene <uuid>] [--rebuild] [--no-panier]",
  );
  process.exit(1);
}
const MAQ = path.resolve(MAQ0),
  OUT = path.resolve(OUT0 || path.join(__dirname, "out", V));
const PROJET = process.env.PROJET || path.basename(path.dirname(MAQ));
fs.mkdirSync(OUT, { recursive: true });
const TOL = 2,
  WALL_GAP = 4.5,
  PLINTHE = 2.5; // cm ; le planificateur décolle les objets muraux de 4 cm et écarte du mur (plinthe) les meubles au sol de 1 à 2 cm
const T0 = Date.now(),
  lap = (m) => console.log(((Date.now() - T0) / 1000).toFixed(1).padStart(6) + "s  " + m);
const r1 = (v) => Math.round(v * 10) / 10;
const notes = [],
  subs = [];

// ---------------- navigateur ----------------
let chromeProc = null;
async function cdp() {
  if (process.env.CDP) return process.env.CDP;
  const port = +(process.env.PORT || 9240),
    url = `http://127.0.0.1:${port}`;
  const alive = async () => {
    try {
      return (await fetch(url + "/json/version")).ok;
    } catch {
      return false;
    }
  };
  if (!(await alive())) {
    chromeProc = spawn(path.join(__dirname, "start-chrome.sh"), [], {
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: "ignore",
    });
    for (let i = 0; i < 60 && !(await alive()); i++) await new Promise((s) => setTimeout(s, 500));
  }
  return (process.env.CDP = url);
}
function stopChrome() {
  if (chromeProc) {
    try {
      process.kill(-chromeProc.pid);
    } catch (e) {
      try {
        chromeProc.kill();
      } catch (e2) {}
    }
  }
}

// ---------------- pièce ----------------
async function roomScene(m) {
  const sig = crypto
    .createHash("sha1")
    .update(JSON.stringify([m.H, m.P, m.DOOR, m.WIN, m.OPEN]))
    .digest("hex")
    .slice(0, 12);
  const db = path.join(__dirname, "pieces.json");
  let P = {};
  try {
    P = JSON.parse(fs.readFileSync(db, "utf8"));
  } catch (e) {}
  if (opt("--scene")) return { scene: opt("--scene"), built: false, sig };
  if (P[sig] && !flag("--rebuild")) return { ...P[sig], built: false, sig };
  lap("construction de la pièce (room-builder IKEA)…");
  const dir = path.join(OUT, "piece");
  execFileSync(process.execPath, [path.join(__dirname, "piece/build-room.js"), MAQ, dir], {
    env: { ...process.env, CDP: await cdp(), NAME: `${PROJET} - pièce` },
    stdio: "inherit",
  });
  const v = JSON.parse(fs.readFileSync(path.join(dir, "verif.json"), "utf8"));
  P[sig] = { scene: v.sceneUuid, roomShare: v.shareUrl, date: new Date().toISOString() };
  fs.writeFileSync(db, JSON.stringify(P, null, 1));
  return { ...P[sig], built: true, sig };
}

// ---------------- meubles ----------------
const OWN_QUERIES = {
  desk: ["bureau 160x80", "bureau"],
  chair: ["chaise de bureau", "chaise pivotante"],
  printer: ["boîte de rangement", "rangement"],
  lamp: ["lampe de bureau"],
};
const OWN_TYPE = { desk: "bureau", chair: "chaise de bureau", lamp: "lampe de bureau" };

async function planUnits(m, items, token) {
  const sel = items.filter((it) => PL.isOn(it, V));
  // fiches 3D de toutes les refs
  const allNos = [
    ...new Set(
      sel
        .flatMap((it) => (it.refs || []).map((r) => K.no8(r.itemNo)))
        .concat(sel.filter((it) => it.sub3d).map((it) => K.no8(it.sub3d))),
    ),
  ];
  const F = await K.resolve(allNos, token);
  const entries = [];
  for (const it of sel) {
    const others = sel.filter(
      (o) => (o !== it && o.st !== "own") || (o !== it && o.kind === "desk"),
    );
    const box = PL.entryBox(it, V);
    let { f, why } = PL.facade(
      it,
      V,
      m.P,
      sel.filter((o) => o !== it),
    );
    const lateralX = f[1] !== 0; // façade selon z -> largeur selon x
    const span = { lat: lateralX ? it.w : it.d, dep: lateralX ? it.d : it.w };
    const arts = []; // [{fiche, count, refNo, role}]
    if (it.sub3d && F[K.no8(it.sub3d)])
      arts.push({
        fiche: F[K.no8(it.sub3d)],
        count: it.q || 1,
        refNo: K.no8(it.sub3d),
        role: "sub3d (maquette)",
      });
    else if (it.st === "own") {
      const qs = OWN_QUERIES[it.kind] || [it.nm];
      const e = await C.equivalent(
        { dims: { w: span.lat, d: span.dep, h: it.h }, typeExact: OWN_TYPE[it.kind] },
        token,
        qs,
      );
      if (e) {
        arts.push({ fiche: e.f, count: 1, refNo: null, role: "substitut visuel (déjà possédé)" });
        subs.push({
          entree: it.id,
          de: `${it.nm} (déjà possédé, ${r1(span.lat)}×${r1(span.dep)}×${it.h})`,
          vers: `${e.f.localItemNumber} ${e.f.name} ${e.f.typeName} ${e.f.validDesign} ${C.fmtD(K.dims(e.f))}`,
          panier: "non (déjà possédé)",
        });
      } else notes.push(`${it.id} : aucun substitut 3D trouvé pour un objet possédé`);
    } else if (Array.isArray(it.refs) && it.refs.length) {
      const refs = it.refs.map((r) => ({ no: K.no8(r.itemNo), q: r.q || 1 }));
      const present = refs
        .filter((r) => F[r.no] && K.has3d(F[r.no]))
        .map((r) => ({ fiche: F[r.no], count: r.q, refNo: r.no, role: "article" }));
      if (!(F[refs[0].no] && K.has3d(F[refs[0].no]))) {
        // article principal absent du catalogue 3D -> équivalent
        const inf = await C.infoFr(refs[0].no);
        const sz = C.parseSize(inf.size) || {};
        const e = await C.equivalent(
          {
            name: inf.name,
            type: inf.type,
            design: inf.design,
            dims: { w: sz.w, d: sz.d, h: sz.h },
          },
          token,
          [
            `${inf.name} ${inf.type} ${inf.design}`,
            `${inf.name} ${inf.type} ${sz.w && sz.d ? sz.w + "x" + sz.d : ""}`,
            `${inf.name} ${inf.type}`,
            inf.name,
          ],
        );
        if (e) {
          present.unshift({
            fiche: e.f,
            count: refs[0].q,
            refNo: refs[0].no,
            role: "équivalent 3D",
          });
          subs.push({
            entree: it.id,
            de: `${refs[0].no} ${inf.name} ${inf.type} ${inf.design} ${inf.size}`,
            vers: `${e.f.localItemNumber} ${e.f.name} ${e.f.typeName} ${e.f.validDesign} ${C.fmtD(K.dims(e.f))}`,
            panier: "référence d’origine conservée",
            autres: e.candidates,
          });
        } else
          notes.push(`${it.id} : ${refs[0].no} absent du catalogue 3D et aucun équivalent trouvé`);
      }
      // seuls les articles « structure » sont posés : on écarte façades, pieds, rails… (volume < 20 % du plus gros)
      const vol = (a) => {
        const d = K.dims(a.fiche);
        return d.w * d.d * d.h;
      };
      const vmax = Math.max(0, ...present.map(vol));
      for (const a of present) if (vol(a) >= 0.2 * vmax) arts.push(a);
    } else notes.push(`${it.id} (${it.nm}) : pas de refs ni d’objet possédé, non posé en 3D`);
    if (!arts.length) continue;
    // une seule pièce dont l'emprise colle mieux tournée de 90° (tapis…) : on tourne
    if (arts.length === 1 && arts[0].count === 1) {
      const d = K.dims(arts[0].fiche);
      const err = (a, b) => Math.abs(d.w - a) + Math.abs(d.d - b);
      if (err(span.dep, span.lat) + 20 < err(span.lat, span.dep)) {
        f = [f[1], -f[0]];
        why += " ; tourné de 90° (emprise du catalogue)";
      }
    }
    entries.push({ it, box, f, why, arts });
  }
  // ---- disposition dans l'emprise ----
  const units = [];
  for (const E of entries) {
    const { it, box, f } = E;
    const lateralX = f[1] !== 0;
    const lat0 = lateralX ? box.x0 : box.z0,
      latS = lateralX ? it.w : it.d;
    // dos : côté opposé à la façade
    const back = f[0] > 0 ? box.x0 : f[0] < 0 ? box.x1 : f[1] > 0 ? box.z0 : box.z1;
    const list = E.arts.flatMap((a) => Array.from({ length: a.count }, () => a));
    const layers = [];
    let cur = [],
      w = 0;
    for (const a of list) {
      const aw = K.dims(a.fiche).w;
      if (cur.length && w + aw > latS + 2) {
        layers.push(cur);
        cur = [];
        w = 0;
      }
      cur.push(a);
      w += aw;
    }
    if (cur.length) layers.push(cur);
    let yAcc = box.y0;
    let below = [];
    layers.forEach((L, li) => {
      const rowW = L.reduce((s, a) => s + K.dims(a.fiche).w, 0);
      let c = lat0 + Math.max(0, (latS - rowW) / 2);
      const row = [];
      L.forEach((a, k) => {
        const d = K.dims(a.fiche);
        const latC = c + d.w / 2;
        c += d.w;
        const depC = back + ((f[0] + f[1]) * d.d) / 2; // f = ±1 sur un seul axe
        const cx = lateralX ? latC : depC,
          cz = lateralX ? depC : latC;
        const ex = lateralX ? d.w : d.d,
          ez = lateralX ? d.d : d.w;
        const u = {
          id: `${it.id}#${units.filter((x) => x.it === it).length + 1}`,
          it,
          E,
          a,
          d,
          f,
          yaw: PL.yawOf(f),
          layer: li,
          slot: k,
          c: [cx, cz],
          y: yAcc,
          exp: {
            x0: cx - ex / 2,
            x1: cx + ex / 2,
            z0: cz - ez / 2,
            z1: cz + ez / 2,
            y0: yAcc,
            y1: yAcc + d.h,
          },
        };
        if (li > 0) u.parent = below[Math.min(k, below.length - 1)];
        row.push(u);
        units.push(u);
      });
      yAcc += Math.max(...L.map((a) => K.dims(a.fiche).h));
      below = row;
    });
  }
  // ---- mode de pose ----
  const placed = [];
  const byY = [...units].sort((a, b) => a.y - b.y || a.layer - b.layer);
  for (const u of byY) {
    const it = u.it;
    if (u.parent) {
      u.mode = "pile";
      u.y = u.parent.exp.y1;
    } else if (u.y <= 0.5) {
      u.mode = "sol";
      if (it.legs) u.note = `pieds ${it.legs} cm non modélisés : posé au sol`;
    } else {
      const top = u.y + u.d.h,
        want = u.E.box.y1;
      const sup = placed
        .filter(
          (s) =>
            s.mode !== "mur" &&
            Math.abs(s.exp.y1 - u.y) <= 10 &&
            u.c[0] > s.exp.x0 &&
            u.c[0] < s.exp.x1 &&
            u.c[1] > s.exp.z0 &&
            u.c[1] < s.exp.z1,
        )
        .sort((a, b) => Math.abs(a.exp.y1 - u.y) - Math.abs(b.exp.y1 - u.y))[0];
      if (u.d.h > it.h + 20 && want - u.d.h < 10) {
        u.mode = "sol";
        u.note = `substitut de ${r1(u.d.h)} cm de haut (au lieu de ${it.h}) : posé au sol, dessus à ${r1(u.d.h)} cm au lieu de ${r1(want)}`;
      } else if (sup) {
        u.mode = "pile";
        u.parent = sup;
        if (Math.abs(sup.exp.y1 - u.y) > 0.5)
          u.note = `posé sur ${sup.id} à ${r1(sup.exp.y1)} cm (maquette ${r1(u.y)})`;
        u.y = sup.exp.y1;
      } else {
        const sd = PL.sideDists(m.P, u.exp),
          bk = PL.dirName([-u.f[0], -u.f[1]]);
        if (sd[bk] <= 10) u.mode = "mur";
        else {
          u.mode = "sol";
          u.note = `en hauteur sans support ni mur derrière : posé au sol`;
        }
      }
    }
    if (u.mode === "sol") u.y = 0;
    u.exp.y0 = u.y;
    u.exp.y1 = u.y + u.d.h;
    placed.push(u);
  }
  return { units, entries };
}

function toPlaced(units, surfaces) {
  const floor = surfaces.find((s) => s.cls === "floor");
  const walls = surfaces.filter((s) => s.cls === "wall");
  let uid = 10 ** 12 + Math.floor(Math.random() * 1e9);
  for (const u of units) u.uniqueId = String(uid++);
  return units.map((u) => {
    const fi = u.a.fiche,
      cxm = (fi.minX + fi.maxX) / 2,
      czm = (fi.minZ + fi.maxZ) / 2;
    const s = Math.sin(u.yaw),
      c = Math.cos(u.yaw);
    // origine du modèle en monde glTF (m) : centre voulu − rotation(centre du modèle)
    const O = [u.c[0] / 100 - (cxm * c + czm * s), u.y / 100, u.c[1] / 100 - (-cxm * s + czm * c)];
    const qy = G.qaxis([0, 1, 0], u.yaw);
    if (u.corr) {
      // 2e passe : le planificateur tourne / décale ce modèle (pivot et cap propres au modèle) ; on compense
      const yr = u.yaw - u.corr.dyaw,
        cr = Math.cos(u.yaw),
        sr = Math.sin(u.yaw),
        k = u.corr.k;
      O[0] = u.c[0] / 100 - (k[0] * cr + k[1] * sr);
      O[2] = u.c[1] / 100 - (-k[0] * sr + k[1] * cr);
      const q2 = G.qaxis([0, 1, 0], yr);
      qy.splice(0, 4, ...q2);
      u.yawReq = yr;
    }
    const base = {
      furnitureId: fi.id,
      uniqueId: u.uniqueId,
      gfxAttributes: {
        mirrorOptionEnabled: false,
        anchorCombinationIndex: 0,
        artData: {},
        placingBehavior: "Floor",
        additionalContacts: [],
      },
    };
    if (u.mode === "sol") {
      const q = G.qmul(
        G.qaxis([0, 0, 1], Math.atan2(-u.f[1], u.f[0]) - (u.corr ? u.corr.dyaw : 0)),
        [0.5, 0.5, 0.5, 0.5],
      );
      u.O = O;
      return {
        ...base,
        parentId: "SURFACE",
        parentAttachment: floor.id,
        x: O[0],
        y: -O[2],
        z: 0,
        headingI: q[0],
        headingJ: q[1],
        headingK: q[2],
        heading: q[3],
      };
    }
    u.O = O;
    if (u.mode === "pile")
      return {
        ...base,
        parentId: u.parent.uniqueId,
        parentAttachment: 0,
        x: O[0],
        y: O[1],
        z: O[2],
        headingI: qy[0],
        headingJ: qy[1],
        headingK: qy[2],
        heading: qy[3],
      };
    // mur : surface dont la normale = façade, la plus proche du dos
    const backPt = [
      (u.c[0] - (u.f[0] * u.d.d) / 2) / 100,
      (u.y + u.d.h / 2) / 100,
      (u.c[1] - (u.f[1] * u.d.d) / 2) / 100,
    ];
    const w = walls
      .map((w) => {
        const n = G.qrot(w.R, [0, 0, 1]);
        return { w, dot: n[0] * u.f[0] + n[2] * u.f[1], z: Math.abs(G.toLocal(w, backPt)[2]) };
      })
      .filter((x) => x.dot > 0.95)
      .sort((a, b) => a.z - b.z)[0];
    if (!w) {
      u.mode = "sol";
      u.note = "aucun mur trouvé derrière : posé au sol";
      return toPlaced([u], surfaces)[0];
    }
    u.wall = w.w.id;
    const L = G.toLocal(w.w, O);
    return {
      ...base,
      parentId: "SURFACE",
      parentAttachment: w.w.id,
      x: L[0],
      y: L[1],
      z: L[2],
      headingI: 0,
      headingJ: 0,
      headingK: 0,
      heading: 1,
      gfxAttributes: { ...base.gfxAttributes, placingBehavior: "WallPlaceable" },
    };
  });
}

// ---------------- éditeur IKEA : mesure + vue de dessus ----------------
async function inspect(editorUrl, n) {
  const { chromium } = require("./playwright.js");
  const b = await chromium.connectOverCDP(await cdp());
  const ctx = b.contexts()[0] || (await b.newContext());
  await ctx.addInitScript({ path: path.join(__dirname, "lib/gpu-spoof.js") });
  await ctx.addInitScript({ path: path.join(__dirname, "lib/hooks.js") });
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1600, height: 1000 });
  try {
    await p.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p
      .getByText("Continuer sans accepter")
      .click({ timeout: 20000 })
      .catch(() => {});
    await p.getByText("Vue de dessus").first().waitFor({ timeout: 120000 });
    await p
      .waitForFunction(
        (n) => {
          const v = window.__kViewer;
          if (!v || !v.scene) return false;
          const g = v.scene.threeScene.children.filter((g) => /^renderObject-/.test(g.name));
          return g.length >= n && g.every((g) => !g.userData.isPlaceholder);
        },
        n,
        { timeout: 120000 },
      )
      .catch(() => notes.push("éditeur : tous les meubles ne sont pas chargés au bout de 2 min"));
    await p.waitForTimeout(2000);
    const boxes = await p.evaluate(require("./lib/bbox-page.js"));
    await p
      .evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((b) =>
          /Vue de dessus/.test(b.textContent),
        );
        if (!b) throw new Error("bouton absent");
        b.click();
      })
      .catch((e) => notes.push("vue de dessus : " + e.message.split("\n")[0]));
    await p.mouse.move(1590, 990);
    await p.waitForTimeout(6000);
    const png = path.join(OUT, "vue-dessus.png");
    const cv = await p
      .evaluate(() => {
        const c = window.__kViewer.canvas.getBoundingClientRect();
        return { x: c.x, y: c.y, width: c.width, height: c.height };
      })
      .catch(() => null);
    await p.screenshot({ path: png, clip: cv && cv.width > 100 ? cv : undefined });
    return { boxes, png };
  } finally {
    await p.close().catch(() => {});
    await b.close().catch(() => {});
  }
}

// plan 2D attendu (pointillés) / obtenu (plein), rendu en PNG par Chrome
async function plan2d(m, units, got) {
  const S = 2,
    pad = 20,
    W = 400 * S + 2 * pad,
    Hh = 350 * S + 2 * pad,
    X = (x) => pad + x * S,
    Z = (z) => pad + z * S;
  const col = { sol: "#2f6fb0", pile: "#3a9b5a", mur: "#d9822b" };
  const poly = m.P.map((p) => `${X(p[0])},${Z(p[1])}`).join(" ");
  const rects = units
    .map((u) => {
      const e = u.exp,
        g = got[u.uniqueId];
      return (
        `<rect x="${X(e.x0)}" y="${Z(e.z0)}" width="${(e.x1 - e.x0) * S}" height="${(e.z1 - e.z0) * S}" fill="none" stroke="#000" stroke-dasharray="4 3"/>` +
        (g
          ? `<rect x="${X(g.x0)}" y="${Z(g.z0)}" width="${(g.x1 - g.x0) * S}" height="${(g.z1 - g.z0) * S}" fill="${col[u.mode]}" fill-opacity=".35" stroke="${col[u.mode]}"/>`
          : "") +
        `<line x1="${X(u.c[0])}" y1="${Z(u.c[1])}" x2="${X(u.c[0] + u.f[0] * 12)}" y2="${Z(u.c[1] + u.f[1] * 12)}" stroke="#a0361b" stroke-width="2"/>` +
        `<text x="${X(e.x0) + 2}" y="${Z(e.z0) + 11}" font-size="10" font-family="sans-serif">${u.id}</text>`
      );
    })
    .join("");
  const op = Object.entries(m.OPEN)
    .flatMap(([k, os]) =>
      os.map((o) => {
        const a = m.P[k],
          b = m.P[(+k + 1) % m.P.length];
        const L = Math.abs(b[0] - a[0]);
        const t0 = o.a / L,
          t1 = o.b / L;
        return `<line x1="${X(a[0] + (b[0] - a[0]) * t0)}" y1="${Z(a[1] + (b[1] - a[1]) * t0)}" x2="${X(a[0] + (b[0] - a[0]) * t1)}" y2="${Z(a[1] + (b[1] - a[1]) * t1)}" stroke="${o.glass ? "#4f9be6" : "#c08a4a"}" stroke-width="6"/>`;
      }),
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh + 40}"><rect width="100%" height="100%" fill="#fff"/><polygon points="${poly}" fill="#f4efe6" stroke="#333" stroke-width="3"/>${op}${rects}
<text x="${pad}" y="${Hh + 18}" font-size="12" font-family="sans-serif">Version ${V} — pointillés : attendu (maquette) ; plein : rendu de l'éditeur IKEA (bleu sol, vert posé sur un meuble, orange mural).</text><text x="${pad}" y="${Hh + 34}" font-size="12" font-family="sans-serif">Trait rouge : façade. Porte (marron) en haut (z=0), porte-fenêtre (bleu) en bas, x vers la droite.</text></svg>`;
  const f = path.join(OUT, "plan-2d.svg");
  fs.writeFileSync(f, svg);
  const { chromium } = require("./playwright.js");
  const b = await chromium.connectOverCDP(await cdp());
  const ctx = b.contexts()[0];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: W, height: Hh + 40 });
  await p.goto("file://" + f);
  await p.screenshot({ path: path.join(OUT, "plan-2d.png") });
  await p.close();
  await b.close();
}

// ---------------- principal ----------------
(async () => {
  const m = geom.readMaquette(MAQ);
  const items = PL.loadItems(MAQ);
  if (!items.some((it) => it[V])) throw new Error("version " + V + " absente de la maquette");
  const room = await roomScene(m);
  lap(`pièce : scène source ${room.scene}${room.built ? " (construite)" : " (réutilisée)"}`);
  const token = await K.guestToken();
  const scene = await K.copyScene(room.scene, token, `${PROJET} - version ${V}`);
  const sc = await K.getScene(scene, token);
  const surfaces = G.surfaces(sc.gltfManifest);
  lap(`scène copiée pour un invité neuf : ${scene} (${surfaces.length} surfaces)`);

  const { units } = await planUnits(m, items, token);
  const placedFurniture = toPlaced(units, surfaces);
  lap(`${units.length} meubles 3D à poser`);
  const comp1 = await K.createComposition(
    token,
    scene,
    placedFurniture,
    `${PROJET} - version ${V}`,
  );
  lap("design partagé : " + comp1.shareUrl);

  // panier en parallèle de la vérification
  const panier = flag("--no-panier")
    ? Promise.resolve(null)
    : new Promise((res) => {
        const pj = path.join(OUT, "panier.json");
        const c = spawn(
          process.execPath,
          [
            path.join(__dirname, "liste-achat.js"),
            MAQ,
            V,
            "--json",
            pj,
            "--html",
            path.join(OUT, "panier.html"),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let o = "";
        c.stdout.on("data", (d) => (o += d));
        c.stderr.on("data", (d) => (o += d));
        c.on("close", () => {
          fs.writeFileSync(path.join(OUT, "panier.txt"), o);
          try {
            res(JSON.parse(fs.readFileSync(pj, "utf8")));
          } catch (e) {
            res({ erreur: o.slice(-500) });
          }
        });
      });

  const verify = async (comp) => {
    const pub = await K.compiled(comp.compositionUuid);
    const stored = Object.fromEntries(
      pub.composition.placedfurnitureSet.map((p) => [p.uniqueId, p]),
    );
    let insp;
    try {
      insp = await inspect(comp.editorUrl, units.length);
    } catch (e) {
      notes.push("éditeur : 1er essai échoué (" + e.message.split("\n")[0] + "), nouvel essai");
      insp = await inspect(comp.editorUrl, units.length);
    }
    const { boxes, png } = insp;
    lap("éditeur IKEA relu (" + Object.keys(boxes || {}).length + " meubles rendus)");
    const got = {},
      rows = [],
      fails = [];
    for (const u of units) {
      const b = boxes && boxes[u.uniqueId];
      const e = u.exp;
      const r = {
        id: u.id,
        nom: `${u.a.fiche.name} ${u.a.fiche.typeName} ${u.a.fiche.localItemNumber}`,
        role: u.a.role,
        pose: u.mode + (u.wall != null ? " (mur " + u.wall + ")" : ""),
        enregistre: !!stored[u.uniqueId],
        attendu: {
          x: [r1(e.x0), r1(e.x1)],
          z: [r1(e.z0), r1(e.z1)],
          y: [r1(e.y0), r1(e.y1)],
          facade: PL.dirName(u.f),
        },
        note: u.note || "",
      };
      if (!b || !b.box) {
        r.ok = false;
        r.obtenu = null;
        fails.push(u.id + " non rendu");
        rows.push(r);
        continue;
      }
      const g = {
        x0: b.box[0] * 100,
        x1: b.box[3] * 100,
        y0: b.box[1] * 100,
        y1: b.box[4] * 100,
        z0: b.box[2] * 100,
        z1: b.box[5] * 100,
      };
      got[u.uniqueId] = g;
      const yawGot = 2 * Math.atan2(b.q[1], b.q[3]);
      let dyaw = Math.abs(((((yawGot - u.yaw) * 180) / Math.PI + 540) % 360) - 180);
      const sym = /tapis|rug/i.test(u.a.fiche.typeName + " " + u.it.kind);
      if (sym) dyaw = Math.min(dyaw, Math.abs(180 - dyaw));
      const dc = {
        x: (g.x0 + g.x1 - e.x0 - e.x1) / 2,
        z: (g.z0 + g.z1 - e.z0 - e.z1) / 2,
        y: g.y0 - e.y0,
      };
      const ds = {
        x: g.x1 - g.x0 - (e.x1 - e.x0),
        z: g.z1 - g.z0 - (e.z1 - e.z0),
        y: g.y1 - g.y0 - (e.y1 - e.y0),
      };
      // côté mur : le planificateur décolle les objets muraux de 4 cm
      const nAx = u.f[0] !== 0 ? "x" : "z";
      const backWall =
        u.mode === "sol" && PL.sideDists(m.P, u.exp)[PL.dirName([-u.f[0], -u.f[1]])] < 1;
      const lim = (k) =>
        u.mode === "mur" && k === nAx ? WALL_GAP : backWall && k === nAx ? PLINTHE : TOL;
      const corners = [
        [g.x0, g.z0],
        [g.x1, g.z0],
        [g.x0, g.z1],
        [g.x1, g.z1],
      ].map((p) => PL.signedDist(m.P, p));
      const inside = Math.min(...corners) >= -1;
      r.obtenu = {
        x: [r1(g.x0), r1(g.x1)],
        z: [r1(g.z0), r1(g.z1)],
        y: [r1(g.y0), r1(g.y1)],
        facade:
          PL.dirName([Math.round(Math.sin(yawGot)), Math.round(Math.cos(yawGot))]) ||
          ((yawGot * 180) / Math.PI).toFixed(0) + "°",
      };
      r.ecart = {
        centre: { x: r1(dc.x), z: r1(dc.z), y: r1(dc.y) },
        taille: { x: r1(ds.x), z: r1(ds.z), y: r1(ds.y) },
        rotation: r1(dyaw),
        dansLaPiece: inside,
        depassementMur: r1(Math.max(0, -Math.min(...corners))),
      };
      const bad = [];
      for (const k of ["x", "z", "y"]) {
        if (Math.abs(dc[k]) > lim(k)) bad.push(`centre ${k} ${r1(dc[k])}`);
        if (Math.abs(ds[k]) > TOL) bad.push(`taille ${k} ${r1(ds[k])}`);
      }
      if (dyaw > 2) bad.push(`rotation ${r1(dyaw)}°`);
      if (!inside) bad.push("dépasse dans le mur");
      r.ok = bad.length === 0;
      r.ecartMural = Math.abs(dc[nAx]) > TOL && !bad.length;
      u.got = { yaw: yawGot, c: [(g.x0 + g.x1) / 200, (g.z0 + g.z1) / 200], bad };
      if (bad.length) fails.push(`${u.id} : ${bad.join(", ")}`);
      rows.push(r);
    }
    return { rows, fails, got, png };
  };
  let comp = comp1,
    V1 = await verify(comp1),
    passes = 1;
  // 2e passe si l'éditeur a tourné / décalé certains modèles (pivot ou cap propres au modèle, ex. lampe FORSÅ)
  const fix = units.filter((u) => u.got && u.got.bad.length && u.mode !== "mur" && u.O);
  if (fix.length) {
    for (const u of fix) {
      const dyaw = Math.atan2(Math.sin(u.got.yaw - u.yaw), Math.cos(u.got.yaw - u.yaw)),
        yr = u.got.yaw;
      const vx = u.got.c[0] - u.O[0],
        vz = u.got.c[1] - u.O[2]; // centre rendu − origine demandée, ramené dans le repère du modèle
      u.corr = {
        dyaw,
        k: [vx * Math.cos(yr) - vz * Math.sin(yr), vx * Math.sin(yr) + vz * Math.cos(yr)],
      };
    }
    notes.push(
      `2e passe : correction du pivot/cap rendu par le planificateur pour ${fix.map((u) => u.id).join(", ")} (1er design ${comp1.shareUrl})`,
    );
    lap("2e passe pour " + fix.map((u) => u.id).join(", "));
    comp = await K.createComposition(
      token,
      scene,
      toPlaced(units, surfaces),
      `${PROJET} - version ${V}`,
    );
    lap("design partagé (2e passe) : " + comp.shareUrl);
    V1 = await verify(comp);
    passes = 2;
  }
  const { rows, fails, got, png } = V1;
  await plan2d(m, units, got).catch((e) => notes.push("plan 2D : " + e.message));
  const cart = await panier;
  stopChrome();

  // ---- rapport ----
  const dur = (Date.now() - T0) / 1000;
  const fmtR = (a) => `${a.x[0]}–${a.x[1]} / ${a.z[0]}–${a.z[1]} / ${a.y[0]}–${a.y[1]} ${a.facade}`;
  const lines = [
    `Version ${V} — ${path.basename(MAQ)} — ${new Date().toISOString()}`,
    `Design partagé : ${comp.shareUrl}`,
    `Éditeur : ${comp.editorUrl}`,
    `Panier ikea.fr : ${cart && cart.lien ? cart.lien : "(non calculé)"}${cart && cart.total ? "  (total " + cart.total + " €)" : ""}`,
    "",
    "Vérification (cm, x / z / y, façade) — attendu = maquette avec les dimensions catalogue, obtenu = boîte rendue par l’éditeur IKEA :",
  ];
  for (const r of rows)
    lines.push(
      `${r.ok ? (r.ecartMural ? "OK*" : "OK ") : "KO "} ${r.id.padEnd(11)} ${r.nom.slice(0, 44).padEnd(44)} ${r.pose.padEnd(10)} att ${fmtR(r.attendu)}  obt ${r.obtenu ? fmtR(r.obtenu) : "—"}${r.ecart ? "  Δc " + [r.ecart.centre.x, r.ecart.centre.z, r.ecart.centre.y].join("/") + " rot " + r.ecart.rotation + "°" : ""}${r.note ? "  [" + r.note + "]" : ""}`,
    );
  lines.push(
    fails.length
      ? "ÉCARTS : " + fails.join(" ; ")
      : `TOUT CONFORME (tolérance ${TOL} cm ; OK* = écart perpendiculaire au mur imposé par le planificateur : objet mural décollé de 4 cm, meuble au sol écarté de la plinthe ≤ ${PLINTHE} cm)`,
  );
  if (subs.length) {
    lines.push("", "Substitutions 3D :");
    subs.forEach((s) => lines.push(`  ${s.entree} : ${s.de} → ${s.vers} (panier : ${s.panier})`));
  }
  if (notes.length) {
    lines.push("", "Notes :");
    notes.forEach((n) => lines.push("  - " + n));
  }
  if (cart && cart.alertes && cart.alertes.length) {
    lines.push("", "Panier, à vérifier :");
    cart.alertes.forEach((a) => lines.push("  - " + a));
  }
  lines.push(
    "",
    `Capture vue de dessus : ${png}`,
    `Plan 2D attendu/obtenu : ${path.join(OUT, "plan-2d.png")}`,
    `Durée : ${dur.toFixed(0)} s`,
  );
  fs.writeFileSync(path.join(OUT, "rapport.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(
    path.join(OUT, "rapport.json"),
    JSON.stringify(
      {
        version: V,
        maquette: MAQ,
        ok: !fails.length,
        fails,
        shareUrl: comp.shareUrl,
        editorUrl: comp.editorUrl,
        compositionUuid: comp.compositionUuid,
        scene,
        sceneSource: room.scene,
        panier: cart && cart.lien,
        panierTotal: cart && cart.total,
        rows,
        substitutions: subs,
        notes,
        placedFurniture,
        durationS: dur,
        captures: [png, path.join(OUT, "plan-2d.png")],
      },
      null,
      1,
    ),
  );
  console.log("\n" + lines.join("\n"));
  process.exit(fails.length ? 2 : 0);
})().catch((e) => {
  console.error("ERREUR", e.stack || e.message);
  stopChrome();
  process.exit(1);
});
