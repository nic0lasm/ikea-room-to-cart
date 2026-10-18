# Outils

| Script                  | Rôle                                                                                       | Besoins                      |
| ----------------------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| `ikea.js`               | Chaîne complète : références, pièce et meubles dans le planificateur, vérification, panier | Accès à ikea.com, Playwright |
| `lint-refs.js`          | Contrôle des références d'une version : teintes, prix, conditionnement, compléments        | Accès à ikea.com             |
| `verifier.js`           | Compare un design partagé du planificateur à une version de la maquette, sans navigateur   | Accès à ikea.com             |
| `liste-achat.js`        | Liste d'achat et lien panier ikea.fr d'une version, prix relus en ligne                    | Accès à ikea.com             |
| `maquette-vers-ikea.js` | Design seul (utilisé par `ikea.js`)                                                        | Accès à ikea.com, Playwright |
| `piece/build-room.js`   | Construit la pièce dans le room-builder et la vérifie à 1 cm                               | Accès à ikea.com, Playwright |
| `extraire-donnees.js`   | Régénère `projets/<projet>/donnees/*.json` à partir de la maquette                         | Node                         |
| `fiche-saisie.js`       | Cotes d'une version : coins des meubles, distances aux murs, hauteur de pose               | Node                         |

Chaque script affiche son mode d'emploi sans argument (ou avec `--help`). Fonctionnement détaillé : [docs/planificateur-ikea.md](../docs/planificateur-ikea.md).

## Options de `ikea.js`

| Option                   | Effet                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `--sortie <dossier>`     | Dossier des résultats (par défaut, un sous-dossier daté du dossier temporaire)           |
| `--rapide`               | Sans navigateur : pose et vérification sur le JSON du design, pour les modèles déjà vus  |
| `--teinte <teinte>`      | Teinte attendue pour le contrôle des références (sinon `PROJET.teinte` dans la maquette) |
| `--rebuild-piece`        | Reconstruit la pièce dans le room-builder même si elle est en cache                      |
| `--emprise-modele-avert` | Un modèle IKEA plus grand ou plus petit que la maquette devient un avertissement         |
| `--nom <nom>`            | Nom des designs IKEA (par défaut, le titre de la maquette)                               |

## Variables d'environnement

| Variable            | Effet                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `CHROME_PATH`       | Chromium à utiliser à la place de celui fourni par Playwright                            |
| `PLAYWRIGHT_PATH`   | Playwright installé ailleurs que dans `node_modules`                                     |
| `HTTPS_PROXY`       | Proxy transmis à Chromium ; Node le suit aussi (`NODE_USE_ENV_PROXY=1`, activé d'office) |
| `IKEA_TMP`          | Dossier des profils Chromium et des sorties par défaut                                   |
| `IKEA_CACHE_DIR`    | Dossier des caches de prix, de références et de catalogue                                |
| `IKEA_MARKET`       | Marché IKEA (`fr/fr` par défaut)                                                         |
| `IKEA_HTTP_TIMEOUT` | Délai maximal d'une requête, en millisecondes (30 000 par défaut)                        |

## Fichiers versionnés

`pieces.json` garde la scène IKEA de chaque pièce déjà construite. `modeles-3d.json` garde les corrections d'orientation apprises sur les modèles que l'éditeur fait pivoter. Les caches, profils Chromium et sorties restent hors du dépôt.

## Pièges connus

- Un lien panier sans `&replaceItems=true` ajoute au panier : deux clics doublent les quantités.
- Le catalogue 3D n'a pas tous les articles ni tous les coloris : le script pose l'équivalent le plus proche, le signale, et le panier garde la vraie référence.
- Pour arrêter un Chromium resté ouvert, viser le processus (`kill <pid>`) plutôt que `pkill -f chrome`, qui peut tuer le terminal qui l'a lancé.
