// Charge Playwright : dépendance du dépôt (npm install), sinon $PLAYWRIGHT_PATH, sinon installation globale (npm root -g).
// Chromium : $CHROME_PATH s'il est défini, sinon celui fourni par Playwright.
"use strict";
const path = require("path");
function load() {
  const tries = [() => require("playwright")];
  if (process.env.PLAYWRIGHT_PATH) tries.unshift(() => require(process.env.PLAYWRIGHT_PATH));
  tries.push(() =>
    require(
      path.join(require("child_process").execSync("npm root -g").toString().trim(), "playwright"),
    ),
  );
  for (const t of tries) {
    try {
      return t();
    } catch (e) {
      /* essai suivant */
    }
  }
  throw new Error(
    "Playwright introuvable : lancer « npm install » à la racine du dépôt, ou définir PLAYWRIGHT_PATH",
  );
}
const pw = load();
pw.chromePath = () => process.env.CHROME_PATH || pw.chromium.executablePath();
module.exports = pw;
// En ligne de commande : affiche le chemin de Chromium (utilisé par start-chrome.sh)
if (require.main === module) console.log(pw.chromePath());
