# Suppression automatique des bandes noires (Crop)

Suitarr detecte et supprime automatiquement les bandes noires (letterbox/pillarbox) integrees dans les fichiers video lors du transcodage.

## Vue d'ensemble

```
Scan fichier → ffprobe cropdetect → stockage dans streamInfo → transcodage avec filtre crop
```

Les bandes noires sont des pixels noirs encodes dans le fichier video (contrairement aux bandes noires ajoutees par le player pour adapter le ratio). Exemple : un film 2.35:1 encode dans un conteneur 16:9 (1920x1080) avec des bandes noires en haut et en bas.

## 1. Detection (`ffprobe.service.ts`)

La methode `detectCrop()` utilise le filtre `cropdetect` de ffmpeg :

- **Echantillonnage** : 3 points dans la video (10%, 30%, 50% de la duree) pour eviter les faux positifs (scenes sombres, generiques)
- **Vote majoritaire** : la valeur de crop la plus frequente est retenue
- **Seuil minimum** : les bandes doivent etre > 20px pour etre considerees significatives
- **Resultat** : `{ width, height, x, y }` stocke dans `streamInfo.video[0].crop`

Exemple pour un film 2.35:1 dans un conteneur 1080p :
```
crop = { width: 1920, height: 816, x: 0, y: 132 }
```
→ Bandes noires de 132px en haut et en bas.

## 2. Decision de lecture (`stream-builder.service.ts`)

Quand un fichier a des infos de crop dans son `streamInfo` :

- **DirectPlay** : interdit (le fichier original contient les bandes)
- **DirectStream (remux)** : interdit (la video est copiee telle quelle)
- **Transcode** : force, avec la raison `VideoCrop`

Le crop est donc transparent pour l'utilisateur — pas de bouton toggle, le transcodage s'en charge automatiquement.

## 3. Transcodage (`transcoding.service.ts`)

Le filtre ffmpeg `crop=W:H:X:Y` est insere avant le `scale` dans la chaine de filtres video.

### Pipelines par accelerateur

| HW Accel detecte | Pipeline avec crop | Encodeur |
|---|---|---|
| **QSV** | Force VAAPI : `hwdownload → crop → hwupload → scale_vaapi → h264_vaapi` | h264_vaapi |
| **VAAPI** | `hwdownload → crop → hwupload → scale_vaapi → h264_vaapi` | h264_vaapi |
| **NVENC** | CPU crop : `crop → scale → h264_nvenc` | h264_nvenc |
| **CPU** | `crop → scale → libx264` | libx264 |

#### Pourquoi QSV ne peut pas crop directement ?

QSV utilise `hwmap` pour mapper les surfaces VAAPI vers QSV. Ce mapping exige des pools de taille fixe (les dimensions sont decidees a l'initialisation). Le crop change les dimensions des frames en cours de pipeline, ce qui casse le mapping QSV. La solution : descendre au niveau VAAPI pour l'encodage quand le crop est actif.

#### Pipeline VAAPI detaille

```
VAAPI decode (frames GPU)
  → hwdownload (GPU → CPU, format nv12)
  → crop=W:H:X:Y (filtre CPU, change les dimensions)
  → hwupload=derive_device=vaapi (CPU → GPU, surfaces VAAPI)
  → scale_vaapi=w={W}:h=-2 (redimensionnement GPU)
  → h264_vaapi encode
```

Commande ffmpeg generee :
```
ffmpeg -init_hw_device vaapi=va:/dev/dri/renderD128
  -hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
  -i input.mkv
  -c:v h264_vaapi
  -vf hwdownload,format=nv12,crop=1920:816:0:132,hwupload=derive_device=vaapi,scale_vaapi=w=1280:h=-2:format=nv12
  ...
```

### Fallback

Si le pipeline VAAPI avec crop echoue (driver incompatible, etc.), le mecanisme de fallback existant relance automatiquement en CPU :

```
QSV + crop → tente VAAPI + hwdownload/crop/hwupload → si crash → CPU (libx264)
VAAPI + crop → tente hwdownload/crop/hwupload → si crash → CPU (libx264)
```

## 4. Resolutions HLS (`streaming.controller.ts` + `transcoding.service.ts`)

Le master playlist HLS annonce les resolutions **croppees**, pas les originales.

La hauteur de chaque variante est calculee a partir du ratio source croppe :
```
h = round(w * cropHeight / cropWidth / 2) * 2
```

Le `/ 2 * 2` arrondit au nombre pair (requis par les encodeurs video, equivalent au `-2` de ffmpeg).

Exemple pour un source croppe 1920x816 (ratio 2.35:1) :

| Profil | maxWidth | Resolution annoncee | Resolution reelle ffmpeg |
|--------|----------|--------------------|-----------------------|
| 1080p | 1920 | 1920x816 | 1920x816 |
| 720p | 1280 | 1280x544 | 1280x544 |
| 480p | 854 | 854x362 | 854x362 |
| 360p | 640 | 640x272 | 640x272 |

## Interactions avec d'autres fonctionnalites

| Fonctionnalite | Interaction |
|---|---|
| **Tone mapping HDR→SDR** | Compatible. Sur VAAPI le crop passe avant le tonemap OpenCL. Sur CPU les deux filtres sont chaines. |
| **Burn-in sous-titres** | Le burn-in force deja le CPU. Le crop est ajoute avant le scale dans la chaine CPU. |
| **Chromecast** | Le cast recoit le flux transcode (deja croppe). |
| **Changement de qualite** | Chaque variante HLS est transcodee independamment avec le crop. |

## Fichiers concernes

| Fichier | Role |
|---|---|
| `ffprobe.service.ts` | Detection crop via `cropdetect` |
| `stream-builder.service.ts` | Force le transcodage quand crop detecte |
| `transcoding.service.ts` | Filtre ffmpeg `crop=` + gestion pipelines HW |
| `streaming.controller.ts` | Passe les dimensions croppees au master playlist |
