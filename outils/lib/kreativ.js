// API « sugarcube » du planificateur IKEA (home-design), invité sans compte. Node >= 22 (fetch), NODE_USE_ENV_PROXY=1.
// Toutes les requêtes : délai max (IKEA_HTTP_TIMEOUT ms, défaut 30000) et nouvelles tentatives sur erreur réseau, 429 et 5xx.
"use strict";
const MARKET = process.env.IKEA_MARKET || "fr/fr";
const API = `https://api.home-design.ikea.com/${MARKET}/ideas/sugarcube/api`;
const GEO = "3d,2d_wall,wall_placeable";
const H = {
  accept: "application/json",
  "content-type": "application/json",
  origin: "https://www.ikea.com",
  referer: "https://www.ikea.com/",
};
const TIMEOUT = +(process.env.IKEA_HTTP_TIMEOUT || 30000),
  TRIES = 4;
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

// fetch avec délai max et nouvelles tentatives (erreur réseau, délai dépassé, 429, 5xx) ; renvoie {status, ok, text}
async function fetchRetry(url, init = {}, { tries = TRIES, timeout = TIMEOUT } = {}) {
  let last;
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      const text = await r.text();
      if ((r.status === 429 || r.status >= 500) && k < tries - 1) {
        last = new Error(`${r.status}`);
        await sleep(800 * 2 ** k);
        continue;
      }
      return { status: r.status, ok: r.ok, text };
    } catch (e) {
      last = e;
      if (k < tries - 1) {
        await sleep(800 * 2 ** k);
        continue;
      }
    }
  }
  const why =
    last &&
    (last.name === "TimeoutError"
      ? `délai de ${timeout / 1000} s dépassé`
      : (last.cause && last.cause.code) || last.message);
  throw new Error(
    `réseau : ${String(init.method || "GET")} ${url.slice(0, 120)} a échoué ${tries} fois (${why})`,
  );
}
async function call(method, url, { body, token, headers } = {}) {
  const r = await fetchRetry(url, {
    method,
    headers: { ...H, ...(token ? { authorization: "Bearer " + token } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const e = new Error(`${method} ${url.slice(0, 160)} -> ${r.status} ${r.text.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  try {
    return JSON.parse(r.text);
  } catch {
    return r.text;
  }
}
const no8 = (n) => String(n).replace(/\D/g, "").padStart(8, "0");

async function guestToken() {
  const g = await call("POST", "https://api.ingka.ikea.com/guest/token", {
    body: { retailUnit: MARKET.split("/")[0] },
    headers: {
      accept: "application/json;version=2",
      "x-client-id": "b477b9e4-b836-40fb-842f-43db89dd3c52",
    },
  });
  return g.access_token;
}
// n° article -> fiche 3D (dimensions minX..maxZ en m, repère du modèle : y vers le haut, façade vers +z) ; lots de 20 en parallèle
async function resolve(itemNos, token) {
  const nos = [...new Set(itemNos.map(no8))];
  const out = {};
  const lots = [];
  for (let i = 0; i < nos.length; i += 20) lots.push(nos.slice(i, i + 20));
  await Promise.all(
    lots.map(async (l) => {
      const j = await call(
        "GET",
        `${API}/furniture/?local_item_number=${l.join(",")}&geometry_type=${GEO}&material_mode=true`,
        { token },
      );
      for (const f of Array.isArray(j) ? j : Object.values(j))
        if (f && f.localItemNumber) out[f.localItemNumber] = f;
    }),
  );
  return out;
}
// recherche texte dans le catalogue 3D (mémorisée pour la durée du processus : une même requête n'est envoyée qu'une fois)
const searchMemo = new Map();
function search(q, token) {
  const k = q.trim().toLowerCase();
  if (!searchMemo.has(k))
    searchMemo.set(
      k,
      call(
        "GET",
        `${API}/furniture/search/?q=${encodeURIComponent(q)}&region=${encodeURIComponent(MARKET)}&size=48&geometry_type=${GEO}&sort=RELEVANCE&material_mode=true`,
        { token },
      )
        .then((j) => (Array.isArray(j) ? j : j.results || []))
        .catch((e) => {
          searchMemo.delete(k);
          throw e;
        }),
    );
  return searchMemo.get(k);
}
const dims = (f) => ({
  w: (f.maxX - f.minX) * 100,
  d: (f.maxZ - f.minZ) * 100,
  h: (f.maxY - f.minY) * 100,
});
// posable dans le planificateur : modèle 3D, ou combinaison murale livrée seulement en « wall_placeable » (ex. BESTÅ murales)
const has3d = (f) =>
  !f.geometryTypes || f.geometryTypes.includes("3d") || f.geometryTypes.includes("wall_placeable");

async function getScene(uuid, token) {
  return call("GET", `${API}/scenes/${uuid}?manifest_mode=manifest,gltf_manifest`, { token });
}
// copie une pièce (scène) lisible vers une scène neuve appartenant à ce jeton invité ; src = uuid ou scène déjà lue
async function copyScene(srcUuid, token, name, src) {
  src = src || (await getScene(srcUuid, token));
  const sc = await call("POST", `${API}/scenes/create_room_builder/`, {
    token,
    body: { name, roomType: src.roomType || "BEDROOM", gltf_manifest: src.gltfManifest },
  });
  return sc.uuid;
}
async function createComposition(token, sceneUuid, placedFurniture, name) {
  const comp = await call("POST", `${API}/compositions/?manifest_mode=manifest,gltf_manifest`, {
    token,
    body: {
      compositionId: "-1",
      placedFurniture,
      name,
      sceneId: sceneUuid,
      isShared: false,
      enableRemix: false,
      savedProperties: { lastSavedOn: "web", features: { design: 1 } },
    },
  });
  const sh = await call(
    "POST",
    `${API}/compositions/${comp.uuid}/shared/?manifest_mode=manifest,gltf_manifest`,
    {
      token,
      body: {
        isShared: true,
        enableRemix: true,
        sendNotifications: false,
        compositionId: comp.uuid,
      },
    },
  );
  return {
    compositionUuid: comp.uuid,
    shareUrl: sh.shareUrl,
    sceneUuid,
    editorUrl: `https://www.ikea.com/${MARKET}/home-design/room/#${comp.uuid}/${sceneUuid}`,
  };
}
// remplace les meubles d'une composition existante (même lien de partage) ; renvoie false si l'API refuse
async function updateComposition(token, comp, placedFurniture, name) {
  const body = {
    compositionId: comp.compositionUuid,
    placedFurniture,
    name,
    sceneId: comp.sceneUuid,
    savedProperties: { lastSavedOn: "web", features: { design: 1 } },
  };
  for (const method of ["PUT", "PATCH"]) {
    try {
      await call(
        method,
        `${API}/compositions/${comp.compositionUuid}/?manifest_mode=manifest,gltf_manifest`,
        { token, body },
      );
      return method;
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
    }
  }
  return false;
}
// version publique (sans authentification)
async function compiled(uuid) {
  return call(
    "GET",
    `${API}/compositions/${uuid}/compiled/?geometry_type=${GEO}&manifest_mode=manifest,gltf_manifest`,
  );
}
module.exports = {
  API,
  MARKET,
  call,
  fetchRetry,
  no8,
  guestToken,
  resolve,
  search,
  dims,
  has3d,
  getScene,
  copyScene,
  createComposition,
  updateComposition,
  compiled,
};
