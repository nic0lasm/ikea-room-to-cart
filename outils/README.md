# Outils

| Script                  | Rôle                                                                         | Besoins                      |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| `extraire-donnees.js`   | Régénère `projets/<projet>/donnees/*.json` à partir de la maquette           | Node                         |
| `fiche-saisie.js`       | Cotes d'une version : coins des meubles, distances aux murs, hauteur de pose | Node                         |
| `liste-achat.js`        | Liste d'achat et lien panier ikea.fr d'une version, prix relus en ligne      | Accès à ikea.com             |
| `maquette-vers-ikea.js` | Pièce et meubles dans le planificateur, vérification, captures, panier       | Accès à ikea.com, Playwright |
| `piece/build-room.js`   | Construit seule la pièce dans le room-builder et la vérifie à 1 cm           | Accès à ikea.com, Playwright |

Fonctionnement détaillé : [docs/planificateur-ikea.md](../docs/planificateur-ikea.md).

## Variables d'environnement

| Variable          | Effet                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `CHROME_PATH`     | Chromium à utiliser à la place de celui fourni par Playwright                            |
| `PLAYWRIGHT_PATH` | Playwright installé ailleurs que dans `node_modules`                                     |
| `HTTPS_PROXY`     | Proxy transmis à Chromium ; Node le suit aussi (`NODE_USE_ENV_PROXY=1`, activé d'office) |
| `PROJET`          | Nom donné aux designs IKEA (par défaut, le nom du dossier du projet)                     |
| `CDP`             | Adresse d'un Chromium déjà lancé (`http://127.0.0.1:9240`), à réutiliser                 |

`maquette-vers-ikea.js` accepte aussi `--port <n>` (Chromium dédié, utile pour lancer deux versions en parallèle), `--rebuild` (reconstruire la pièce), `--scene <uuid>` (partir d'une autre scène) et `--no-panier`.

## Fichiers locaux

`pieces.json` garde la scène IKEA de chaque pièce déjà construite, pour ne pas la refaire à chaque version. Les caches de prix et de catalogue (`cache-*.json`), les profils Chromium (`profiles/`) et les sorties (`out/`) ne sont pas versionnés.

## Pièges connus

- Un lien panier sans `&replaceItems=true` ajoute au panier : deux clics doublent les quantités.
- Le planificateur n'a pas tous les coloris en 3D : les BESTÅ effet chêne blanchi s'affichent en blanc, le panier commande bien la bonne teinte.
- Quand un article n'existe pas dans le catalogue 3D, le script pose l'équivalent le plus proche et le signale dans le rapport. S'il n'y en a aucun de la bonne taille (un caisson PAX de 50 cm seul, par exemple), l'écart apparaît dans la vérification.
- Pour arrêter un Chromium resté ouvert, viser le processus (`kill $(pgrep -x chrome)`) plutôt que `pkill -f chrome`, qui peut tuer le terminal qui l'a lancé.
