#!/usr/bin/env node
// ikea.js <maquette.html> <version> [--sortie dossier] [--teinte chene] [--rapide] [--rebuild-piece] [--port 9240] [--nom "…"] [--scene uuid] [--timeout 900] [--emprise-modele-avert]
//
// UNE commande, de la maquette 3D au design IKEA vérifié + panier ikea.fr, pour n'importe quelle pièce :
//   (a) contrôle des refs et teintes (lib/teintes.js → lintRefs ; avertissement si le module manque ou échoue), en parallèle ;
//   (b) pièce (cache pieces.json par signature de géométrie ; pièce nouvelle ou --rebuild-piece : construite dans le room-builder)
//       + pose des meubles par l'API REST (maquette-vers-ikea.js) ;
//   (c) vérification : lib/verif.js → verifierDesign (JSON public du design, indépendante) ; en mode normal, en plus, boîtes
//       réellement rendues par l'éditeur IKEA dans Chrome, correction du pivot des modèles tournés par l'éditeur (même lien), captures ;
//       --rapide : aucun navigateur (pose REST + vérification sur le JSON), sans capture ni contrôle du rendu ;
//   (d) panier ikea.fr (liste-achat.js, prix relus en ligne ; lib/teintes.js → verifierPanier s'il existe) ;
//   (e) rapport unique resume.md + resume.json dans le dossier de sortie (défaut : <tmp>/ikea-planner/<maquette>-<version>-<date>).
// Code de sortie : 0 tout conforme ; 2 écart(s) ou erreur(s) de refs/panier ; 1 erreur d'exécution. Ne se connecte à aucun compte.
//
// Format minimal de la maquette (HTML, une déclaration par ligne ; cm ; x vers la droite, z en profondeur, y hauteur) :
//   const H=250;                                   hauteur sous plafond
//   const P=[[x,z],…];                             polygone intérieur de la pièce, dans l'ordre du contour
//   const DOOR={x0,x1,h}; const WIN={x0,x1,h};     (lus par piece/build-room.js ; mettre {} s'il n'y en a pas)
//   const OPEN={<i>:[{a,b,h,glass}]};              ouvertures du segment P[i]→P[i+1], a/b le long du mur depuis P[i]
//   const PROJET={teinte:'chene',…};               facultatif : cible des teintes pour le contrôle des refs
//   const ITEMS=window.ITEMS=[{id,nm,w,d,h,<VERSION>:{x,z,y?},face?:'+x|-x|+z|-z',refs?:[{itemNo:'123.456.78',q}],
//                             sub3d?:'n° du modèle 3D à poser',st?:'own' (déjà possédé : substitut visuel, hors panier),kind?,q3d?,on?,def?}];
//   (x,z) = coin de l'emprise w (selon x) × d (selon z) ; face = côté façade (défaut : dos au mur le plus proche) ;
//   entrée kind:'none' ou de moins de 2 cm de côté : panier seulement, rien posé en 3D. Le titre <title> nomme le design (--nom sinon).
"use strict";
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";
process.removeAllListeners("warning"); // avertissement « EnvHttpProxyAgent is experimental » de Node, sans intérêt ici
const fs = require("fs"),
  path = require("path"),
  os = require("os");
const CH = require("./lib/chrome.js"),
  PL = require("./lib/plan.js");

const argv = process.argv.slice(2);
const VAL = [
  "--sortie",
  "--teinte",
  "--port",
  "--nom",
  "--scene",
  "--timeout",
  "--quincaillerie",
  "--exclure",
];
const flag = (k) => argv.includes(k),
  opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : null;
  };
const pos = argv.filter((a, i) => !a.startsWith("--") && !VAL.includes(argv[i - 1]));
if (flag("--help") || pos.length < 2) {
  const lignes = fs.readFileSync(__filename, "utf8").split("\n").slice(1);
  console.error(
    lignes
      .slice(
        0,
        lignes.findIndex((l) => !l.startsWith("//")),
      )
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(flag("--help") ? 0 : 1);
}
const MAQ = path.resolve(pos[0]),
  V = pos[1],
  RAPIDE = flag("--rapide");
if (!fs.existsSync(MAQ)) {
  console.error(`maquette introuvable : ${MAQ}`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.resolve(
  opt("--sortie") || path.join(CH.TMP, `${path.basename(MAQ, path.extname(MAQ))}-${V}-${stamp}`),
);
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now(),
  lap = (m) => console.log(((Date.now() - T0) / 1000).toFixed(1).padStart(6) + "s  " + m);
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${what} : délai de ${ms / 1000} s dépassé`)), ms).unref(),
    ),
  ]);
const tryRequire = (f) => {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) return null;
  try {
    return require(p);
  } catch (e) {
    return { erreurChargement: e.message };
  }
};

CH.installSignals();
const LIMITE = +(opt("--timeout") || 900) * 1000; // garde-fou global : Chrome est arrêté par le gestionnaire de sortie
setTimeout(() => {
  console.error(`\nERREUR : durée maximale de ${LIMITE / 1000} s dépassée (--timeout), arrêt`);
  process.exit(1);
}, LIMITE).unref();

(async () => {
  lap(
    `maquette ${path.basename(MAQ)}, version ${V}${RAPIDE ? ", mode rapide (sans navigateur)" : ""} ; sortie ${OUT}`,
  );
  const html = fs.readFileSync(MAQ, "utf8");
  const items = PL.loadItems(MAQ);
  if (!items.some((it) => it[V]))
    throw new Error(
      `version « ${V} » absente de la maquette (versions trouvées : ${[...new Set(items.flatMap((it) => Object.keys(it).filter((k) => it[k] && typeof it[k] === "object" && "x" in it[k] && "z" in it[k])))].join(", ")})`,
    );

  // (a) contrôle des refs et teintes, en parallèle du reste
  const avert = [],
    prof = {};
  const T = tryRequire("lib/teintes.js");
  const teintesOk = T && !T.erreurChargement;
  const PROJET = (teintesOk && T.lireProjet && T.lireProjet(html)) || {};
  const lintP = (async () => {
    const t = Date.now();
    if (!T || T.erreurChargement || !T.lintRefs) {
      avert.push(
        "contrôle des refs/teintes non fait : lib/teintes.js " +
          (T && T.erreurChargement ? "en erreur (" + T.erreurChargement + ")" : "absent"),
      );
      return null;
    }
    try {
      const P = PROJET;
      const o = {
        teinte: opt("--teinte") || P.teinte,
        quincaillerie: opt("--quincaillerie") || P.quincaillerie,
        textile: P.textile,
        exclure: opt("--exclure")
          ? opt("--exclure")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : P.exclure || [],
      };
      const r = await withTimeout(T.lintRefs(items, V, o), 120000, "contrôle des refs");
      fs.writeFileSync(path.join(OUT, "refs.json"), JSON.stringify(r, null, 1));
      lap(
        `refs/teintes : ${r.erreurs.length} erreur(s), ${r.avertissements.length} avertissement(s)`,
      );
      return r;
    } catch (e) {
      avert.push("contrôle des refs/teintes en échec : " + e.message.split("\n")[0]);
      return null;
    } finally {
      prof.refs = Math.round((Date.now() - t) / 100) / 10;
    }
  })();

  // (b) design + pose (+ vérification du rendu dans Chrome en mode normal) et (d) panier, lancé en parallèle par run()
  const M = require("./maquette-vers-ikea.js");
  const res = await M.run({
    maquette: MAQ,
    version: V,
    out: OUT,
    port: opt("--port") ? +opt("--port") : null,
    scene: opt("--scene"),
    rebuild: flag("--rebuild-piece"),
    rapide: RAPIDE,
    nom: opt("--nom"),
    panier: true,
    sansTable: true,
    log: lap,
    choisir3D: teintesOk && T.choisir3D ? T.choisir3D : null,
    teinte: opt("--teinte") || PROJET.teinte,
  });
  Object.assign(prof, res.profil);

  // (c) vérification indépendante sur le JSON public du design
  const VF = tryRequire("lib/verif.js");
  let verif = null;
  const tv = Date.now();
  if (VF && !VF.erreurChargement && VF.verifierDesign) {
    try {
      verif = await withTimeout(
        VF.verifierDesign({
          maquette: MAQ,
          version: V,
          cible: res.shareUrl,
          sortie: path.join(OUT, "verif"),
          options: { empriseModeleBloquante: !flag("--emprise-modele-avert") },
        }),
        120000,
        "vérification",
      );
      lap(
        `vérification indépendante (lib/verif.js) : ${verif.ok ? "conforme" : verif.ecarts.length + " écart(s)"}`,
      );
    } catch (e) {
      avert.push("vérification lib/verif.js en échec : " + e.message.split("\n")[0]);
    }
  } else
    avert.push(
      "lib/verif.js " +
        (VF && VF.erreurChargement ? "en erreur (" + VF.erreurChargement + ")" : "absent") +
        (RAPIDE
          ? " : vérification sur le JSON enregistré seulement"
          : " : vérification par le rendu Chrome seulement"),
    );
  prof.verifJson = Math.round((Date.now() - tv) / 100) / 10;

  // panier : contrôle indépendant des lignes
  const cart = res.panierDetail || null;
  const panierErr = [],
    panierAv = [];
  if (!cart || !cart.lien)
    panierErr.push(
      "lien panier non produit" + (cart && cart.erreur ? " : " + cart.erreur.slice(-200) : ""),
    );
  else {
    for (const a of cart.alertes || [])
      (/introuvable|aucune référence|non vendable|recherche par nom|à ajouter/.test(a)
        ? panierErr
        : panierAv
      ).push(a);
    if (T && T.verifierPanier) {
      try {
        const vp = await withTimeout(
          T.verifierPanier(cart.lines.map((l) => ({ no: l.no, qty: l.qty }))),
          60000,
          "contrôle du panier",
        );
        vp.erreurs.forEach((e) =>
          panierErr.push(typeof e === "string" ? e : e.msg || JSON.stringify(e)),
        );
        vp.avertissements.forEach((e) =>
          panierAv.push(typeof e === "string" ? e : e.msg || JSON.stringify(e)),
        );
      } catch (e) {
        avert.push("contrôle du panier (verifierPanier) en échec : " + e.message.split("\n")[0]);
      }
    }
  }
  const lint = await lintP;

  // (e) rapport unique
  const dedupe = (L) => [...new Set(L)];
  const ecarts = dedupe([
    ...res.fails.map((f) => (RAPIDE ? "pose (JSON) : " : "rendu éditeur : ") + f),
    ...(verif
      ? verif.ecarts.map(
          (c) =>
            `vérif. JSON : ${c.nom} : obtenu ${typeof c.obtenu === "object" ? JSON.stringify(c.obtenu) : c.obtenu}${c.ecart != null ? " (écart " + (typeof c.ecart === "object" ? JSON.stringify(c.ecart) : c.ecart) + ")" : ""}`,
        )
      : []),
    ...(lint ? lint.erreurs.map((e) => `refs : ${e.entree ? e.entree + " : " : ""}${e.msg}`) : []),
    ...panierErr.map((e) => "panier : " + e),
  ]);
  const avertissements = dedupe([
    ...avert,
    ...(lint
      ? lint.avertissements.map((e) => `refs : ${e.entree ? e.entree + " : " : ""}${e.msg}`)
      : []),
    ...(verif ? verif.avertissements.map((a) => "vérif. JSON : " + a) : []),
    ...panierAv.map((a) => "panier : " + a),
    ...res.notes,
  ]);
  const ok = res.ok && (!verif || verif.ok) && !(lint && lint.erreurs.length) && !panierErr.length;
  const lienPanier = cart && (cart.lienRemplace || (cart.lien && cart.lien + "&replaceItems=true"));
  const captures = [
    ...res.captures,
    ...(verif && verif.fichiers ? verif.fichiers.filter((f) => /\.(svg|png)$/.test(f)) : []),
  ];
  const dur = (Date.now() - T0) / 1000;
  const J = {
    ok,
    statut: ok ? "conforme" : "écarts",
    maquette: MAQ,
    version: V,
    nom: res.nom,
    mode: res.mode,
    design: res.shareUrl,
    editeur: res.editorUrl,
    compositionUuid: res.compositionUuid,
    panier: lienPanier,
    panierAjout: cart && cart.lien,
    total: cart && cart.total,
    totalMaquette: cart && cart.maquetteTotal,
    lignesPanier: cart && cart.lines,
    substitutions: res.substitutions.map((s) => ({
      entree: s.entree,
      de: s.de,
      vers: s.vers,
      panier: s.panier,
    })),
    ecarts,
    avertissements,
    captures,
    verification: {
      rendu: RAPIDE ? null : { ok: res.ok, passes: res.passes, lignes: res.rows },
      json: verif ? { ok: verif.ok, ecarts: verif.ecarts.length, fichiers: verif.fichiers } : null,
      pose: RAPIDE ? { ok: res.ok, lignes: res.rows } : null,
    },
    refs: lint
      ? { erreurs: lint.erreurs, avertissements: lint.avertissements, projet: lint.projet }
      : null,
    piece: { scene: res.sceneSource, signature: res.roomSig, construite: res.roomBuilt },
    dureeS: Math.round(dur),
    profil: prof,
    sortie: OUT,
    date: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT, "resume.json"), JSON.stringify(J, null, 1));
  const eur = (x) => (x == null ? "?" : x.toFixed(2).replace(".", ",") + " €");
  const L = [
    `## ${res.nom} — version ${V}`,
    "",
    `- **Design IKEA** (3D, modifiable) : ${res.shareUrl}`,
    `- **Panier ikea.fr** (vide puis remplit le panier, ${cart && cart.lines ? cart.lines.length + " références" : "?"}, **${eur(cart && cart.total)}**) : ${lienPanier || "—"}`,
    `- Statut : **${ok ? "tout conforme" : ecarts.length + " écart(s) à traiter"}**${RAPIDE ? " (mode rapide : rendu IKEA non contrôlé)" : ""}`,
    "",
  ];
  if (res.substitutions.length) {
    L.push("**Modèles 3D remplacés** (le panier garde la vraie référence) :");
    res.substitutions.forEach((s) =>
      L.push(
        `- ${s.entree} : ${s.de} → ${s.vers}${/possédé/.test(s.panier) ? " (déjà possédé, hors panier)" : ""}`,
      ),
    );
    L.push("");
  }
  if (ecarts.length) {
    L.push("**Écarts** :");
    ecarts.slice(0, 30).forEach((e) => L.push("- " + e));
    if (ecarts.length > 30) L.push(`- … ${ecarts.length - 30} de plus dans resume.json`);
    L.push("");
  }
  if (avertissements.length) {
    L.push("**À savoir** :");
    avertissements.slice(0, 20).forEach((e) => L.push("- " + e));
    if (avertissements.length > 20)
      L.push(`- … ${avertissements.length - 20} de plus dans resume.json`);
    L.push("");
  }
  if (captures.length) {
    L.push("**Captures** : " + captures.map((c) => "`" + c + "`").join(", "));
    L.push("");
  }
  L.push(
    `_Généré le ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} en ${Math.round(dur)} s par ikea.js (${res.mode}). Détails : ${path.join(OUT, "resume.json")}, rapport.txt._`,
  );
  fs.writeFileSync(path.join(OUT, "resume.md"), L.join("\n") + "\n");
  console.log("\n" + L.join("\n"));
  console.log(
    "\nProfil (s) : " +
      Object.entries(prof)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ") +
      ` · total ${dur.toFixed(1)}`,
  );
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error("\nERREUR : " + ((e && e.message) || e));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
