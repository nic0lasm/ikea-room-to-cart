# Format de la maquette

Une maquette est un seul fichier HTML (three.js r128 depuis cdnjs, aucune dépendance locale) : la vue 3D, la liste d'achat et toutes les données du projet. Les scripts de `outils/` la lisent directement, c'est la seule source de vérité.

Pour un nouveau projet : copier `projets/bureau/maquette.html` dans `projets/<nouveau>/maquette.html`, puis remplacer les éléments ci-dessous. Il n'existe pas encore de maquette vierge : le moteur 3D est générique, mais quelques détails de décor du bureau sont codés en dur (voir la fin de cette page).

## Repère

Tout en cm. `x` depuis le mur gauche (0), `z` depuis le mur d'entrée (0) vers le mur opposé, `y` = hauteur de pose. Chaque position désigne le coin de l'emprise le plus proche de l'origine (centre = coin + taille/2).

## La pièce

Une ligne par constante : les scripts les lisent avec des expressions régulières.

```js
const H=238,T=8,W=329.5,D=343;           // plafond, épaisseur des murs dessinés, largeur et profondeur de référence
const P=[[0,3],[329.5,0],…,[0,D]];       // contour intérieur, sommets dans l'ordre (le dernier rejoint le premier)
const DOOR={x0:235,x1:309.5,h:204};      // porte d'entrée
const WIN={x0:69,x1:233.5,h:215};        // porte-fenêtre (encadrement compris)
const OPEN={0:[{a:…,b:…,h:…}],6:[{a:…,b:…,h:…,glass:true}]};  // ouvertures par segment de P (index du sommet de départ), a/b = distances le long du segment
const REC={z0:185,z1:323,xb1:385.5};     // renfoncement (dessin du sol et limites du glisser-déposer)
```

`build-room.js` construit la pièce du planificateur IKEA à partir de `H`, `P` et `OPEN` (une ouverture `glass` devient une porte-fenêtre à deux vantaux, les autres des portes simples), puis vérifie chaque mur à 1 cm. La pièce construite est mémorisée dans `outils/pieces.json`, sous une empreinte de `H`, `P`, `DOOR`, `WIN` et `OPEN` : changer l'une de ces constantes déclenche une nouvelle construction.

## Les articles : `const ITEMS=window.ITEMS=[ … ];`

Une entrée par article ou ensemble acheté ensemble :

| Champ                                                                                                    | Rôle                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `nm`, `ds`                                                                                         | identifiant, nom affiché, description                                                                                               |
| `price`, `q`                                                                                             | prix unitaire et quantité affichés (le total de la maquette = somme des cochés)                                                     |
| `st`                                                                                                     | `ok` prix vérifié, `est` estimé, `own` déjà possédé (hors panier, remplacé par un meuble IKEA de même taille dans le planificateur) |
| `w`, `d`, `h`                                                                                            | emprise : `w` le long de x, `d` le long de z, `h` hauteur                                                                           |
| `A`, `V`, `cur`…                                                                                         | position `{x,z,y?}` dans chaque version ; absente = l'article n'est pas dans cette version                                          |
| `refs`                                                                                                   | `[{itemNo:'102.473.79',q:2}, …]` : tous les composants IKEA ; `q` = nombre de paquets pour toute l'entrée                           |
| `on`, `def`, `grp`, `lock`                                                                               | coché par défaut, coché par version (`def:{G:false}`), groupe exclusif (un seul canapé à la fois), non décochable                   |
| `face`                                                                                                   | façade forcée (`+x`, `-x`, `+z`, `-z`) ; sinon le script met le dos au mur le plus proche                                           |
| `ty`                                                                                                     | hauteur de pose d'un plateau                                                                                                        |
| `kind`, `col`, et les champs de dessin (`legs`, `rows`, `cols`, `units`, `secs`, `led`, `bedW`, `bedL`…) | apparence dans la maquette uniquement                                                                                               |

Un article posé avec `y > 0` est posé sur le meuble en dessous s'il y en a un, sinon fixé au mur.

## Les versions

Les clés de version apparaissent à trois endroits de la maquette, à garder synchronisés : les boutons `<button id="l<clé>">`, la liste `['cur','A','V']` (deux fois) et le dictionnaire des titres `{cur:'…',A:'…',V:'…'}`. Dans `outils/extraire-donnees.js`, ajouter le libellé de toute nouvelle clé dans `LABELS`.

## Détails propres au bureau à remplacer pour une autre pièce

- Prises, interrupteurs, applique et plafonnier : tableau `[['p',DOOR.x0-20,25.5,1.6], …]`.
- Sens d'ouverture de la porte et des vantaux (`door.rotation`, `swing(…)`).
- Positions de caméra des vues « Depuis la porte » et « Mur de rangement ».
- Le texte « Cotes utilisées » du panneau de droite et les titres « Bureau · version … ».
