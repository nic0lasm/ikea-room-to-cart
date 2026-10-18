# Bureau

Premier projet mené avec l'outil, en octobre 2026 : transformer une petite chambre en bureau, avec un coin pour mon imprimante 3D et un canapé-lit pour les invités, uniquement avec des meubles IKEA.

|                                  |                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maquette                         | [maquette.html](maquette.html), à ouvrir dans un navigateur (versions « état actuel », A et Vdef)                                                                                  |
| Version retenue                  | Vdef, 1 302,91 € sur ikea.fr : [design dans le planificateur](https://www.ikea.com/fr/fr/home-design/share/8722c88a-1ef3-4fa6-820d-53302d600156/), [paniers et détail](paniers.md) |
| Pièce vide dans le planificateur | [design partagé](https://www.ikea.com/fr/fr/home-design/share/ccdada6e-6384-427f-a805-94f6fa957805/), vérifié à 1 cm                                                               |
| Données                          | [donnees/](donnees/), régénérées par `npm run extraire -- projets/bureau/maquette.html`                                                                                            |
| Sources                          | [plan dessiné](sources/plan-dessine.jpg), [photo d'inspiration](sources/inspiration.jpg)                                                                                           |
| Archives                         | [maquette v18](archives/maquette-v18.html) avec les versions B à G                                                                                                                 |

## La pièce

Cotes intérieures en cm, vue de dessus orientée comme le plan dessiné : porte en haut, porte-fenêtre en bas, renfoncement à droite.

- Plafond à 238.
- Mur de la porte : 329,5, soit 235 de mur, une porte d'environ 74,5 ouvrant vers l'intérieur, puis 20 jusqu'à l'angle.
- Côté droit : 343 au total, dont un renfoncement de 138 de large et de 56 à 67,5 de profondeur (le fond est légèrement en biais).
- Mur de la porte-fenêtre : 318, soit 69, une porte-fenêtre à deux vantaux de 164,5 encadrement compris, puis 84,5.
- Mur gauche : 340. La pièce n'est pas d'équerre, et la maquette comme le planificateur gardent cet écart de 3 cm.
- Une seule prise connue, à 20 cm à gauche de la porte.

Je conserve mon bureau 160 × 80, ma chaise et mon imprimante Bambu Lab P1S avec son AMS posé dessus : 68 cm de haut, environ 85 cm couvercle ouvert, et 15 cm d'air à laisser derrière.

## Contraintes

- Style : effet chêne, comme mon bureau ; un bas profond et fermé, à tiroirs, et des cases moins profondes au-dessus ; quincaillerie noire.
- Ni KALLAX, ni gamme cuisine (METOD, MAXIMERA, VOXTORP, KARLBY), ni sur-mesure : la gamme cuisine n'existe pas dans le planificateur classique, et le sur-mesure ne se commande pas en un clic.
- Canapé-lit de 138 cm hors tout au maximum pour entrer dans le renfoncement. Chez IKEA France, cela laisse HAMMARN (128 cm) et FRIDHULT (126 cm, couchage 119 × 202).
- Imprimante : une vraie niche aérée, avec un rangement propre pour les bobines.

## Les versions

Sept implantations ont été modélisées et envoyées dans le planificateur, toutes vérifiées à 2 cm :

| Version | Idée                                                                                        | Total ikea.fr |
| ------- | ------------------------------------------------------------------------------------------- | ------------- |
| A       | Bureau côté porte, meuble bas à tiroirs et bibliothèque entre le bureau et la porte-fenêtre | 1 098,92 €    |
| B       | Bureau côté porte-fenêtre, niche imprimante côté porte                                      | 1 144,92 €    |
| C       | A avec une niche imprimante sur le plateau, bibliothèque déplacée sur le mur de la porte    | 1 264,90 €    |
| D       | C avec l'imprimante au bout, côté porte-fenêtre, pour l'aération                            | 1 264,90 €    |
| E       | D sans la bibliothèque du mur de la porte, jugée trop chargée                               | 1 144,92 €    |
| F       | Bureau côté porte-fenêtre, bobines dans des EKET vitrés                                     | 1 209,89 €    |
| G       | E allégée, avec le canapé HAMMARN                                                           | 820,89 €      |

J'ai retenu A : la lumière vient de côté, sans reflet sur l'écran, et la bibliothèque posée sur le meuble bas fonctionne bien. Il lui manquait une place pour l'imprimante, et l'espace entre le bureau et la porte-fenêtre restait sous-exploité. Les liens des versions B à G sont conservés dans [donnees/liens-ikea.json](donnees/liens-ikea.json).

## Version finale (Vdef)

![Vdef dans le planificateur IKEA, vue de dessus](images/planificateur-V.png)

Vdef reprend A et ajoute une colonne PAX contre la porte-fenêtre :

- Bureau contre le mur gauche, côté porte, avec une lampe FORSÅ.
- Entre le bureau et la porte-fenêtre : deux BESTÅ 60 × 40 sur pieds STUBBARP, à la hauteur du bureau, avec quatre tiroirs, un plateau LAGKAPTEN et une bibliothèque BILLY 80 + 40 posée dessus.
- Au-dessus du bureau : quatre cubes EKET sur rail, à 1,50 m.
- Colonne PAX 50 × 58 × 201 : trois tiroirs pour les bobines de réserve, une tablette à la hauteur du plateau pour l'imprimante, une niche de 98 cm éclairée par une baguette LED, et un compartiment pour six bobines en haut.
- Dans le renfoncement : le FRIDHULT, un chevet et une colonne BESTÅ de 20 cm de profondeur, et deux BESTÅ muraux avec une LED de lecture.

Le catalogue 3D du planificateur ne propose pas de caisson PAX de 50 cm seul : la colonne y apparaît sous la forme d'une armoire PAX plus large, la seule pièce de cette version qui ne tombe pas à 2 cm. Le panier commande bien le caisson de 50 cm.

Total : 1 240,91 € dans la maquette et 1 302,91 € sur ikea.fr. L'écart vient de la quincaillerie et des câbles vendus à part, que seul le relevé des prix en ligne fait apparaître.

## Ce que j'en retiens

- Un plan dessiné à la main avec toutes les cotes vaut mieux que n'importe quel nombre de photos.
- Comparer sept implantations n'aurait pas été réaliste dans le planificateur à la souris ; dans la maquette, une version de plus coûte quelques minutes.
- Le panier généré a révélé des articles oubliés dans les premières listes (charnières, câbles d'alimentation, quincaillerie vendue par deux).
- Le planificateur affiche certains coloris en blanc : il sert à valider l'implantation et les volumes, pas le rendu des teintes.

La commande n'est pas encore passée. Prochaine étape : passer l'ensemble en chêne naturel, comme le bureau, plutôt qu'en chêne blanchi.
