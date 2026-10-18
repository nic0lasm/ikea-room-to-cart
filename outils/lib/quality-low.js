// Script injecté avant le chargement : passe le moteur de rendu du planificateur en profil économique (sans ombres, sans anticrénelage,
// sans relecture d'exposition), sur chaque objet rendererSettings que le moteur affecte (repéré par la clé ooNoAA).
(() => {
  const OVR = Object.assign(
    {
      ooNoAA: true,
      ooEnableFXAA: false,
      ooShowShadows: false,
      frontSideShadows: false,
      interItemShadows: false,
      usePCSSShadows: false,
      useFloorContactShadows: false,
      disableDollhouseShadows: true,
      artItemsCastAndReceiveShadows: false,
      autoExposure: false,
      enableGTAO: false,
      useDirectionalLightCookie: false,
      ooCollectFrameMetric: false,
      applyGpuTierLighting: false,
      animateViewChange: false,
    },
    window.__KREATIV_QUALITY_OVR || {},
  );
  const fix = (v) => {
    if (v && typeof v === "object" && "ooNoAA" in v) Object.assign(v, OVR);
    return v;
  };
  const KEY = Symbol("rs");
  Object.defineProperty(Object.prototype, "rendererSettings", {
    configurable: true,
    get() {
      return this[KEY];
    },
    set(v) {
      this[KEY] = fix(v);
    },
  });
})();
