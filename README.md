# Ecom Capture

Enregistreur d'écran avec micro pour Windows 10 et 11. Les vidéos sont enregistrées pour être utilisées ensuite dans un logiciel de montage.

## Compiler sur GitHub

1. Créez un dépôt GitHub (vide), puis envoyez-y **tout le contenu de ce dossier** (le dossier `.github` compris, il contient le workflow de compilation).
2. Ouvrez l'onglet **Actions** du dépôt. La compilation démarre toute seule après l'envoi (ou cliquez sur **Build Windows**, puis **Run workflow**).
3. Quand la ligne devient verte (3 à 6 minutes), ouvrez-la et téléchargez l'artefact **Ecom-Capture-Setup** en bas de page.
4. Dézippez-le et lancez `Ecom-Capture-Setup-1.0.0.exe`.

Pour publier une version téléchargeable dans l'onglet *Releases*, créez un tag : `git tag v1.0.0 && git push origin v1.0.0`.

> Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » car l'installeur n'est pas signé. Cliquez sur **Informations complémentaires**, puis **Exécuter quand même**.

## Utilisation

1. Choisissez un **écran** ou une **fenêtre** dans la grille.
2. Réglez le micro (niveau visible en bas), le son de l'ordinateur, la caméra, les images par seconde et la qualité.
3. Cliquez sur **Enregistrer** ou appuyez sur **F9** (même si le logiciel est réduit).
4. Une petite barre flottante (chrono, pause, arrêt) apparaît en haut de l'écran. Elle n'est jamais visible dans la vidéo, comme la fenêtre du logiciel.
5. **F9** arrête, **F10** met en pause. Le MP4 est créé automatiquement dans `Vidéos\Ecom Capture`.

## Fonctions

- Capture d'un écran entier ou d'une fenêtre précise, avec le curseur
- Microphone au choix, volume réglable, réduction de bruit, suppression d'écho, gain automatique
- Son de l'ordinateur (musique, vidéos, notifications), mélangé au micro
- Micro enregistré aussi à part en MP3, pour retoucher la voix au montage
- Bulle caméra déplaçable (petite, moyenne ou grande, effet miroir)
- Compte à rebours (3, 5 ou 10 s), pause/reprise, arrêt automatique programmable
- Raccourcis globaux F9 et F10, icône dans la zone de notification
- 24, 30 ou 60 images par seconde, trois niveaux de qualité, sortie native, 1080p ou 720p
- MP4 à images constantes (idéal pour le montage), MP4 rapide sans réencodage, ou WebM brut
- Écriture progressive sur le disque : si le logiciel plante, le WebM déjà enregistré reste récupérable (onglet Enregistrements, bouton Convertir)
- Liste des enregistrements : lire, ouvrir le dossier, convertir, supprimer (corbeille)
- Interface en français ou en anglais, mode sombre ou clair

## Si le micro ne marche pas

Paramètres Windows > Confidentialité et sécurité > Microphone : activez « Autoriser les applications de bureau à accéder à votre microphone ».

## Tester en local (facultatif)

```
npm install
npm start
```
