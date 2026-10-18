#!/usr/bin/env node
// maquette-vers-ikea.js <maquette.html> <version> [dossier_sortie] [--port 9240] [--scene <uuid>] [--rebuild] [--no-panier] [--rapide] [--nom "…"]
//
// Pour une version d'une maquette 3D (format : voir ikea.js), produit :
//   1. un design IKEA (planificateur home-design, invité, sans compte) partagé : la pièce exacte + les meubles posés au bon endroit,
//      vérifié (boîtes englobantes réellement rendues par l'éditeur IKEA comparées à la maquette, tolérance 2 cm) ;
//   2. le lien qui remplit le panier ikea.fr (liste-achat.js).
// Piloté uniquement par ITEMS (positions par version, emprise w×d×h, face, refs:[{itemNo,q}], sub3d, st:'own', kind, q3d).
// Utilisable seul (compatibilité) ou comme module : require('./maquette-vers-ikea.js').run({...}) (utilisé par ikea.js).
//
// Pièce : construite une fois par piece/build-room.js (room-builder IKEA, ~60 s) puis mémorisée dans pieces.json, clé = signature
//   de la géométrie (H, P, DOOR, WIN, OPEN) : une nouvelle pièce est construite automatiquement ; --scene force la source, --rebuild reconstruit.
// Navigateur : lancé dès le départ en parallèle des requêtes, sur le premier port CDP libre 9240-9249 (--port N l'impose ; un Chrome
//   qui écoute déjà sur ce port est réutilisé), profil dans <tmp>/ikea-planner, arrêté à la fin (kill du groupe) ; verrou : un seul à la fois.
// --rapide : aucun navigateur ; vérification sur le JSON enregistré + corrections de pivot apprises (modeles-3d.json), sans capture.
// Sorties : rapport.txt, rapport.json, vue-dessus.png, plan-2d.png (ou .svg), panier.html/json/txt.
"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { spawn, execFile } = require("child_process");
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";
const K = require("./lib/kreativ.js"),
  G = require("./lib/geo3.js"),
  C = require("./lib/catalogue.js"),
  PL = require("./lib/plan.js"),
  CH = require("./lib/chrome.js");
const geom = require("./piece/geom.js");

const TOL = 2,
  WALL_GAP = 4.5,
  PLINTHE = 2.5; // cm ; le planificateur décolle les objets muraux de 4 cm et écarte du mur (plinthe) les meubles au sol de 1 à 2 cm
const r1 = (v) => Math.round(v * 10) / 10;
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const PIECES = path.join(__dirname, "pieces.json"),
  MODELES = path.join(__dirname, "modeles-3d.json");

// petit fichier JSON partagé : relu juste avant l'écriture, fusionné, écrit de façon atomique
function jsonMerge(file, patch) {
  let o = {};
  try {
    o = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  Object.assign(o, patch);
  const t = file + "." + process.pid;
  fs.writeFileSync(t, JSON.stringify(o, null, 1));
  fs.renameSync(t, file);
  return o;
}
// Corrections apprises (modeles-3d.json) : l'éditeur peut tourner / décaler un modèle selon son support et sa position. Chaque correction
// mémorise son contexte (support, emprise de l'entrée, cap, position sur le support) et ne s'applique qu'à ce contexte ; sinon réapprise.
const corrCtx = (u) => ({
  sup: u.parent ? u.parent.a.fiche.id : null,
  emprise: [Math.round(u.it.w), Math.round(u.it.d)],
  cap: Math.round((u.yaw * 180) / Math.PI),
  rel: u.parent ? [Math.round(u.c[0] - u.parent.c[0]), Math.round(u.c[1] - u.parent.c[1])] : null,
});
function corrMismatch(L, u) {
  if (!L.ctx) return "entrée sans contexte (ancien format)";
  const c = corrCtx(u),
    o = L.ctx;
  if (String(o.sup) !== String(c.sup)) return "support différent";
  if (o.emprise[0] !== c.emprise[0] || o.emprise[1] !== c.emprise[1])
    return `emprise ${o.emprise.join("×")} → ${c.emprise.join("×")}`;
  if ((((o.cap - c.cap) % 360) + 360) % 360) return "orientation différente";
  if (o.rel && c.rel && Math.hypot(o.rel[0] - c.rel[0], o.rel[1] - c.rel[1]) > 2)
    return "position sur le support différente";
  return null;
}
// une entrée = une liste de variantes {dyaw, k, ctx}, une par contexte rencontré (les entrées sans contexte sont ignorées)
const MAX_VARIANTES = 8;
const variantes = (L) =>
  (L && Array.isArray(L.variantes) ? L.variantes : []).filter((v) => v && v.ctx);
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return {};
  }
};
function titre(file) {
  const m = /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(file, "utf8"));
  return (m ? m[1] : path.basename(file, ".html")).replace(/\s+en 3D\s*$/i, "").trim();
}

// objets déjà possédés (st:'own') : substitut visuel IKEA de même taille, cherché par `q3d` de l'entrée, sinon selon `kind`, sinon par son nom
const OWN_QUERIES = {
  desk: ["bureau"],
  chair: ["chaise de bureau", "chaise pivotante"],
  printer: ["boîte de rangement", "rangement"],
  lamp: ["lampe de bureau", "lampe"],
  sofa: ["canapé"],
  bed: ["lit"],
  table: ["table"],
  tv: ["meuble TV"],
  plant: ["plante artificielle"],
  box: ["boîte de rangement"],
};
const OWN_TYPE = {
  desk: "bureau",
  chair: "chaise de bureau",
  lamp: "lampe de bureau",
  sofa: "canapé",
  bed: "lit",
};

async function run(cfg) {
  const MAQ = path.resolve(cfg.maquette),
    V = cfg.version,
    OUT = path.resolve(cfg.out);
  const rapide = !!cfg.rapide,
    log = cfg.log || console.log;
  fs.mkdirSync(OUT, { recursive: true });
  const T0 = Date.now(),
    lap = (m) => log(((Date.now() - T0) / 1000).toFixed(1).padStart(6) + "s  " + m);
  const prof = {};
  const step = async (k, fn) => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      prof[k] = r1((prof[k] || 0) + (Date.now() - t) / 1000);
    }
  };
  const notes = [],
    subs = [];
  const NOM = cfg.nom || titre(MAQ);

  const m = geom.readMaquette(MAQ);
  const items = PL.loadItems(MAQ);
  if (!items.some((it) => it[V]))
    throw new Error(
      `version « ${V} » absente de la maquette (aucune entrée ITEMS n'a de champ ${V})`,
    );

  // ---------- navigateur : lancé tout de suite, en parallèle des requêtes ----------
  let chrome = null,
    browser = null,
    chromeP = null;
  const getChrome = () =>
    chromeP ||
    (chromeP = step("chrome", () => CH.launch({ port: cfg.port, log: lap })).then((c) => {
      chrome = c;
      lap(`Chrome prêt (${c.url}${c.owned ? "" : ", réutilisé"})`);
      return c;
    }));
  const getBrowser = async () => {
    if (browser) return browser;
    const c = await getChrome();
    const { chromium } = require("./playwright.js");
    browser = await chromium.connectOverCDP(c.url, { timeout: 30000 });
    return browser;
  };
  const sigRoom = crypto
    .createHash("sha1")
    .update(JSON.stringify([m.H, m.P, m.DOOR, m.WIN, m.OPEN]))
    .digest("hex")
    .slice(0, 12);
  const P0 = readJson(PIECES);
  const needRoom = !cfg.scene && (!P0[sigRoom] || cfg.rebuild);
  if (!rapide || needRoom) getChrome().catch(() => {});

  // ---------- panier : en parallèle de tout le reste ----------
  const panier =
    cfg.panier === false
      ? Promise.resolve(null)
      : step(
          "panier",
          () =>
            new Promise((res) => {
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
                  ...(cfg.sansTable ? ["--sans-table"] : []),
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
              );
              let o = "";
              c.stdout.on("data", (d) => (o += d));
              c.stderr.on("data", (d) => (o += d));
              const to = setTimeout(() => {
                c.kill();
                o += "\nliste-achat : délai de 120 s dépassé";
              }, 120000);
              c.on("close", () => {
                clearTimeout(to);
                fs.writeFileSync(path.join(OUT, "panier.txt"), o);
                try {
                  res(JSON.parse(fs.readFileSync(pj, "utf8")));
                } catch (e) {
                  res({ erreur: o.slice(-500) });
                }
              });
            }),
        );

  try {
    // ---------- pièce ----------
    const room = await step("piece", async () => {
      if (cfg.scene) return { scene: cfg.scene, built: false };
      if (!needRoom) return { ...P0[sigRoom], built: false };
      lap(
        "pièce inconnue (signature " +
          sigRoom +
          ") : construction dans le room-builder IKEA (~60 s)…",
      );
      const dir = path.join(OUT, "piece");
      const c = await getChrome();
      await new Promise((res, rej) =>
        execFile(
          process.execPath,
          [path.join(__dirname, "piece/build-room.js"), MAQ, dir],
          {
            env: { ...process.env, CDP: c.url, NAME: `${NOM} - pièce` },
            timeout: 300000,
            maxBuffer: 1 << 24,
          },
          (e, so, se) => {
            fs.writeFileSync(path.join(OUT, "piece.log"), so + se);
            if (e && e.code !== 2)
              rej(new Error("construction de la pièce échouée : " + (se || e.message).slice(-400)));
            else res();
          },
        ),
      );
      const v = JSON.parse(fs.readFileSync(path.join(dir, "verif.json"), "utf8"));
      if (!v.ok)
        notes.push(
          "pièce : écarts à la construction (" +
            v.fail.join(", ") +
            "), voir " +
            path.join(dir, "verif.txt"),
        );
      const rec = {
        scene: v.sceneUuid,
        roomShare: v.shareUrl,
        date: new Date().toISOString(),
        maquette: path.basename(MAQ),
        ok: v.ok,
      };
      if (v.ok) jsonMerge(PIECES, { [sigRoom]: rec });
      return { ...rec, built: true };
    });
    lap(
      `pièce : scène source ${room.scene}${room.built ? " (construite)" : " (réutilisée, signature " + sigRoom + ")"}`,
    );

    const token = await step("jeton", () => K.guestToken());
    const sel = items.filter((it) => PL.isOn(it, V));
    const allNos = [
      ...new Set(
        sel
          .flatMap((it) => (it.refs || []).map((r) => K.no8(r.itemNo)))
          .concat(sel.filter((it) => it.sub3d).map((it) => K.no8(it.sub3d))),
      ),
    ];
    const [srcScene, F] = await step("scene+refs", () =>
      Promise.all([K.getScene(room.scene, token), K.resolve(allNos, token)]),
    );
    const scene = await step("scene+refs", () =>
      K.copyScene(room.scene, token, `${NOM} - version ${V}`, srcScene),
    );
    const surfacesP = K.getScene(scene, token).then((sc) => G.surfaces(sc.gltfManifest));
    lap(`scène copiée pour un invité neuf : ${scene}`);

    const { units } = await step("equivalents", () =>
      planUnits(m, sel, F, token, V, notes, subs, { choisir3D: cfg.choisir3D, teinte: cfg.teinte }),
    );
    const surfaces = await surfacesP;
    // corrections de pivot / cap apprises lors des lancements précédents (modèle posé par l'éditeur autrement que demandé)
    const learned = readJson(MODELES);
    for (const u of units) {
      const L = learned[`${u.a.fiche.id}|${u.mode}`];
      if (!L) continue;
      const vs = variantes(L),
        v = vs.find((v) => !corrMismatch(v, u));
      if (!v) {
        const why = vs.length
          ? corrMismatch(vs[vs.length - 1], u)
          : "entrée sans contexte (ancien format)";
        u.corrIgnoree = why;
        notes.push(`correction apprise ignorée pour ${u.id} (${why}) : réapprise en mode normal`);
        continue;
      }
      u.corr = { dyaw: v.dyaw, k: v.k };
      u.corrSrc = "apprise";
    }
    const applied = units.filter((u) => u.corr).map((u) => u.id);
    if (applied.length)
      notes.push(`corrections de pivot apprises appliquées d'emblée : ${applied.join(", ")}`);
    let placed = toPlaced(units, surfaces);
    lap(`${units.length} meubles 3D à poser (${surfaces.length} surfaces)`);
    const comp = await step("design", () =>
      K.createComposition(token, scene, placed, `${NOM} - version ${V}`),
    );
    lap("design partagé : " + comp.shareUrl);

    // ---------- vérification ----------
    let V1,
      passes = 1,
      png = null,
      editor = null;
    if (!rapide) {
      editor = await step("ouverture-editeur", () => openEditor(getBrowser, comp.editorUrl, lap));
      V1 = await step("verification", () => verifyRendered(editor, units, m, notes, lap));
      // 2e passe si l'éditeur a tourné / décalé certains modèles (pivot ou cap propres au modèle, ex. lampe FORSÅ) : même lien
      const fix = units.filter(
        (u) => u.got && u.got.bad.length && u.got.sizeOk && u.mode !== "mur" && u.O,
      );
      if (fix.length) {
        const pat = {};
        for (const u of fix) {
          const yReq = u.yawReq != null ? u.yawReq : u.yaw;
          const dyaw = Math.atan2(Math.sin(u.got.yaw - yReq), Math.cos(u.got.yaw - yReq)),
            yr = u.got.yaw;
          const vx = u.got.c[0] - u.O[0],
            vz = u.got.c[1] - u.O[2];
          u.corr = {
            dyaw,
            k: [vx * Math.cos(yr) - vz * Math.sin(yr), vx * Math.sin(yr) + vz * Math.cos(yr)],
          };
          u.corrSrc = "mesurée";
          // mémorisée pour les prochains lancements seulement si l'éditeur a tourné le modèle (propre au modèle) ; un simple décalage
          // peut venir du voisinage (collision, plinthe) et ne se généralise pas
          if (Math.abs(dyaw) > 0.02)
            pat[`${u.a.fiche.id}|${u.mode}`] = {
              u,
              v: { ...u.corr, ctx: corrCtx(u), date: new Date().toISOString() },
            };
        }
        if (Object.keys(pat).length)
          try {
            // relu juste avant l'écriture : on remplace seulement la variante du même contexte
            const cur = readJson(MODELES),
              up = {};
            for (const [key, { u, v }] of Object.entries(pat)) {
              const vs = variantes(cur[key])
                .filter((o) => corrMismatch(o, u))
                .slice(-(MAX_VARIANTES - 1));
              up[key] = {
                nom: `${u.a.fiche.name} ${u.a.fiche.typeName} ${u.a.fiche.localItemNumber}`,
                variantes: [...vs, v],
              };
            }
            jsonMerge(MODELES, up);
          } catch (e) {
            notes.push("modeles-3d.json non écrit : " + e.message);
          }
        lap("2e passe pour " + fix.map((u) => u.id).join(", "));
        placed = toPlaced(units, surfaces, true);
        const how = await step("design", () =>
          K.updateComposition(token, comp, placed, `${NOM} - version ${V}`).catch((e) => {
            notes.push("mise à jour du design refusée : " + e.message.slice(0, 120));
            return false;
          }),
        );
        if (how) {
          notes.push(
            `2e passe : pivot/cap corrigés pour ${fix.map((u) => u.id).join(", ")} (design mis à jour, même lien)`,
          );
        } else {
          const c2 = await K.createComposition(token, scene, placed, `${NOM} - version ${V}`);
          notes.push(
            `2e passe : nouveau design (mise à jour impossible) ; 1er design ${comp.shareUrl}`,
          );
          Object.assign(comp, c2);
        }
        await step("ouverture-editeur", () => reloadEditor(editor, comp.editorUrl, how));
        V1 = await step("verification", () => verifyRendered(editor, units, m, notes, lap));
        passes = 2;
      }
      png = await step("captures", () => topView(editor, path.join(OUT, "vue-dessus.png"))).catch(
        (e) => {
          notes.push("capture vue de dessus : " + e.message.split("\n")[0]);
          return null;
        },
      );
      lap("captures");
    } else {
      V1 = await step("verification", () => verifyStored(comp, placed, units, m, notes));
      // modèle que l'éditeur réoriente, dont la correction apprise ne vaut pas ici : le rendu ne peut pas être garanti sans navigateur
      for (const u of units.filter((u) => u.corrIgnoree))
        V1.fails.push(
          `${u.id} : rendu non garanti (l'éditeur réoriente ce modèle ; ${u.corrIgnoree}) → relancer en mode normal`,
        );
      notes.push(
        "mode rapide : vérification sur le JSON enregistré (meubles, positions, rotations envoyées) et la géométrie prévue, sans rendu de l’éditeur IKEA ni capture",
      );
    }
    const { rows, fails, got } = V1;
    const planPng = await step("captures", () =>
      plan2d(m, units, got, OUT, V, rapide ? null : getBrowser),
    ).catch((e) => {
      notes.push("plan 2D : " + e.message);
      return null;
    });
    const cart = await panier;
    if (editor) await editor.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (chrome) await chrome.stop();
    else if (chromeP) await chromeP.then((c) => c.stop()).catch(() => {});

    // ---- rapport ----
    const dur = (Date.now() - T0) / 1000;
    const fmtR = (a) =>
      `${a.x[0]}–${a.x[1]} / ${a.z[0]}–${a.z[1]} / ${a.y[0]}–${a.y[1]} ${a.facade}`;
    const lines = [
      `Version ${V} — ${path.basename(MAQ)} — ${new Date().toISOString()}`,
      `Design partagé : ${comp.shareUrl}`,
      `Éditeur : ${comp.editorUrl}`,
      `Panier ikea.fr : ${cart && cart.lien ? cart.lien : "(non calculé)"}${cart && cart.total ? "  (total " + cart.total + " €)" : ""}`,
      "",
      rapide
        ? "Vérification (mode rapide, cm, x / z / y, façade) — attendu = maquette avec les dimensions catalogue, prévu = position enregistrée :"
        : "Vérification (cm, x / z / y, façade) — attendu = maquette avec les dimensions catalogue, obtenu = boîte rendue par l’éditeur IKEA :",
    ];
    for (const r of rows)
      lines.push(
        `${r.ok ? (r.ecartMural ? "OK*" : "OK ") : "KO "} ${r.id.padEnd(11)} ${r.nom.slice(0, 44).padEnd(44)} ${r.pose.padEnd(10)} att ${fmtR(r.attendu)}  obt ${r.obtenu ? fmtR(r.obtenu) : "—"}${r.ecart ? "  Δc " + [r.ecart.centre.x, r.ecart.centre.z, r.ecart.centre.y].join("/") + " rot " + r.ecart.rotation + "°" : ""}${r.note ? "  [" + r.note + "]" : ""}`,
      );
    lines.push(
      fails.length
        ? "ÉCARTS : " + fails.join(" ; ")
        : `TOUT CONFORME (tolérance ${TOL} cm${rapide ? ", mode rapide" : ""} ; OK* = écart perpendiculaire au mur imposé par le planificateur : objet mural décollé de 4 cm, meuble au sol écarté de la plinthe ≤ ${PLINTHE} cm)`,
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
    const captures = [png, planPng].filter(Boolean);
    lines.push("", ...captures.map((c) => "Capture : " + c), `Durée : ${dur.toFixed(0)} s`);
    const res = {
      version: V,
      maquette: MAQ,
      nom: NOM,
      ok: !fails.length,
      fails,
      shareUrl: comp.shareUrl,
      editorUrl: comp.editorUrl,
      compositionUuid: comp.compositionUuid,
      scene,
      sceneSource: room.scene,
      roomSig: sigRoom,
      roomBuilt: room.built,
      panier: cart && cart.lien,
      panierRemplace: cart && cart.lienRemplace,
      panierTotal: cart && cart.total,
      panierDetail: cart,
      rows,
      substitutions: subs,
      notes,
      passes,
      corrections: Object.fromEntries(
        units
          .filter((u) => u.corr && u.uniqueId)
          .map((u) => [u.uniqueId, { dyaw: u.corr.dyaw, k: u.corr.k, src: u.corrSrc }]),
      ),
      mode: rapide ? "rapide" : "navigateur",
      placedFurniture: placed,
      durationS: dur,
      profil: prof,
      captures,
    };
    fs.writeFileSync(path.join(OUT, "rapport.txt"), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(OUT, "rapport.json"), JSON.stringify(res, null, 1));
    res.texte = lines.join("\n");
    return res;
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    if (chrome) await chrome.stop().catch(() => {});
    else if (chromeP) await chromeP.then((c) => c.stop()).catch(() => {});
    throw e;
  }
}

// ---------------- meubles ----------------
// opts.choisir3D(itemNo, {teinte, dims}) (lib/teintes.js) : choix de l'équivalent 3D selon la teinte, sinon recherche intégrée
async function planUnits(m, sel, F, token, V, notes, subs, opts = {}) {
  // une entrée -> articles 3D à poser ; toutes les entrées en parallèle (recherches d'équivalents comprises)
  const perItem = await Promise.all(
    sel.map(async (it) => {
      const nt = [],
        sb = [];
      if (it.kind === "none" || Math.min(it.w, it.d, it.h) < 2)
        return {
          nt: [
            `${it.id} (${it.nm}) : panier seulement, rien à poser en 3D (kind « none » ou moins de 2 cm)`,
          ],
          sb,
          entry: null,
        };
      const box = PL.entryBox(it, V);
      let { f, why } = PL.facade(
        it,
        V,
        m.P,
        sel.filter((o) => o !== it),
      );
      const lateralX = f[1] !== 0; // façade selon z -> largeur selon x
      const span = { lat: lateralX ? it.w : it.d, dep: lateralX ? it.d : it.w };
      const arts = [];
      if (it.sub3d && F[K.no8(it.sub3d)])
        arts.push({
          fiche: F[K.no8(it.sub3d)],
          count: it.q || 1,
          refNo: K.no8(it.sub3d),
          role: "sub3d (maquette)",
        });
      else if (it.st === "own") {
        const base = it.q3d
          ? [].concat(it.q3d)
          : OWN_QUERIES[it.kind] || [String(it.nm).replace(/^(ton|ta|tes|mon|ma|mes)\s+/i, "")];
        const sz = `${Math.round(Math.max(span.lat, span.dep))}x${Math.round(Math.min(span.lat, span.dep))}`;
        const qs = base.flatMap((q) => [`${q} ${sz}`, q]);
        const e = await C.equivalent(
          { dims: { w: span.lat, d: span.dep, h: it.h }, typeExact: OWN_TYPE[it.kind] },
          token,
          qs,
        );
        if (e) {
          arts.push({ fiche: e.f, count: 1, refNo: null, role: "substitut visuel (déjà possédé)" });
          sb.push({
            entree: it.id,
            de: `${it.nm} (déjà possédé, ${r1(span.lat)}×${r1(span.dep)}×${it.h})`,
            vers: `${e.f.localItemNumber} ${e.f.name} ${e.f.typeName} ${e.f.validDesign} ${C.fmtD(K.dims(e.f))}`,
            panier: "non (déjà possédé)",
          });
        } else nt.push(`${it.id} : aucun substitut 3D trouvé pour un objet possédé`);
      } else if (Array.isArray(it.refs) && it.refs.length) {
        const refs = it.refs.map((r) => ({ no: K.no8(r.itemNo), q: r.q || 1 }));
        const present = refs
          .filter((r) => F[r.no] && K.has3d(F[r.no]))
          .map((r) => ({ fiche: F[r.no], count: r.q, refNo: r.no, role: "article" }));
        if (!(F[refs[0].no] && K.has3d(F[refs[0].no]))) {
          // article principal absent du catalogue 3D -> équivalent
          const inf = await C.infoFr(refs[0].no);
          const sz = C.parseSize(inf.size) || {};
          let e = null;
          if (opts.choisir3D) {
            // module teintes : équivalent dans la bonne teinte
            try {
              const c = await opts.choisir3D(refs[0].no, {
                teinte: opts.teinte,
                dims: sz.w ? { w: sz.w, d: sz.d, h: sz.h } : undefined,
              });
              if (c && c.itemNo3d) {
                const G3 = await K.resolve([c.itemNo3d], token);
                const fi = G3[K.no8(c.itemNo3d)];
                if (fi && K.has3d(fi))
                  e = {
                    f: fi,
                    candidates: [c.raison + (c.avertissement ? " [" + c.avertissement + "]" : "")],
                  };
              }
            } catch (x) {
              nt.push(
                `${it.id} : choix 3D par teinte en échec (${x.message.split("\n")[0]}), recherche intégrée`,
              );
            }
          }
          const full = sz.w && sz.d && sz.h ? `${sz.w}x${sz.d}x${sz.h}` : "";
          if (!e)
            e = await C.equivalent(
              {
                name: inf.name,
                type: inf.type,
                design: inf.design,
                dims: { w: sz.w, d: sz.d, h: sz.h },
              },
              token,
              [
                `${inf.name} ${inf.type} ${inf.design}`,
                full && `${inf.name} ${inf.type} ${full}`,
                full && `${inf.name} ${String(inf.type).split(" ")[0]} ${full}`,
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
            sb.push({
              entree: it.id,
              de: `${refs[0].no} ${inf.name} ${inf.type} ${inf.design} ${inf.size}`,
              vers: `${e.f.localItemNumber} ${e.f.name} ${e.f.typeName} ${e.f.validDesign} ${C.fmtD(K.dims(e.f))}`,
              panier: "référence d’origine conservée",
              autres: e.candidates,
            });
          } else
            nt.push(`${it.id} : ${refs[0].no} absent du catalogue 3D et aucun équivalent trouvé`);
        }
        // seuls les articles « structure » sont posés : on écarte façades, pieds, rails… (volume < 20 % du plus gros)
        const vol = (a) => {
          const d = K.dims(a.fiche);
          return d.w * d.d * d.h;
        };
        const vmax = Math.max(0, ...present.map(vol));
        for (const a of present) if (vol(a) >= 0.2 * vmax) arts.push(a);
      } else nt.push(`${it.id} (${it.nm}) : pas de refs ni d’objet possédé, non posé en 3D`);
      // une seule pièce dont l'emprise colle mieux tournée de 90° (tapis…) : on tourne
      if (arts.length === 1 && arts[0].count === 1) {
        const d = K.dims(arts[0].fiche);
        const err = (a, b) => Math.abs(d.w - a) + Math.abs(d.d - b);
        if (err(span.dep, span.lat) + 20 < err(span.lat, span.dep)) {
          // des deux quarts de tour, celui qui met le dos au mur le plus proche
          const sd = PL.sideDists(m.P, box),
            c1 = [f[1], -f[0]],
            c2 = [-f[1], f[0]];
          f = sd[PL.dirName([-c1[0], -c1[1]])] <= sd[PL.dirName([-c2[0], -c2[1]])] ? c1 : c2;
          why += " ; tourné de 90° (emprise du catalogue)";
        }
      }
      return { nt, sb, entry: arts.length ? { it, box, f, why, arts } : null };
    }),
  );
  const entries = [];
  for (const r of perItem) {
    notes.push(...r.nt);
    subs.push(...r.sb);
    if (r.entry) entries.push(r.entry);
  }
  // ---- disposition dans l'emprise ----
  const units = [];
  for (const E of entries) {
    const { it, box, f } = E;
    const lateralX = f[1] !== 0;
    const lat0 = lateralX ? box.x0 : box.z0,
      latS = lateralX ? it.w : it.d;
    const back = f[0] > 0 ? box.x0 : f[0] < 0 ? box.x1 : f[1] > 0 ? box.z0 : box.z1; // dos : côté opposé à la façade
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
        const depC = back + ((f[0] + f[1]) * d.d) / 2;
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
      const want = u.E.box.y1;
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
  // un objet mural dont le modèle 3D exige le sol (placeables : ancre « floor » dans toutes les combinaisons) serait posé au sol
  // par l'éditeur : on cherche un modèle équivalent accrochable (mêmes nom/type, dimensions à 3 cm près)
  const swaps = new Map();
  for (const u of units.filter((u) => u.mode === "mur" && floorBound(u.a.fiche))) {
    const fi = u.a.fiche,
      d0 = K.dims(fi),
      key = fi.id;
    if (!swaps.has(key))
      swaps.set(
        key,
        C.equivalent(
          {
            name: fi.name,
            type: fi.typeName,
            design: fi.validDesign,
            dims: d0,
            accept: (f) =>
              !floorBound(f) &&
              Math.abs(K.dims(f).w - d0.w) <= 3 &&
              Math.abs(K.dims(f).d - d0.d) <= 3 &&
              Math.abs(K.dims(f).h - d0.h) <= 3,
          },
          token,
          [
            `${fi.name} ${fi.typeName} ${Math.round(d0.w)}x${Math.round(d0.d)}x${Math.round(d0.h)}`,
            `${fi.name} ${fi.typeName}`,
            `${fi.name} ${Math.round(d0.w)}x${Math.round(d0.h)}`,
          ],
        ).catch(() => null),
      );
    const e = await swaps.get(key);
    if (e) {
      if (!u.a.swapped) {
        notes.push(
          `${u.it.id} : modèle ${fi.localItemNumber} lié au sol dans l'éditeur, remplacé en 3D par ${e.f.localItemNumber} ${e.f.name} ${e.f.typeName} ${e.f.validDesign} (accrochable)`,
        );
      }
      u.a = { ...u.a, fiche: e.f, swapped: true };
      const sb = subs.find((x) => x.entree === u.it.id);
      const vers = `${e.f.localItemNumber} ${e.f.name} ${e.f.typeName} ${e.f.validDesign} ${C.fmtD(K.dims(e.f))} (accrochable)`;
      if (sb) sb.vers = vers;
      else
        subs.push({
          entree: u.it.id,
          de: `${fi.localItemNumber} ${fi.name} ${fi.typeName} (lié au sol en 3D)`,
          vers,
          panier: "référence d’origine conservée",
        });
    } else {
      u.note =
        (u.note ? u.note + " ; " : "") +
        `modèle ${fi.localItemNumber} lié au sol dans l'éditeur, aucun équivalent accrochable : l'éditeur le posera au sol`;
    }
  }
  return { units, entries };
}
const floorBound = (f) => {
  const p = f && f.placeables;
  if (!p || !Array.isArray(p.anchors) || !Array.isArray(p.combinations) || !p.combinations.length)
    return false;
  return p.combinations.every((c) =>
    c.some((i) => p.anchors[i] && p.anchors[i].category === "floor"),
  );
};

// keepIds : garder les uniqueId (mise à jour d'un design existant)
function toPlaced(units, surfaces, keepIds) {
  const floor = surfaces.find((s) => s.cls === "floor");
  const walls = surfaces.filter((s) => s.cls === "wall");
  if (!floor) throw new Error("scène sans sol (surface « floor ») : pièce invalide");
  let uid = 10 ** 12 + Math.floor(Math.random() * 1e9);
  for (const u of units) if (!keepIds || !u.uniqueId) u.uniqueId = String(uid++);
  const one = (u) => {
    const fi = u.a.fiche,
      cxm = (fi.minX + fi.maxX) / 2,
      czm = (fi.minZ + fi.maxZ) / 2;
    const s = Math.sin(u.yaw),
      c = Math.cos(u.yaw);
    // origine du modèle en monde glTF (m) : centre voulu − rotation(centre du modèle)
    const O = [u.c[0] / 100 - (cxm * c + czm * s), u.y / 100, u.c[1] / 100 - (-cxm * s + czm * c)];
    const qy = G.qaxis([0, 1, 0], u.yaw);
    u.yawReq = null;
    if (u.corr) {
      // le planificateur tourne / décale ce modèle (pivot et cap propres au modèle) ; on compense
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
    u.O = O;
    if (u.mode === "sol") {
      const q = G.qmul(
        G.qaxis([0, 0, 1], Math.atan2(-u.f[1], u.f[0]) - (u.corr ? u.corr.dyaw : 0)),
        [0.5, 0.5, 0.5, 0.5],
      );
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
      u.y = 0;
      u.exp.y0 = 0;
      u.exp.y1 = u.d.h;
      return one(u);
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
  };
  return units.map(one);
}

// ---------------- éditeur IKEA : ouverture, mesure, vue de dessus ----------------
const VIEW = { width: 1280, height: 860 };
async function openEditor(getBrowser, editorUrl, lap) {
  const b = await getBrowser();
  const ctx = b.contexts()[0] || (await b.newContext());
  if (!ctx.__ikeaInit) {
    ctx.__ikeaInit = true;
    await ctx.addInitScript({ path: path.join(__dirname, "lib/gpu-spoof.js") });
    await ctx.addInitScript({ path: path.join(__dirname, "lib/hooks.js") });
    await ctx.addInitScript({ path: path.join(__dirname, "lib/quality-low.js") });
    const BL = require("./lib/block-list.js");
    await ctx.route(
      (u) => {
        try {
          const x = new URL(String(u));
          return (
            BL.HOSTS.some((h) => x.hostname.includes(h)) ||
            (x.hostname === "www.ikea.com" && BL.PATHS.some((p) => x.pathname.includes(p)))
          );
        } catch {
          return false;
        }
      },
      (r) => r.abort().catch(() => {}),
    );
  }
  const p = await ctx.newPage();
  await p.setViewportSize(VIEW);
  p.on("dialog", (d) => d.accept().catch(() => {}));
  await gotoEditor(p, editorUrl, lap);
  return p;
}
async function gotoEditor(p, url, lap) {
  for (let k = 0; ; k++) {
    try {
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await p.waitForFunction(
        () => {
          const v = window.__kViewer;
          return !!(v && v.scene && v.scene.threeScene);
        },
        null,
        { timeout: 90000, polling: 250 },
      );
      if (lap) lap("éditeur IKEA ouvert");
      return;
    } catch (e) {
      if (k >= 1)
        throw new Error("éditeur IKEA injoignable ou trop lent (" + e.message.split("\n")[0] + ")");
      if (lap) lap("éditeur : nouvel essai (" + e.message.split("\n")[0].slice(0, 80) + ")");
    }
  }
}
async function reloadEditor(p, url, sameUrl) {
  if (sameUrl) await p.goto("about:blank").catch(() => {});
  await gotoEditor(p, url);
}
// boîtes rendues, une fois tous les modèles chargés et immobiles
async function renderedBoxes(p, n, notes) {
  await p
    .waitForFunction(
      (n) => {
        const v = window.__kViewer;
        if (!v || !v.scene) return false;
        const g = v.scene.threeScene.children.filter((g) => /^renderObject-/.test(g.name));
        return g.length >= n && g.every((g) => !g.userData.isPlaceholder);
      },
      n,
      { timeout: 150000, polling: 300 },
    )
    .catch(() => notes.push("éditeur : tous les meubles ne sont pas chargés au bout de 150 s"));
  const fn = require("./lib/bbox-page.js");
  let prev = null,
    boxes = null;
  for (let i = 0; i < 20; i++) {
    // jusqu'à deux relevés identiques au mm (l'éditeur repositionne parfois après chargement)
    boxes = await p.evaluate(fn);
    const sig = JSON.stringify(
      Object.entries(boxes || {}).map(([k, b]) => [
        k,
        b.box && b.box.map((v) => Math.round(v * 1000)),
      ]),
    );
    if (sig === prev) break;
    prev = sig;
    await sleep(400);
  }
  return boxes;
}
async function verifyRendered(p, units, m, notes, lap) {
  const boxes = await renderedBoxes(p, units.length, notes);
  lap("éditeur IKEA relu (" + Object.keys(boxes || {}).length + " meubles rendus)");
  const got = {},
    rows = [],
    fails = [];
  for (const u of units) {
    const b = boxes && boxes[u.uniqueId];
    const r = rowBase(u);
    if (!b || !b.box) {
      r.ok = false;
      r.obtenu = null;
      fails.push(u.id + " non rendu");
      rows.push(r);
      u.got = null;
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
    const bad = compare(u, g, yawGot, m, r);
    // taille correcte à un quart de tour près (un modèle tourné par l'éditeur échange x et z) : correction de pivot/cap possible
    const sx = g.x1 - g.x0,
      sz = g.z1 - g.z0,
      ex = u.exp.x1 - u.exp.x0,
      ez = u.exp.z1 - u.exp.z0;
    const sizeOk =
      Math.abs(g.y1 - g.y0 - (u.exp.y1 - u.exp.y0)) <= TOL &&
      ((Math.abs(sx - ex) <= TOL && Math.abs(sz - ez) <= TOL) ||
        (Math.abs(sx - ez) <= TOL && Math.abs(sz - ex) <= TOL));
    u.got = { yaw: yawGot, c: [(g.x0 + g.x1) / 200, (g.z0 + g.z1) / 200], bad, sizeOk };
    if (bad.length) fails.push(`${u.id} : ${bad.join(", ")}`);
    rows.push(r);
  }
  return { rows, fails, got };
}
function rowBase(u) {
  const e = u.exp;
  return {
    id: u.id,
    entree: u.it.id,
    nom: `${u.a.fiche.name} ${u.a.fiche.typeName} ${u.a.fiche.localItemNumber}`,
    role: u.a.role,
    pose: u.mode + (u.wall != null ? " (mur " + u.wall + ")" : ""),
    attendu: {
      x: [r1(e.x0), r1(e.x1)],
      z: [r1(e.z0), r1(e.z1)],
      y: [r1(e.y0), r1(e.y1)],
      facade: PL.dirName(u.f),
    },
    correction: u.corrSrc || null,
    note: u.note || "",
  };
}
// compare la boîte g (cm) et le cap obtenus à l'attendu ; remplit r ; renvoie la liste des écarts
function compare(u, g, yawGot, m, r) {
  const e = u.exp;
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
  const nAx = u.f[0] !== 0 ? "x" : "z";
  const backWall = u.mode === "sol" && PL.sideDists(m.P, u.exp)[PL.dirName([-u.f[0], -u.f[1]])] < 1;
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
  return bad;
}
// mode rapide : le design enregistré contient-il exactement ce qui a été envoyé, et la géométrie prévue colle-t-elle à la maquette ?
async function verifyStored(comp, placed, units, m, notes) {
  const pub = await K.compiled(comp.compositionUuid);
  const stored = Object.fromEntries(pub.composition.placedfurnitureSet.map((p) => [p.uniqueId, p]));
  const sent = Object.fromEntries(placed.map((p) => [p.uniqueId, p]));
  const rows = [],
    fails = [],
    got = {};
  for (const u of units) {
    const r = rowBase(u),
      s = stored[u.uniqueId],
      q = sent[u.uniqueId];
    if (!s) {
      r.ok = false;
      fails.push(u.id + " absent du design enregistré");
      rows.push(r);
      continue;
    }
    const diff = ["x", "y", "z", "heading", "headingI", "headingJ", "headingK"].filter(
      (k) => Math.abs(+s[k] - +q[k]) > 1e-3,
    );
    if (String(s.furnitureId) !== String(q.furnitureId)) diff.push("modèle");
    // boîte prévue = attendu (le calcul de pose est exact hors pivot propre au modèle, corrigé si appris)
    const e = u.exp,
      g = { ...e };
    if (u.mode === "mur") {
      const n = u.f[0] !== 0 ? "x" : "z";
      g[n + "0"] += u.f[n === "x" ? 0 : 1] * 4;
      g[n + "1"] += u.f[n === "x" ? 0 : 1] * 4;
    }
    got[u.uniqueId] = g;
    const bad = compare(u, g, u.yaw, m, r).concat(
      diff.length ? ["enregistré ≠ envoyé (" + diff.join(",") + ")"] : [],
    );
    r.ok = !bad.length;
    r.enregistre = true;
    if (bad.length) fails.push(`${u.id} : ${bad.join(", ")}`);
    rows.push(r);
  }
  const extra = Object.keys(stored).filter((k) => !sent[k]);
  if (extra.length) fails.push(`${extra.length} meuble(s) en trop dans le design`);
  return { rows, fails, got };
}
// capture du canvas en vue de dessus (CDP direct : pas d'attente des polices ; délai max et nouvel essai)
async function topView(p, png) {
  await p.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((b) =>
      /Vue de dessus/.test(b.textContent),
    );
    if (!b) throw new Error("bouton « Vue de dessus » absent");
    b.click();
  });
  await p.mouse.move(VIEW.width - 5, VIEW.height - 5);
  // attendre que le rendu se stabilise (plus d'image dessinée depuis 600 ms), 8 s max
  await p
    .waitForFunction(
      () => {
        const s = window.__kStats;
        return s && s.lastDrawT && performance.now() - s.lastDrawT > 600;
      },
      null,
      { timeout: 8000, polling: 200 },
    )
    .catch(() => {});
  const cv = await p
    .evaluate(() => {
      const c = window.__kViewer.canvas.getBoundingClientRect();
      return { x: c.x, y: c.y, width: c.width, height: c.height };
    })
    .catch(() => null);
  const clip =
    cv && cv.width > 100
      ? { ...cv, scale: 1 }
      : { x: 0, y: 0, width: VIEW.width, height: VIEW.height, scale: 1 };
  const s = await p.context().newCDPSession(p);
  try {
    for (let k = 0; ; k++) {
      try {
        const r = await Promise.race([
          s.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false }),
          sleep(25000).then(() => {
            throw new Error("délai de 25 s dépassé");
          }),
        ]);
        fs.writeFileSync(png, Buffer.from(r.data, "base64"));
        return png;
      } catch (e) {
        if (k >= 2) throw e;
        await sleep(1000);
      }
    }
  } finally {
    await s.detach().catch(() => {});
  }
}

// plan 2D attendu (pointillés) / obtenu (plein) ; PNG rendu par Chrome si disponible, sinon SVG seul
async function plan2d(m, units, got, OUT, V, getBrowser) {
  const xs = m.P.map((p) => p[0]),
    zs = m.P.map((p) => p[1]);
  const S = 2,
    pad = 20,
    W = (Math.max(...xs) - Math.min(0, ...xs)) * S + 2 * pad,
    Hh = (Math.max(...zs) - Math.min(0, ...zs)) * S + 2 * pad,
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
  const op = Object.entries(m.OPEN || {})
    .flatMap(([k, os]) =>
      os.map((o) => {
        const a = m.P[k],
          b = m.P[(+k + 1) % m.P.length];
        const L = Math.abs(b[0] - a[0]) || Math.abs(b[1] - a[1]);
        const t0 = o.a / L,
          t1 = o.b / L;
        return `<line x1="${X(a[0] + (b[0] - a[0]) * t0)}" y1="${Z(a[1] + (b[1] - a[1]) * t0)}" x2="${X(a[0] + (b[0] - a[0]) * t1)}" y2="${Z(a[1] + (b[1] - a[1]) * t1)}" stroke="${o.glass ? "#4f9be6" : "#c08a4a"}" stroke-width="6"/>`;
      }),
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh + 40}"><rect width="100%" height="100%" fill="#fff"/><polygon points="${poly}" fill="#f4efe6" stroke="#333" stroke-width="3"/>${op}${rects}
<text x="${pad}" y="${Hh + 18}" font-size="12" font-family="sans-serif">Version ${V} — pointillés : attendu (maquette) ; plein : ${getBrowser ? "rendu de l'éditeur IKEA" : "position enregistrée (mode rapide)"} (bleu sol, vert posé sur un meuble, orange mural).</text><text x="${pad}" y="${Hh + 34}" font-size="12" font-family="sans-serif">Trait rouge : façade. Ouvertures : marron porte, bleu vitrée. x vers la droite, z vers le bas.</text></svg>`;
  const f = path.join(OUT, "plan-2d.svg");
  fs.writeFileSync(f, svg);
  if (!getBrowser) return f;
  const b = await getBrowser();
  const ctx = b.contexts()[0];
  const p = await ctx.newPage();
  try {
    await p.setViewportSize({ width: Math.ceil(W), height: Math.ceil(Hh + 40) });
    await p.setContent(svg, { timeout: 20000 });
    const out = path.join(OUT, "plan-2d.png");
    await p.screenshot({ path: out, timeout: 20000 });
    return out;
  } finally {
    await p.close().catch(() => {});
  }
}

module.exports = { run, planUnits, toPlaced, openEditor, renderedBoxes, topView, TOL };

// ---------------- ligne de commande (compatibilité) ----------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (k) => argv.includes(k),
    opt = (k) => {
      const i = argv.indexOf(k);
      return i >= 0 ? argv[i + 1] : null;
    };
  const pos = argv.filter(
    (a, i) => !a.startsWith("--") && !["--scene", "--port", "--nom"].includes(argv[i - 1]),
  );
  const [MAQ0, V, OUT0] = pos;
  if (!MAQ0 || !V) {
    console.error(
      'usage: node maquette-vers-ikea.js <maquette.html> <version> [dossier_sortie] [--port 9240] [--scene <uuid>] [--rebuild] [--no-panier] [--rapide] [--nom "…"]',
    );
    process.exit(1);
  }
  let port = opt("--port") ? +opt("--port") : null;
  if (!port && process.env.CDP) port = +new URL(process.env.CDP).port;
  CH.installSignals();
  run({
    maquette: MAQ0,
    version: V,
    out: OUT0 || path.join(require("os").tmpdir(), "ikea-planner", "out", V),
    port,
    scene: opt("--scene"),
    rebuild: flag("--rebuild"),
    panier: !flag("--no-panier"),
    rapide: flag("--rapide"),
    nom: opt("--nom"),
  })
    .then((r) => {
      console.log("\n" + r.texte);
      process.exit(r.ok ? 0 : 2);
    })
    .catch((e) => {
      console.error("ERREUR", e.stack || e.message);
      process.exit(1);
    });
}
