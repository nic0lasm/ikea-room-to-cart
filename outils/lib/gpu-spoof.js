// Script injecté avant le chargement : un Chromium sans GPU (SwiftShader) se présente avec un GPU courant, sinon le planificateur
// affiche « appareil non supporté ». Retire aussi failIfMajorPerformanceCaveat, qui fait échouer la création du contexte WebGL.
(() => {
  const R = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    V = "Google Inc. (NVIDIA)";
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const g = C.prototype.getParameter;
    C.prototype.getParameter = function (p) {
      if (p === 0x9246) return R;
      if (p === 0x9245) return V;
      return g.call(this, p);
    };
  }
  const og = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, o) {
    if (o && o.failIfMajorPerformanceCaveat) {
      o = Object.assign({}, o, { failIfMajorPerformanceCaveat: false });
    }
    return og.call(this, t, o);
  };
})();
