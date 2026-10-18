// Chrome headless pour le planificateur : port CDP libre (9240-9249), profil dans le dossier temporaire, arrêt propre (kill du
// groupe de processus, jamais pkill), verrou pour n'avoir qu'un Chrome de ces outils à la fois sur la machine.
"use strict";
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  net = require("net"),
  { spawn } = require("child_process");

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const TMP = process.env.IKEA_TMP || path.join(os.tmpdir(), "ikea-planner");
function exe() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const f = require("../playwright.js").chromePath();
  if (fs.existsSync(f)) return f;
  throw new Error(
    "Chromium introuvable : « npx playwright install chromium », ou définir CHROME_PATH",
  );
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const cdpUp = async (url) => {
  try {
    return (await fetch(url + "/json/version", { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};
const portFree = (port) =>
  new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });

// ---------- verrou (fichier dans /tmp, pid + date ; un verrou dont le pid est mort est repris) ----------
function lockPath(name) {
  return path.join(os.tmpdir(), `ikea-planner-${name}.lock`);
}
async function lock(
  name,
  { waitMs = +(process.env.IKEA_LOCK_WAIT || 15 * 60000), log = console.log } = {},
) {
  const f = lockPath(name),
    t0 = Date.now();
  let said = false;
  for (;;) {
    try {
      const fd = fs.openSync(f, "wx");
      fs.writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          date: new Date().toISOString(),
          cmd: process.argv.slice(1).join(" "),
        }),
      );
      fs.closeSync(fd);
      const rel = () => {
        try {
          if (JSON.parse(fs.readFileSync(f, "utf8")).pid === process.pid) fs.unlinkSync(f);
        } catch (e) {}
      };
      process.once("exit", rel);
      return rel;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let o = null;
    try {
      o = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {}
    if (!o || !alive(o.pid)) {
      try {
        fs.unlinkSync(f);
      } catch (e) {}
      continue;
    } // verrou abandonné
    if (Date.now() - t0 > waitMs)
      throw new Error(
        `une autre instance utilise Chrome depuis ${o.date} (pid ${o.pid} : ${String(o.cmd).slice(0, 120)}) ; attendre sa fin, ou supprimer ${f} si ce processus n'existe plus`,
      );
    if (!said) {
      log(`attente : une autre instance utilise Chrome (pid ${o.pid}, depuis ${o.date})…`);
      said = true;
    }
    await sleep(2000);
  }
}

// ---------- lancement ----------
// port : numéro imposé (si un Chrome y répond déjà, il est réutilisé et ne sera pas arrêté) ; sinon premier port libre 9240-9249
async function launch({ port, log = console.log, lockWait } = {}) {
  if (port) {
    const url = `http://127.0.0.1:${port}`;
    if (await cdpUp(url)) {
      log(`Chrome déjà ouvert sur le port ${port} : réutilisé`);
      return { url, port, pid: null, owned: false, stop: async () => {} };
    }
  }
  const release = await lock("chrome", { log, waitMs: lockWait });
  let p = port;
  if (!p) {
    for (let q = 9240; q <= 9249 && !p; q++)
      if ((await portFree(q)) && !(await cdpUp(`http://127.0.0.1:${q}`))) p = q;
  }
  if (!p) {
    release();
    throw new Error("aucun port CDP libre entre 9240 et 9249");
  }
  const profile = path.join(TMP, `chrome-${p}`);
  fs.mkdirSync(profile, { recursive: true });
  // Chrome orphelin d'un lancement précédent tué brutalement (même profil) : arrêté
  const pidf = path.join(profile, "ikea-planner.pid");
  try {
    const old = +fs.readFileSync(pidf, "utf8");
    if (old && alive(old)) {
      try {
        process.kill(-old, "SIGKILL");
      } catch (e) {
        try {
          process.kill(old, "SIGKILL");
        } catch (e2) {}
      }
      await sleep(500);
    }
  } catch (e) {}
  for (const s of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
    try {
      fs.unlinkSync(path.join(profile, s));
    } catch (e) {}
  const args = [
    "--headless=new",
    "--no-sandbox",
    `--remote-debugging-port=${p}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`] : []),
    "--window-size=1440,900",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--lang=fr-FR",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--max-active-webgl-contexts=64",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-sync",
    "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "about:blank",
  ];
  const errf = path.join(profile, "chrome-stderr.log");
  const child = spawn(exe(), args, {
    detached: true,
    stdio: ["ignore", "ignore", fs.openSync(errf, "w")],
  });
  child.unref();
  fs.writeFileSync(pidf, String(child.pid));
  let stopped = false;
  const killSync = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {}
    try {
      fs.unlinkSync(pidf);
    } catch (e) {}
    release();
  };
  process.once("exit", killSync);
  const stop = async () => {
    if (stopped) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (e) {}
    for (let i = 0; i < 15 && alive(child.pid); i++) await sleep(100);
    killSync();
  };
  const url = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 150 && !(await cdpUp(url)); i++) {
    if (child.exitCode != null) break;
    await sleep(200);
  }
  if (!(await cdpUp(url))) {
    await stop();
    let e = "";
    try {
      e = fs.readFileSync(errf, "utf8").slice(-400);
    } catch (x) {}
    throw new Error(`Chrome n'a pas démarré sur le port ${p} en 30 s${e ? " : " + e : ""}`);
  }
  return { url, port: p, pid: child.pid, owned: true, profile, stop };
}
// arrêt propre sur Ctrl+C / kill : Chrome est arrêté par le gestionnaire 'exit'
let sigInstalled = false;
function installSignals() {
  if (sigInstalled) return;
  sigInstalled = true;
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(s, () => {
      console.error(`\ninterrompu (${s}) : arrêt de Chrome`);
      process.exit(130);
    });
}

module.exports = { launch, lock, installSignals, cdpUp, TMP };
