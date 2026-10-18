# Piloter le planificateur IKEA

Notes techniques sur le planificateur home-design d'ikea.com/fr, relevées en octobre 2026. Rien de ceci n'est documenté par IKEA : ce sont les appels que fait l'application web elle-même, qui peuvent changer à tout moment.

L'idée directrice : ne rien saisir à la souris. Les murs et les ouvertures passent par l'API interne du room-builder, les meubles, la sauvegarde et le partage par l'API REST du planificateur.

## Vue d'ensemble de `maquette-vers-ikea.js`

1. Lit la pièce et les meubles de la version dans la maquette.
2. Cherche dans `outils/pieces.json` une pièce déjà construite pour cette géométrie (empreinte de `H`, `P`, `DOOR`, `WIN`, `OPEN`). Sinon, lance `piece/build-room.js` (environ une minute).
3. Obtient un jeton invité et copie la scène de la pièce pour cet invité.
4. Associe chaque référence à un meuble du catalogue 3D. Pour un article absent du catalogue 3D, cherche l'équivalent le plus proche (même nom, coloris, dimensions) ; un objet déjà possédé est remplacé par un meuble IKEA de même taille, hors panier.
5. Calcule la position et l'orientation de chaque meuble (dos au mur le plus proche, sauf `face` imposée ; posé sur le meuble du dessous ou fixé au mur quand `y > 0`), crée le design et le partage.
6. Ouvre le design dans Chromium, relit les boîtes englobantes réellement rendues et les compare à la maquette. Un écart au-delà de 2 cm déclenche une seconde passe (l'éditeur fait parfois pivoter un objet posé sur un autre).
7. Capture la vue de dessus et un plan 2D attendu / obtenu, puis produit le panier avec `liste-achat.js`, toujours avec les références d'origine.

Sorties : `rapport.txt`, `rapport.json`, `vue-dessus.png`, `plan-2d.png`, `panier.html`, `panier.json`.

## API REST « sugarcube »

Un design complet (n meubles, sauvegarde et partage) tient en cinq requêtes et moins de deux secondes.

- Base : `https://api.home-design.ikea.com/fr/fr/ideas/sugarcube/api`, avec `geometry_type=3d,2d_wall,wall_placeable`.
- Jeton invité : `POST https://api.ingka.ikea.com/guest/token`, en-têtes `x-client-id` (identifiant public du site ikea.com, embarqué dans ses pages) et `accept: application/json;version=2`, corps `{"retailUnit":"fr"}`. Le jeton est valable 720 heures ; dans le navigateur, c'est le cookie `guest`.
- Référence vers meuble 3D : `GET /furniture/?local_item_number=70351725,…`. Une liste vide signifie que l'article n'existe pas dans le catalogue 3D. Recherche texte : `GET /furniture/search/?q=…&region=fr/fr`.
- Création : `POST /compositions/` avec `placedFurniture[]` : `furnitureId`, position en mètres, quaternion (`headingI`, `headingJ`, `headingK`, `heading`), `parentId: "SURFACE"` et le numéro de la surface du sol.
- Partage : `POST /compositions/<uuid>/shared/` avec `isShared` et `enableRemix` → `shareUrl`.
- Lecture d'un design partagé, sans authentification : `GET /compositions/<uuid>/compiled/`.
- Un invité ne compose que sur sa propre scène (sinon 403), d'où la copie de la pièce à chaque lancement.

Repère : position au centre de l'emprise, z = 0 au sol. L'orientation de référence q0 = (0,5 ; 0,5 ; 0,5 ; 0,5) place la façade vers +x ; une rotation d'angle a autour de la verticale donne q = (0, 0, sin a/2, cos a/2) ⊗ q0.

## Room-builder : construire la pièce au centimètre

L'interface ne propose aucun champ numérique pour la longueur des murs, et la souris impose l'équerre. `piece/build-room.js` passe par l'objet interne du room-builder, retrouvé dans l'arbre React (`piece/pl.js`).

- Partir du rectangle par défaut, le découper avec `splitWall` jusqu'à obtenir le bon nombre de sommets, puis déplacer chaque sommet avec `dragVertexToPoint` entre `beginInteraction` et `endInteraction`. Une correction fine sans aimantation passe par `getWallsGraph().moveVertex`.
- Hauteur sous plafond : `setCeilingHeight`. Sans ce réglage, le room-builder garde 243,84 cm.
- Ouvertures : supprimer la fenêtre par défaut, ajouter une porte ou une porte-fenêtre depuis le catalogue, puis `setWallElementSize` et `dragWallElementTo`, en deux passes car une ouverture peut en pousser une autre.
- Vérification : la scène est relue depuis son JSON public et chaque mur comparé à la maquette (tolérance 1 cm). Code de sortie 0 si tout est conforme, 2 sinon.
- Limites : le sens d'ouverture et le côté des charnières ne se règlent pas ; l'épaisseur des murs est imposée (les cotes intérieures restent exactes).

Erreurs commises lors des premiers essais à la souris : pièce saisie en miroir (renfoncement du mauvais côté), mur gauche redressé à l'équerre (343 cm au lieu de 340), plafond resté à 243,84 cm. Le script évite les trois.

## Chromium headless

- Sans GPU, Chromium rend en SwiftShader et le planificateur affiche « appareil non supporté ». `lib/gpu-spoof.js`, injecté avant le chargement, présente un GPU courant et retire `failIfMajorPerformanceCaveat`.
- `lib/hooks.js` expose le visualiseur et la scène three.js, ce qui permet de relire les boîtes englobantes (`lib/bbox-page.js`).
- Un seul Chromium à la fois sur une petite machine : à plusieurs en parallèle, les captures de contrôle expirent.

## Panier ikea.fr

- `https://www.ikea.com/fr/fr/shoppingcart/?items=<référence à 8 chiffres>:<quantité>,…` : la page panier lit ce paramètre elle-même, sans compte. Testé avec 36 références et 75 articles, total identique au calcul.
- Le lien ajoute au panier existant ; `&replaceItems=true` le vide d'abord.
- Une seule référence mal formée (pas 8 chiffres, quantité hors de 1 à 999) et tout le lien est ignoré.
- `liste-achat.js` relit les prix sur ikea.fr et les met en cache (`outils/cache-prix.json`, non versionné). `--offline` reprend les prix du dernier relevé en cache, sans réseau.
