// Place une ouverture existante : id, mur, centre le long du mur (m, depuis vertex1 du mur), taille (m)
exports.placeEl = ([id, wallId, along, w, h]) => {
  const pl = window.__pl,
    room = pl.planner.getCurrentRoom(),
    g = room.getWallsGraph();
  pl.setWallElementSize(id, { width: w, height: h });
  const pos = g.getWallElementPosition(id).clone();
  pos.x = along;
  pos.y = h / 2;
  const r = room.dragWallElementTo(id, wallId, pos);
  pl.onWallGraphUpdated();
  pl.onHistoryUpdated();
  const e = pl.getWallElementInfo(id);
  const wi = pl.getWallInfo(e.wallId);
  const c = e.centerWorldPos,
    v1 = wi.vertex1Pos;
  const d = Math.hypot(c.x - v1.x, c.z - v1.z);
  return {
    r,
    wall: e.wallId,
    size: e.currentSize,
    alongFromV1: d,
    center: c,
    pos2: g.getWallElementPosition(id),
  };
};
