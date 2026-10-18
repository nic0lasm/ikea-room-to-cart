#!/usr/bin/env node
// Construit la pièce de la maquette dans le planificateur IKEA (design NEUF, invité, sans compte), la vérifie et la partage.
// Usage : node build-room.js [maquette.html] [dossier_sortie]
//   CDP=http://127.0.0.1:9230 node build-room.js ...   -> utilise un Chrome déjà lancé (start-chrome.sh) au lieu d'en lancer un
// Sorties : <out>/plan-dessus.png (vue de dessus du room-builder), <out>/verif.json, <out>/verif.txt ; lien de partage sur stdout.
// Chaîne : maquette (P, H, OPEN) -> room-builder (API interne plannerApi : sommets, plafond, ouvertures) -> « Aménager » (scène)
//          -> composition + partage par l'API sugarcube (jeton invité = cookie 'guest') -> relecture publique de roomDefinition -> comparaison.
const path = require("path"),
  fs = require("fs");
const { chromium } = require("../playwright.js");
const geom = require("./geom.js");
const { findPl } = require("./pl.js");
const { buildWalls } = require("./walls-api.js");
const { placeEl } = require("./open-api.js");
const { shareScene, readRoom } = require("./share-api.js");

const MAQ = path.resolve(
  process.argv[2] || path.join(__dirname, "../../projets/bureau/maquette.html"),
);
const OUT = path.resolve(process.argv[3] || path.join(__dirname, "out"));
const TOL = 1; // cm
const NAME = process.env.NAME || path.basename(path.dirname(MAQ)) + " - pièce";
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const T0 = Date.now(),
    lap = (m) => console.log(((Date.now() - T0) / 1000).toFixed(1) + "s", m);
  const m = geom.readMaquette(MAQ);
  const n = m.P.length;
  // ouvertures attendues : mur (index de segment), début/fin le long du mur depuis P[i] (cm), h, vitrée
  const seg = (i) => {
    const a = m.P[i],
      b = m.P[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { a, b, len, ux: (b[0] - a[0]) / len, uz: (b[1] - a[1]) / len };
  };
  const openings = [];
  for (const k of Object.keys(m.OPEN))
    for (const o of m.OPEN[k]) {
      const s = seg(+k),
        f = s.len / (Math.abs(s.b[0] - s.a[0]) || s.len); // a,b sont mesurés en x sur ces murs : correction de l'inclinaison
      openings.push({
        seg: +k,
        glass: !!o.glass,
        center: ((o.a + o.b) / 2) * f,
        w: o.b - o.a,
        h: o.h,
      });
    }

  // ---------- navigateur ----------
  let browser, ctx;
  if (process.env.CDP) {
    browser = await chromium.connectOverCDP(process.env.CDP);
    ctx = browser.contexts()[0];
  } else {
    browser = await chromium.launch({
      headless: true,
      executablePath: require("../playwright.js").chromePath(),
      proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
      args: [
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--lang=fr-FR",
      ],
    });
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR" });
  }
  await ctx.addInitScript({ path: path.join(__dirname, "../lib/gpu-spoof.js") }); // sinon « appareil non supporté »
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  p.on("dialog", (d) => d.accept().catch(() => {}));
  const noCookies = async () => {
    await p
      .locator("#onetrust-reject-all-handler")
      .click({ timeout: 2000 })
      .catch(() => {});
    await p.evaluate(() => {
      const e = document.getElementById("onetrust-consent-sdk");
      if (e) e.remove();
    });
  };

  // room-builder vierge : on purge l'état mémorisé (sinon il peut rouvrir la pièce d'un autre design)
  await p.goto("https://www.ikea.com/fr/fr/home-design/", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await p.evaluate(() => {
    try {
      const o = JSON.parse(localStorage.getItem("GeoUI") || "{}");
      delete o.roomBuilderEditor;
      localStorage.setItem("GeoUI", JSON.stringify(o));
    } catch (e) {}
  });
  await p.goto("https://www.ikea.com/fr/fr/home-design/room-builder", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await p.getByTestId("template-button").first().waitFor({ timeout: 90000 });
  await noCookies();
  await p.getByTestId("template-button").filter({ hasText: "Rectangulaire" }).click();
  await p.getByTestId("primary-cta-button").click();
  await p.getByTestId("wall-line").first().waitFor({ timeout: 60000 });
  await p.waitForFunction(findPl, null, { timeout: 60000 });

  // ---------- 1. murs + plafond ----------
  const W = await p.evaluate(buildWalls, [m.P.map(([x, z]) => [x / 100, z / 100]), m.H / 100]);
  lap("murs : " + W.log.filter((l) => /pass|split/.test(l)).slice(-1)[0]);
  // id du mur de chaque segment de la maquette
  const segWall = await p.evaluate(
    (L) =>
      L.map((a, i) => {
        const b = L[(i + 1) % L.length];
        return window.__pl.getAllWallsInfo().find((w) => w.vertex1Id === a && w.vertex2Id === b).id;
      }),
    W.loop,
  );

  // ---------- 2. ouvertures ----------
  await noCookies();
  await p.getByTestId("primary-cta-button").click();
  await p.getByTestId("asset-card").first().waitFor({ timeout: 60000 });
  await p.waitForFunction(() => (window.__pl.getAllWallElementsInfo() || []).length > 0, null, {
    timeout: 30000,
  });
  const els = () =>
    p.evaluate(() =>
      window.__pl
        .getAllWallElementsInfo()
        .map((e) => ({ id: e.elementId, cls: e.class, asset: e.assetUuid })),
    );
  const SINGLE = "8aa4897f-9aec-4c1e-8024-44006b8bd7a2",
    FRENCH = "96aee4f2-6a5a-4c81-9935-9ba12df57452";
  // on retire tout ce qui ne sert pas, puis on ajoute les modèles manquants (cartes du panneau)
  const want = openings.map((o) => (o.glass ? FRENCH : SINGLE));
  const have = await els();
  const used = new Set();
  const assign = [];
  for (const a of want) {
    const e = have.find((e) => e.asset === a && !used.has(e.id));
    if (e) {
      used.add(e.id);
      assign.push(e.id);
    } else assign.push(null);
  }
  await p.evaluate(
    (ids) => ids.forEach((id) => window.__pl.deleteWallElement(id)),
    have.filter((e) => !used.has(e.id)).map((e) => e.id),
  );
  for (let i = 0; i < want.length; i++)
    if (!assign[i]) {
      const before = new Set((await els()).map((e) => e.id));
      const label = want[i] === FRENCH ? "Porte-fenêtre à double battant" : "Porte battante";
      await p
        .getByTestId("asset-card")
        .filter({ hasText: label })
        .first()
        .click()
        .catch(async () => {
          const idx = await p.$$eval(
            "[data-testid=asset-card]",
            (c, l) => c.findIndex((x) => (x.parentElement.innerText || "").includes(l)),
            label,
          );
          await p.getByTestId("asset-card").nth(idx).click();
        });
      await p.waitForFunction(
        (b) => window.__pl.getAllWallElementsInfo().some((e) => !b.includes(e.elementId)),
        [...before],
        { timeout: 30000 },
      );
      assign[i] = (await els()).find((e) => !before.has(e.id)).id;
    }
  // deux passes : une ouverture posée peut en pousser une autre tant que tout n'est pas à sa place
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < openings.length; i++) {
      const o = openings[i];
      await p.evaluate(placeEl, [assign[i], segWall[o.seg], o.center / 100, o.w / 100, o.h / 100]);
    }
  lap(
    "ouvertures : " +
      JSON.stringify(
        await p.evaluate(() =>
          window.__pl.getAllWallElementsInfo().map((e) => [e.elementId, e.wallId, e.currentSize]),
        ),
      ),
  );

  // vue de dessus (cotes affichées par le room-builder)
  await p.evaluate(() => {
    const pl = window.__pl;
    try {
      pl.clearCurrentSelection();
    } catch (e) {}
    for (const id of pl.plannerViewers.keys()) pl.setTopDownCameraView(id, false);
  });
  await p.mouse.click(1400, 60).catch(() => {}); // désélection (masque le panneau de cotes de l'ouverture)
  await p.waitForTimeout(3000);
  const png = path.join(OUT, "plan-dessus.png");
  await p.screenshot({ path: png, clip: { x: 544, y: 0, width: 896, height: 900 } });

  // ---------- 3. « Aménager cette pièce » : crée la scène côté IKEA ----------
  await p.getByTestId("primary-cta-button").click();
  await p.waitForTimeout(1500);
  await p.getByTestId("primary-cta-button").filter({ hasText: "Aménager" }).click();
  await p.waitForURL(/home-design\/room\/#/, { timeout: 120000 });
  const sceneUuid = p.url().split("/").pop();
  await p
    .getByPlaceholder("Que recherchez-vous ?")
    .waitFor({ timeout: 120000 })
    .catch(() => {});
  lap("scène " + sceneUuid);

  // ---------- 4. composition + lien de partage (jeton invité, sans compte) ----------
  let tok = decodeURIComponent((await ctx.cookies()).find((c) => c.name === "guest").value);
  if (tok.startsWith("{")) {
    const j = JSON.parse(tok);
    tok = j.access_token || j.token;
  }
  const sh = await p.evaluate(shareScene, [sceneUuid, tok, NAME]);
  lap("partage " + sh.shareUrl);

  // ---------- 5. vérification sur la version publique ----------
  const rd = (await p.evaluate(readRoom, sh.compositionUuid)).roomDefinition;
  const vpos = (id) => {
    const v = rd.vertices.find((v) => v.id === id).position;
    return [v.x * 100, -v.y * 100];
  }; // -> repère maquette (cm)
  const near = (q, r) => Math.hypot(q[0] - r[0], q[1] - r[1]);
  const rows = [],
    fail = [];
  const row = (what, exp, got, tol = TOL) => {
    const ok = got != null && Math.abs(exp - got) <= tol;
    rows.push({
      what,
      attendu: +exp.toFixed(2),
      obtenu: got == null ? null : +got.toFixed(2),
      ecart: got == null ? null : +(got - exp).toFixed(2),
      ok,
    });
    if (!ok) fail.push(what);
  };
  const wallOfSeg = [];
  for (let i = 0; i < n; i++) {
    const s = seg(i);
    const w =
      rd.walls.find(
        (w) => near(vpos(w.vertices[0]), s.a) < TOL && near(vpos(w.vertices[1]), s.b) < TOL,
      ) ||
      rd.walls.find(
        (w) => near(vpos(w.vertices[1]), s.a) < TOL && near(vpos(w.vertices[0]), s.b) < TOL,
      );
    wallOfSeg[i] = w;
    const got = w ? near(vpos(w.vertices[0]), vpos(w.vertices[1])) : null;
    row(`mur ${i} (${s.a} -> ${s.b})`, s.len, got);
  }
  row("hauteur sous plafond", m.H, rd.ceiling.height * 100);
  rd.wallElements.length === openings.length
    ? null
    : fail.push("nombre d'ouvertures " + rd.wallElements.length);
  openings.forEach((o, i) => {
    const s = seg(o.seg),
      w = wallOfSeg[o.seg];
    const e =
      w &&
      rd.wallElements.find(
        (e) => e.wall === w.id && rd.assets[e.asset].uuid === (o.glass ? FRENCH : SINGLE),
      );
    const name = o.glass ? "porte-fenêtre" : "porte";
    if (!e) {
      fail.push(name + " absente du mur " + o.seg);
      return;
    }
    // position le long du mur depuis son 1er sommet -> ramenée depuis P[seg] et projetée sur x comme dans la maquette
    const from = vpos(w.vertices[0]);
    const dir = near(from, s.a) < TOL ? 1 : -1;
    const along = dir > 0 ? e.position.x * 100 : s.len - e.position.x * 100;
    const cx = s.a[0] + s.ux * along; // abscisse x maquette du centre
    const half = ((e.size.w * 100) / 2) * Math.abs(s.ux);
    const x0 = Math.min(cx - half, cx + half),
      x1 = Math.max(cx - half, cx + half);
    // attendu tiré de OPEN seul (DOOR/WIN facultatifs) : début/fin le long du mur, projetés comme la mesure
    const a0 = s.a[0] + s.ux * (o.center - o.w / 2),
      a1 = s.a[0] + s.ux * (o.center + o.w / 2);
    if (Math.abs(s.ux) > 0.5) {
      row(`${name} ${i} x début`, Math.min(a0, a1), x0);
      row(`${name} ${i} x fin`, Math.max(a0, a1), x1);
    } else row(`${name} ${i} centre le long du mur ${o.seg}`, o.center, along);
    row(`${name} largeur`, o.w, e.size.w * 100);
    row(`${name} hauteur`, o.h, e.size.h * 100);
    row(`${name} allège (bas)`, 0, (e.position.y - e.size.h / 2) * 100);
  });
  const txt = rows
    .map(
      (r) =>
        `${r.ok ? "OK " : "KO "} ${r.what.padEnd(34)} attendu ${String(r.attendu).padStart(7)}  obtenu ${String(r.obtenu).padStart(7)}  écart ${r.ecart}`,
    )
    .join("\n");
  const res = {
    ok: fail.length === 0,
    fail,
    shareUrl: sh.shareUrl,
    compositionUuid: sh.compositionUuid,
    sceneUuid,
    png,
    rows,
    roomDefinition: rd,
  };
  fs.writeFileSync(path.join(OUT, "verif.json"), JSON.stringify(res, null, 1));
  fs.writeFileSync(
    path.join(OUT, "verif.txt"),
    txt +
      "\n" +
      (res.ok ? "TOUT CONFORME" : "ÉCARTS : " + fail.join(", ")) +
      "\nLien : " +
      sh.shareUrl +
      "\n",
  );
  console.log(txt);
  console.log(res.ok ? "TOUT CONFORME (tolérance " + TOL + " cm)" : "ÉCARTS : " + fail.join(", "));
  console.log("Capture :", png);
  console.log("Lien de partage :", sh.shareUrl);
  await p.close().catch(() => {});
  if (!process.env.CDP) await browser.close();
  process.exit(res.ok ? 0 : 2);
})().catch((e) => {
  console.error("ERREUR", e.message);
  process.exit(1);
});
