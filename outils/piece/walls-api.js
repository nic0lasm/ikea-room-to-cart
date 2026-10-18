// À évaluer dans la page (étape 2 du room-builder, rectangle par défaut). P : polygone intérieur en m, repère monde (x, z).
exports.buildWalls = ([P, H]) => {
  const pl = window.__pl,
    room = pl.planner.getCurrentRoom(),
    g = room.getWallsGraph();
  const log = [];
  const V = () => pl.getAllVerticesInfo();
  // boucle ordonnée de sommets en partant du sommet de départ du mur 0, dans le sens du mur 0
  const loop = () => {
    const w0 = pl.getWallInfo("0");
    const out = [w0.vertex1Id, w0.vertex2Id];
    const vi = (id) => V().find((v) => v.id === id);
    while (out.length < 50) {
      const cur = vi(out[out.length - 1]);
      const nx = cur.neighborVertexIds.find((id) => id !== out[out.length - 2]);
      if (nx === out[0]) break;
      out.push(nx);
    }
    return out;
  };
  {
    const c = g.getVertexPosition(pl.getAllVerticesInfo()[0].id),
      k = pl.getAllVerticesInfo()[0].floorPosition;
    window.__sgn = Math.abs(c.y - k.z) < 1e-6 ? 1 : -1;
    log.push("2D " + JSON.stringify(c) + " monde " + JSON.stringify(k));
  }
  let L = loop();
  if (L.length !== 4) throw new Error("pas un rectangle: " + L.length);
  // le 3e côté (de L[1] vers L[2]) reçoit les sommets supplémentaires
  const wallBetween = (a, b) =>
    pl
      .getAllWallsInfo()
      .find(
        (w) => (w.vertex1Id === a && w.vertex2Id === b) || (w.vertex1Id === b && w.vertex2Id === a),
      );
  const extra = P.length - 4;
  for (let k = 0; k < extra; k++) {
    L = loop();
    const a = L[1 + k],
      b = L[2 + k];
    const w = wallBetween(a, b);
    const r = pl.splitWall(w.id, 0.5);
    log.push("split " + w.id + " " + JSON.stringify(r));
  }
  L = loop();
  if (L.length !== P.length) throw new Error("sommets: " + L.length);
  const target = (i) => P[i];
  for (let pass = 0; pass < 6; pass++) {
    let worst = 0;
    // ordre : du plus éloigné de sa cible au plus proche
    const order = L.map((id, i) => i).sort((i, j) => {
      const d = (k) => {
        const v = pl.getVertexInfo(L[k]).floorPosition;
        return Math.hypot(v.x - target(k)[0], v.z - target(k)[1]);
      };
      return d(j) - d(i);
    });
    for (const i of order) {
      const v = pl.getVertexInfo(L[i]).floorPosition;
      const pt = v.clone ? v.clone() : { ...v };
      pt.x = target(i)[0];
      pt.z = target(i)[1];
      const it = room.beginInteraction("api");
      let r;
      if (pass < 3) r = room.dragVertexToPoint(L[i], pt);
      else {
        const c = g.getVertexPosition(L[i]);
        const d = c.clone();
        const k = pl.getVertexInfo(L[i]).floorPosition;
        // correction fine sans aimantation : delta dans le plan du sol (axe y 2D = ±z monde, signe déduit)
        const sgn = window.__sgn;
        d.x = target(i)[0] - k.x;
        d.y = sgn * (target(i)[1] - k.z);
        r = g.moveVertex(L[i], d);
      }
      room.endInteraction(it);
      if (!r.success) log.push("échec v" + L[i] + " pass " + pass + " " + JSON.stringify(r));
    }
    for (let i = 0; i < L.length; i++) {
      const v = pl.getVertexInfo(L[i]).floorPosition;
      worst = Math.max(worst, Math.hypot(v.x - target(i)[0], v.z - target(i)[1]));
    }
    log.push("pass " + pass + " écart max " + (worst * 100).toFixed(3) + " cm");
    if (worst < 1e-4) break;
  }
  room.onRoomGeometryChanged && room.onRoomGeometryChanged();
  pl.setCeilingHeight(H);
  pl.onWallGraphUpdated();
  pl.onHistoryUpdated();
  return { log, loop: L };
};
