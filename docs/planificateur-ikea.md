# Piloter le planificateur IKEA

Notes techniques sur le planificateur home-design d'ikea.com/fr, relevées en octobre 2026. Rien de ceci n'est documenté par IKEA : ce sont les appels que fait l'application web elle-même, qui peuvent changer à tout moment.

L'idée directrice : ne rien saisir à la souris. Les murs et les ouvertures passent par l'API interne du room-builder, les meubles, la sauvegarde et le partage par l'API REST du planificateur.

## La chaîne `ikea.js`

Une commande enchaîne tout, pour n'importe quelle pièce décrite dans une maquette :

1. **Références et teintes** (`lint-refs.js`, lancé en parallèle). Pour chaque référence : coloris réel, prix du jour, conditionnement (« vendu par 2 »), vente en ligne, présence dans le catalogue 3D. Les compléments indiqués sur les fiches IKEA (charnières, glissières, pieds, rails, transformateur et câble, piles) sont vérifiés, et une teinte cible (`PROJET.teinte` dans la maquette, ou `--teinte`) signale les variantes d'un autre coloris.
2. **Pièce.** `outils/pieces.json` garde la scène IKEA déjà construite pour chaque géométrie (empreinte de `H`, `P`, `DOOR`, `WIN`, `OPEN`). Une pièce nouvelle passe par `piece/build-room.js`, environ une minute.
3. **Meubles.** Un jeton invité, une copie de la scène, puis la pose par l'API REST. Chaque référence est associée à son modèle 3D ; un article absent du catalogue 3D prend l'équivalent le plus proche (même teinte d'abord), un objet déjà possédé un meuble IKEA de même taille, hors panier. Orientation : dos au mur le plus proche, sauf `face` imposée ; un meuble avec `y > 0` est posé sur celui du dessous ou fixé au mur.
4. **Vérification sans navigateur** (`lib/verif.js`, aussi disponible seul avec `verifier.js`). Le JSON public du design est relu et comparé à la maquette : sens de la pièce (pas de miroir), murs à 1 cm, hauteur sous plafond, ouvertures, puis chaque meuble à 2 cm (position, emprise, rotation), meubles manquants ou en trop, référence posée contre référence commandée. Le résultat est aussi dessiné en SVG, maquette en pointillés et écarts en rouge.
5. **Vérification du rendu** (mode normal). Le design s'ouvre dans Chromium, les boîtes réellement rendues par l'éditeur sont comparées à la maquette, et les modèles que l'éditeur fait pivoter sont corrigés sur le même lien. Les corrections apprises sont gardées dans `outils/modeles-3d.json`, ce qui permet ensuite le mode `--rapide` (sans navigateur, quelques secondes).
6. **Panier** (`liste-achat.js`) et rapport `resume.md`, avec le lien du design, le lien panier, le total, les substitutions 3D et les écarts.

Code de sortie : 0 si tout est conforme, 2 en cas d'écart ou d'erreur de références, 1 en cas d'erreur d'exécution. Sur le bureau, le mode normal prend une quarantaine de secondes.

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
- `lib/quality-low.js` coupe ombres et anticrénelage, et `lib/block-list.js` bloque les requêtes inutiles au planificateur (consentement, mesure d'audience, polices, médias) : l'éditeur passe d'environ 2 à 15 images par seconde.
- `lib/chrome.js` lance Chromium sur le premier port CDP libre (9240 à 9249) et l'arrête en fin de traitement. Un verrou n'en laisse tourner qu'un à la fois : à plusieurs en parallèle sur une petite machine, les captures de contrôle expirent.

## Panier ikea.fr

- `https://www.ikea.com/fr/fr/shoppingcart/?items=<référence à 8 chiffres>:<quantité>,…` : la page panier lit ce paramètre elle-même, sans compte. Testé avec 36 références et 75 articles, total identique au calcul.
- Le lien ajoute au panier existant ; `&replaceItems=true` le vide d'abord.
- Une seule référence mal formée (pas 8 chiffres, quantité hors de 1 à 999) et tout le lien est ignoré.
- `liste-achat.js` relit les prix sur ikea.fr et les garde en cache hors du dépôt (`IKEA_CACHE_DIR`, par défaut dans le dossier temporaire). `--offline` reprend les prix du dernier relevé, sans réseau.
