// API « sugarcube » du planificateur IKEA (home-design), invité sans compte. Node >= 22 (fetch), NODE_USE_ENV_PROXY=1.
"use strict";
const MARKET = "fr/fr";
const API = `https://api.home-design.ikea.com/${MARKET}/ideas/sugarcube/api`;
const GEO = "3d,2d_wall,wall_placeable";
const H = {
  accept: "application/json",
  "content-type": "application/json",
  origin: "https://www.ikea.com",
  referer: "https://www.ikea.com/",
};

async function call(method, url, { body, token, headers } = {}) {
  for (let k = 0; ; k++) {
    const r = await fetch(url, {
      method,
      headers: { ...H, ...(token ? { authorization: "Bearer " + token } : {}), ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (r.status >= 500 && k < 2) {
      await new Promise((s) => setTimeout(s, 1500));
      continue;
    }
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 300)}`);
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
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
// n° article -> fiche 3D (dimensions minX..maxZ en m, repère du modèle : y vers le haut, façade vers +z)
async function resolve(itemNos, token) {
  const nos = [...new Set(itemNos.map(no8))];
  const out = {};
  for (let i = 0; i < nos.length; i += 20) {
    const j = await call(
      "GET",
      `${API}/furniture/?local_item_number=${nos.slice(i, i + 20).join(",")}&geometry_type=${GEO}&material_mode=true`,
      { token },
    );
    for (const f of Array.isArray(j) ? j : Object.values(j))
      if (f && f.localItemNumber) out[f.localItemNumber] = f;
  }
  return out;
}
async function search(q, token) {
  const j = await call(
    "GET",
    `${API}/furniture/search/?q=${encodeURIComponent(q)}&region=${encodeURIComponent(MARKET)}&size=48&geometry_type=${GEO}&sort=RELEVANCE&material_mode=true`,
    { token },
  );
  return Array.isArray(j) ? j : j.results || [];
}
const dims = (f) => ({
  w: (f.maxX - f.minX) * 100,
  d: (f.maxZ - f.minZ) * 100,
  h: (f.maxY - f.minY) * 100,
});
const has3d = (f) => !f.geometryTypes || f.geometryTypes.includes("3d");

async function getScene(uuid, token) {
  return call("GET", `${API}/scenes/${uuid}?manifest_mode=manifest,gltf_manifest`, { token });
}
// copie une pièce (scène) lisible vers une scène neuve appartenant à ce jeton invité
async function copyScene(srcUuid, token, name) {
  const src = await getScene(srcUuid, token);
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
// version publique (sans authentification)
async function compiled(uuid) {
  return call(
    "GET",
    `${API}/compositions/${uuid}/compiled/?geometry_type=${GEO}&manifest_mode=manifest,gltf_manifest`,
  );
}
module.exports = {
  API,
  call,
  no8,
  guestToken,
  resolve,
  search,
  dims,
  has3d,
  getScene,
  copyScene,
  createComposition,
  compiled,
};
