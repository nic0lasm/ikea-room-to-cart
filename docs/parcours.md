# Le parcours, de la pièce vide à la commande

La méthode a été rodée sur [mon bureau](../projets/bureau/) en octobre 2026. Chaque étape indique l'outil utilisé et les erreurs que je ne referais pas.

## 1. Relever la pièce

- Partir d'un plan dessiné à la main avec toutes les cotes, complété par quelques photos. Des photos seules ne suffisent pas : sur le bureau, il a fallu trois essais avant d'obtenir le bon contour.
- Lever les doutes avant de modéliser : somme des murs qui ne boucle pas, angle hors d'équerre, largeur et sens d'ouverture des portes, encadrement des fenêtres, prises, hauteur sous plafond.
- Garder les cotes réelles même si la pièce n'est pas d'équerre (bureau : 340 cm à gauche, 343 cm à droite).
- Noter les meubles et appareils conservés avec leurs dimensions exactes.

## 2. Modéliser dans la maquette

- Copier une maquette existante, puis remplacer le bloc de la pièce et le tableau `ITEMS` ([format](format-maquette.md)).
- Contrôler le rendu en vue 3D et en vue de dessus, orientée comme le plan dessiné.
- Relever les prix sur les fiches produit ikea.fr et les marquer comme vérifiés ou estimés : le total affiché doit rester fiable.

## 3. Ajuster et affiner

- Une version est une clé de position (`A`, `B`, …) dans chaque entrée de `ITEMS`. Elle garde sa propre sélection et son propre total.
- Quand une version est retenue, archiver les autres plutôt que les supprimer (`projets/<projet>/archives/`).
- Rester dans ce que le planificateur IKEA sait afficher. La gamme cuisine (METOD, MAXIMERA, VOXTORP, KARLBY) et le sur-mesure n'y figurent pas : sans eux, pas de design partageable ni de panier en un clic.
- Chaque article acheté porte `refs:[{itemNo, q}]` avec tous ses composants : structure, façades, pieds, boutons, charnières, câbles. `q` est un nombre de paquets pour toute l'entrée ; la quincaillerie est souvent vendue par deux, et les charnières BESTÅ comme les câbles d'alimentation sont vendus à part.

## 4. Visualiser dans le planificateur IKEA

```bash
npm run planificateur -- projets/<projet>/maquette.html <version> out/<version>
```

- Le script copie la pièce déjà construite (ou la construit, environ une minute), pose les meubles par référence, compare chaque boîte rendue à la maquette (tolérance 2 cm), capture la vue de dessus et le plan 2D, puis partage le design.
- Relire les captures : sens de la pièce (pas en miroir), hauteur sous plafond, position des ouvertures.
- Limites du planificateur : certains coloris n'existent pas en 3D et s'affichent en blanc, les objets personnels sont remplacés par un meuble IKEA de même taille, le sens d'ouverture des portes n'est pas réglable.

## 5. Commander

```bash
npm run panier -- projets/<projet>/maquette.html <version> --html out/<version>.html
```

- Le lien produit a la forme `https://www.ikea.com/fr/fr/shoppingcart/?items=<référence à 8 chiffres>:<quantité>,…&replaceItems=true`.
- `replaceItems=true` vide d'abord le panier ; sans lui, chaque ouverture du lien ajoute les articles une fois de plus. Une seule référence mal formée invalide tout le lien.
- Le panier se vérifie et se valide sur ikea.fr. Aucun script ne se connecte à un compte ni ne passe commande.

## 6. Garder une trace

Pour chaque version retenue : lien du planificateur, lien panier, total ikea.fr et vue de dessus, dans `projets/<projet>/paniers.md`, `donnees/liens-ikea.json` et `images/`. Les choix et leurs raisons vont dans le README du projet.
