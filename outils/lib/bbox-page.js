// À évaluer dans la page de l'éditeur : boîtes englobantes monde (m, repère glTF) des meubles rendus, par uniqueId.
module.exports = () => {
  const ts = window.__kViewer && window.__kViewer.scene && window.__kViewer.scene.threeScene;
  if (!ts) return null;
  const out = {};
  for (const g of ts.children) {
    const m = /^renderObject-(\d+)$/.exec(g.name || "");
    if (!m) continue;
    g.updateMatrixWorld(true);
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let placeholder = !!(g.userData && g.userData.isPlaceholder),
      n = 0;
    g.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      for (let k = o; k && k !== g; k = k.parent) if (!k.visible) return;
      if (o.userData && (o.userData.isColorIdMesh || o.userData.isPlaceholder)) return;
      if (/shadow|dimnes|dimens|marker/i.test(o.name || "") || o.type !== "Mesh") return;
      if (o.material && o.material.visible === false) return;
      const geo = o.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb || !isFinite(bb.min.x)) return;
      if (
        Math.abs(bb.max.x - bb.min.x - 1) < 1e-3 &&
        Math.abs(bb.max.y - bb.min.y - 1) < 1e-3 &&
        bb.max.z - bb.min.z < 1e-6
      )
        return; // plans d'aide 1×1
      const e = o.matrixWorld.elements;
      n++;
      for (const x of [bb.min.x, bb.max.x])
        for (const y of [bb.min.y, bb.max.y])
          for (const z of [bb.min.z, bb.max.z]) {
            const X = e[0] * x + e[4] * y + e[8] * z + e[12],
              Y = e[1] * x + e[5] * y + e[9] * z + e[13],
              Z = e[2] * x + e[6] * y + e[10] * z + e[14];
            b[0] = Math.min(b[0], X);
            b[1] = Math.min(b[1], Y);
            b[2] = Math.min(b[2], Z);
            b[3] = Math.max(b[3], X);
            b[4] = Math.max(b[4], Y);
            b[5] = Math.max(b[5], Z);
          }
    });
    const q = g.quaternion;
    out[m[1]] = {
      placeholder,
      meshes: n,
      box: n ? b : null,
      pos: [g.position.x, g.position.y, g.position.z],
      q: [q.x, q.y, q.z, q.w],
    };
  }
  return out;
};
