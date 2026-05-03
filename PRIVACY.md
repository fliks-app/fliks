# Règles de confidentialité

_Dernière mise à jour : 3 mai 2026_

Fliks est un serveur multimédia auto-hébergé open source. Le présent
document décrit quelles données sont collectées, par qui, et comment
elles sont utilisées dans le cadre de l'utilisation de l'application
Fliks (web, Android, iOS, Android TV) et du receiver Chromecast Fliks.

## En résumé

- **Fliks (l'éditeur du logiciel) ne dispose d'aucun serveur central**
  qui reçoit vos données. Chaque utilisateur héberge sa propre
  instance Fliks sur son propre matériel.
- L'application mobile / web se connecte **uniquement à votre serveur
  Fliks**. Elle ne communique avec aucun tiers à des fins d'analyse,
  de tracking publicitaire ou de profilage.
- Les seules données traitées par Fliks sont celles que vous
  enregistrez vous-même sur votre instance (médiathèque, profils
  utilisateurs, historique de lecture).

## Données stockées localement sur l'appareil

L'application Fliks (web et mobile) stocke localement, sur l'appareil
de l'utilisateur uniquement :

- **Jeton d'authentification** (JWT) permettant de rester connecté à
  votre serveur Fliks après la première connexion ;
- **Préférences de lecture** (langue audio préférée, langue de
  sous-titres, taille / couleur des sous-titres, etc.) ;
- **Cache de lecture** (segments HLS pré-téléchargés, sprites de
  prévisualisation de la barre de progression) — supprimé
  automatiquement à la fermeture de l'application ou après expiration ;
- **Configuration du serveur** (URL du serveur Fliks que vous
  utilisez, choisie par vous lors de la première connexion).

Ces données ne quittent jamais votre appareil. La désinstallation de
l'application les supprime intégralement.

## Données traitées par votre serveur Fliks

Lorsque vous installez votre propre instance Fliks, le serveur stocke,
sur **votre infrastructure** et sous **votre contrôle exclusif** :

- Comptes utilisateurs (nom, mot de passe haché, rôle, avatar) ;
- Catalogue de médias importé depuis vos sources (TMDB, Radarr, Sonarr,
  etc.) ;
- Historique de lecture, progression, marqueurs intro / outro ;
- Sous-titres téléchargés ;
- Préférences applicatives.

Fliks (l'éditeur) **n'a accès à aucune de ces données** : elles
résident sur votre serveur, derrière votre réseau, et ne sont
transmises à aucun tiers par l'application elle-même.

En tant qu'opérateur de votre instance, vous êtes le **responsable du
traitement** au sens du RGPD vis-à-vis des utilisateurs auxquels vous
donnez accès. Cela inclut notamment le devoir d'information, le droit
d'accès et de rectification, et la sécurité du serveur.

## Services tiers

L'application Fliks utilise les services tiers suivants :

| Service | Usage | Données concernées |
|---|---|---|
| **The Movie Database (TMDB)** | Métadonnées des films / séries (titres, affiches, synopsis) | L'identifiant TMDB du média demandé, depuis votre serveur uniquement |
| **Google Cast SDK** | Diffusion sur Chromecast | Référence du média à lire, durée, position. Aucune donnée utilisateur |
| **Indexeurs Torznab** | Recherche de releases (configurés par vous) | Termes de recherche envoyés directement par votre serveur, sans relais par Fliks |
| **Crash reports Google Play (Android)** | Diagnostic des plantages de l'application Android | Trace d'exécution, version d'Android, modèle du téléphone — collectés par Google si vous avez accepté lors de l'installation depuis le Play Store. Désactivable depuis les paramètres Android |

L'application **n'utilise pas** : Google Analytics, Firebase Analytics,
Facebook SDK, Sentry, ou tout autre outil de tracking publicitaire ou
comportemental.

## Permissions Android demandées

- **Stockage** : pour mettre en cache les segments vidéo en cours de
  lecture et les fichiers téléchargés pour visionnage hors-ligne (si
  cette fonction est activée par l'utilisateur).
- **Accès réseau** : pour communiquer avec votre serveur Fliks.
- **Découverte sur le réseau local** (mDNS / Bonjour) : pour détecter
  les appareils Cast à proximité.
- **Notifications** : pour vous prévenir de la fin d'un téléchargement
  ou d'une mise à jour disponible (optionnel, refusable).

L'application **ne demande pas** l'accès aux contacts, aux SMS, à la
caméra, au micro, à la localisation ou à l'agenda.

## Cookies / traceurs publicitaires

Aucun. L'application web ne dépose aucun cookie tiers. Aucun pixel
publicitaire, aucun tracker comportemental, aucune publicité.

## Vos droits

L'éditeur de Fliks ne détenant aucune donnée personnelle vous
concernant, l'exercice des droits issus du RGPD (accès, rectification,
effacement, opposition, portabilité) doit s'adresser à **l'opérateur
de l'instance Fliks que vous utilisez** — généralement vous-même ou
l'administrateur du serveur sur lequel vous avez un compte.

## Modifications

Les présentes règles peuvent être mises à jour pour refléter les
évolutions du logiciel. La date de dernière mise à jour figure en haut
du document. L'historique complet des modifications est consultable
dans Git via [l'historique du fichier sur le repo
GitHub](https://github.com/fliks-app/fliks/commits/main/PRIVACY.md).

## Contact

Pour toute question relative à ces règles de confidentialité ou au
fonctionnement du logiciel, ouvrez une [issue sur GitHub](https://github.com/fliks-app/fliks/issues).
