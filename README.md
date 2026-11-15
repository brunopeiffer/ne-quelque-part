# Né quelque part

Simulateur de vie : naissez quelque part dans le monde et vivez une vie entière, de la naissance à la mort, guidée par les statistiques réelles de 172 pays.

**Jouer en ligne : https://brunopeiffer.github.io/ne-quelque-part/**

## Le principe

- Le pays de naissance est tiré au sort selon le nombre de naissances dans le monde, ou choisi dans la liste.
- Chaque année de vie suit les chiffres du pays : mortalité, espérance de vie, scolarité, revenus, santé.
- Des décisions ponctuent la vie (études, argent, famille) et font bouger quatre jauges : santé, bonheur, savoir, relations.
- La vie se termine par un faire-part, et les vies passées sont rangées sur une étagère.

Tout se passe dans le navigateur : aucune donnée n'est envoyée à un serveur, et les vies sont enregistrées uniquement sur l'appareil.

## Lancer en local

Le jeu est en HTML, CSS et JavaScript, sans étape de build. Il suffit de servir ce dossier avec un serveur de fichiers statiques, par exemple :

    npx serve .

puis d'ouvrir l'adresse affichée. Ouvrir index.html directement depuis le disque ne fonctionne pas, car le jeu charge ses fichiers de données.

## Organisation des fichiers

| Fichier | Rôle |
|---|---|
| index.html | Structure des écrans (accueil, vie, faire-part, étagère) |
| app.js | Toute la logique du jeu |
| styles.css | Mise en forme |
| data/countries.json | Statistiques des 172 pays |
| data/i18n.json | Textes de l'interface, en neuf langues |
| sw.js | Fonctionnement hors ligne |

## État de la traduction

L'accueil, l'écran de vie, les fenêtres de décision, le faire-part et l'étagère sont en français. L'onglet Laboratoire et l'import/export de l'arbre généalogique ne sont pas encore traduits. Le journal des versions (CHANGELOG.md) et le dossier evidence/ sont les documents de l'auteur d'origine, en chinois.

## Sources des données

ONU (Perspectives de la population mondiale 2024), Banque mondiale, OMS, UNESCO, PNUD, OIT, ONUSIDA, ONUDC, UNICEF, Rapport mondial sur le bonheur 2024.

## Crédits et licence

Ce projet est dérivé de [born-somewhere](https://github.com/rollroyces/born-somewhere) de Royce (rollroyces), sous licence MIT : voir [LICENSE](LICENSE). Cette version ajoute une nouvelle page d'accueil, des corrections de jeu et la traduction française.

L'idée de vivre une vie tirée au sort selon des statistiques réelles vient du site 1in8b.life. Son code, ses textes et ses images sont protégés par le droit d'auteur et ne sont pas repris ici.
