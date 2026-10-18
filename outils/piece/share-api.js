// Crée la composition (design) sur la scène et la partage, depuis la page (jeton invité = cookie 'guest')
exports.shareScene = async ([sceneUuid, token, name]) => {
  const API = "https://api.home-design.ikea.com/fr/fr/ideas/sugarcube/api";
  const H = {
    accept: "application/json",
    "content-type": "application/json",
    authorization: "Bearer " + token,
  };
  const call = async (m, u, b) => {
    const r = await fetch(u, { method: m, headers: H, body: b && JSON.stringify(b) });
    const t = await r.text();
    if (!r.ok) throw new Error(m + " " + u + " " + r.status + " " + t.slice(0, 300));
    return JSON.parse(t);
  };
  const comp = await call("POST", `${API}/compositions/?manifest_mode=manifest,gltf_manifest`, {
    compositionId: "-1",
    placedFurniture: [],
    name,
    sceneId: sceneUuid,
    isShared: false,
    enableRemix: false,
    savedProperties: { lastSavedOn: "web", features: { design: 1 } },
  });
  const sh = await call(
    "POST",
    `${API}/compositions/${comp.uuid}/shared/?manifest_mode=manifest,gltf_manifest`,
    { isShared: true, enableRemix: true, sendNotifications: false, compositionId: comp.uuid },
  );
  return { compositionUuid: comp.uuid, shareUrl: sh.shareUrl };
};
// Relit la géométrie publique d'une composition (sans authentification)
exports.readRoom = async (uuid) => {
  const u = `https://api.home-design.ikea.com/fr/fr/ideas/sugarcube/api/compositions/${uuid}/compiled/?geometry_type=3d,2d_wall,wall_placeable&manifest_mode=manifest,gltf_manifest`;
  const j = await (await fetch(u)).json();
  const sc = j.scene.lastSuccessfulJob.gltfManifest.extras.geomagical.geomagicalScenes[0];
  return {
    roomDefinition: sc.roomDefinition || sc.roomTemplate,
    shareUrl: j.composition.shareUrl,
    image: j.composition.baseImageUrl,
  };
};
