// Script injecté avant le chargement : expose le visualiseur du planificateur (window.__kViewer) et son moteur three.js, et compte les appels de dessin WebGL par image.
(() => {
  const grab = (prop, globalName, after) => {
    Object.defineProperty(Object.prototype, prop, {
      configurable: true,
      set(v) {
        Object.defineProperty(this, prop, {
          value: v,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        if (!window[globalName]) window[globalName] = this;
        if (after)
          try {
            after(this, v);
          } catch (e) {}
      },
      get() {
        return undefined;
      },
    });
  };
  grab("aaType", "__kViewer");
  grab("wallspiceContextInfo", "__kRenderer");
  const st = (window.__kStats = {
    draws: 0,
    frames: 0,
    drawFrames: 0,
    lastDrawT: 0,
    firstDrawT: 0,
    frameLog: [],
  });
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const fn of [
      "drawElements",
      "drawArrays",
      "drawElementsInstanced",
      "drawArraysInstanced",
      "drawRangeElements",
    ]) {
      const o = C.prototype[fn];
      if (!o) continue;
      C.prototype[fn] = function () {
        st.draws++;
        return o.apply(this, arguments);
      };
    }
  }
  let lastDraws = 0;
  const tick = (t) => {
    st.frames++;
    if (st.draws !== lastDraws) {
      st.drawFrames++;
      lastDraws = st.draws;
      st.lastDrawT = performance.now();
      if (!st.firstDrawT) st.firstDrawT = st.lastDrawT;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
