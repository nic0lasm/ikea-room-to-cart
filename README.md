# ikea-room-to-cart

Modéliser une pièce en 3D à l'échelle, la retrouver dans le planificateur IKEA, puis commander en un clic.

![Maquette 3D du bureau, version finale](docs/images/maquette-3d.png)

J'ai écrit ces outils pour aménager mon bureau avec des meubles IKEA. Le planificateur en ligne d'IKEA montre bien le résultat, mais tout s'y saisit à la souris : les murs, les ouvertures, chaque meuble, et tout est à refaire dès qu'on compare deux idées. J'ai donc inversé la démarche. Je travaille dans une maquette 3D légère où chaque meuble porte ses références IKEA, et des scripts reconstruisent ensuite la pièce et les meubles dans le planificateur, vérifient le résultat, puis préparent le panier.

## Le parcours

1. **Modéliser.** La pièce et les meubles tiennent dans un seul fichier HTML (three.js) : vue 3D et vue de dessus, glisser-déposer des meubles au sol, liste d'achat et total qui suivent la sélection.
2. **Ajuster.** Plusieurs versions cohabitent dans la même maquette. Chacune garde ses positions, ses meubles cochés et son total, ce qui permet de comparer deux implantations en un clic.
3. **Visualiser dans le planificateur IKEA.** Un script construit la pièce exacte dans le planificateur, y pose chaque meuble par sa référence, compare les boîtes réellement rendues à la maquette (tolérance 2 cm) et partage le design.
4. **Commander.** Un lien remplit le panier ikea.fr avec les bonnes références et quantités, prix du jour relus. La commande se valide ensuite sur ikea.fr, comme d'habitude.

Le détail de chaque étape et les pièges rencontrés sont dans [docs/parcours.md](docs/parcours.md).

![Vue de dessus de la maquette et du planificateur IKEA pour la même version](docs/images/maquette-vs-planificateur.png)

## Exemple : mon bureau

[projets/bureau](projets/bureau/) contient le premier projet mené de bout en bout : une pièce de 3,30 × 3,40 m qui n'est pas d'équerre, avec un renfoncement, une porte-fenêtre, un canapé-lit et une imprimante 3D à loger. Sept implantations ont été comparées avant d'en retenir une, et la version finale représente 27 références et 1 302,91 € sur ikea.fr.

## Utilisation

Il faut Node.js 24 (voir `.nvmrc`) et, pour le planificateur, Chromium via Playwright.

```bash
npm install
npx playwright install chromium   # uniquement pour le planificateur

# Données JSON du projet (pièce, articles, versions), sans réseau
npm run extraire -- projets/bureau/maquette.html

# Liste d'achat et lien panier d'une version, prix relus sur ikea.fr
npm run panier -- projets/bureau/maquette.html V --html out/V.html

# Pièce et meubles dans le planificateur, vérification, captures et panier
npm run planificateur -- projets/bureau/maquette.html V out/V
```

Une version prend environ trois minutes dans le planificateur. Les sorties (rapport, vue de dessus, plan 2D attendu et obtenu, liste d'achat) sont écrites dans le dossier indiqué.

Pour un nouveau projet, copier une maquette existante et remplacer la pièce et la liste des meubles : le format est décrit dans [docs/format-maquette.md](docs/format-maquette.md).

## Organisation

```
docs/        parcours, format de la maquette, fonctionnement du planificateur IKEA
outils/      scripts Node
  extraire-donnees.js   maquette → données JSON
  fiche-saisie.js       cotes d'une version (coins des meubles, distances aux murs)
  liste-achat.js        liste d'achat et lien panier ikea.fr
  maquette-vers-ikea.js chaîne complète vers le planificateur
  piece/                construction de la pièce dans le room-builder IKEA
  lib/                  API du planificateur, catalogue, géométrie, scripts injectés
projets/     un dossier par pièce aménagée
test/        tests (node:test)
```

## Comment ça marche

Le planificateur IKEA n'a pas d'API publique. Les scripts utilisent celles de l'application web elle-même : un jeton invité, comme un visiteur sans compte, pour créer les designs et y poser les meubles, et l'interface du room-builder, pilotée dans un Chromium headless, pour tracer les murs au centimètre. Aucun compte IKEA n'est utilisé et rien n'est commandé automatiquement. Les notes techniques sont dans [docs/planificateur-ikea.md](docs/planificateur-ikea.md).

Ces interfaces ne sont pas documentées et peuvent changer sans préavis : les scripts ont été écrits et vérifiés sur ikea.com/fr en octobre 2026.

## Licence

Code sous licence [MIT](LICENSE). Les photos, plans et images du dossier `projets/` ne sont pas couverts par cette licence.

Projet personnel, sans lien avec IKEA. IKEA et les noms de produits cités sont des marques d'Inter IKEA Systems B.V.
