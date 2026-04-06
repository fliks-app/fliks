# Transcoding Pipelines

Suitarr supporte 4 pipelines de transcodage video, avec gestion du tone mapping HDR vers SDR.

## Pipelines

### 1. Intel QSV (Quick Sync Video)

Decode avec VAAPI, scale avec VAAPI, encode avec QSV. Le plus performant sur Intel.

**Sans tone mapping :**
```
VAAPI decode → scale_vaapi (nv12, align 16px) → hwmap QSV → h264_qsv encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-init_hw_device qsv=qs@va
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_qsv
-vf scale_vaapi=w={W}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv
```

**Avec tone mapping HDR→SDR :**
```
VAAPI decode → scale_vaapi (align 16px) → hwmap OpenCL → tonemap_opencl (reinhard) → hwmap QSV → h264_qsv encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-init_hw_device qsv=qs@va
-init_hw_device opencl=ocl:0.0 -filter_hw_device ocl
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_qsv
-vf scale_vaapi=w={W}:h=-16:extra_hw_frames=24,
    hwmap=derive_device=opencl:mode=read,
    tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,
    hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,
    format=qsv
```

### 2. VAAPI

Decode et encode entierement en VAAPI. Alternative a QSV sur Intel ou AMD.

**Sans tone mapping :**
```
VAAPI decode → scale_vaapi (nv12, align 16px) → h264_vaapi encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_vaapi
-vf scale_vaapi=w={W}:h=-16:format=nv12
```

**Avec tone mapping HDR→SDR :**
```
VAAPI decode → scale_vaapi (align 16px) → hwmap OpenCL → tonemap_opencl (reinhard) → hwmap VAAPI → h264_vaapi encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-init_hw_device opencl=ocl:0.0 -filter_hw_device ocl
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_vaapi
-vf scale_vaapi=w={W}:h=-16:extra_hw_frames=24,
    hwmap=derive_device=opencl:mode=read,
    tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,
    hwmap=derive_device=vaapi:mode=write:reverse=1,
    format=vaapi
```

### 3. NVENC (NVIDIA)

Decode avec CUDA, encode avec NVENC. Le tone mapping passe par le CPU (pas de support natif GPU NVIDIA dans FFmpeg pour tonemap).

**Sans tone mapping :**
```
CUDA decode → scale_cuda (nv12) → h264_nvenc encode
```
```
-hwaccel cuda -hwaccel_output_format cuda
-c:v h264_nvenc -preset p4
-vf scale_cuda=w={W}:h=-2:format=nv12
```

**Avec tone mapping HDR→SDR :**
```
CUDA decode → hwdownload CPU → zscale/tonemap (mobius) → scale → h264_nvenc encode
```
```
-hwaccel cuda
-c:v h264_nvenc -preset p4
-vf hwdownload,format=p010le,
    zscale=t=linear:npl=100,format=gbrpf32le,
    zscale=p=bt709,tonemap=mobius:desat=0,
    zscale=t=bt709:m=bt709:r=tv,format=yuv420p,
    scale={W}:-2
```

### 4. CPU (libx264)

Fallback logiciel. Utilise aussi quand le burn-in de sous-titres est actif (les filtres ASS/SSA sont CPU-only).

**Sans tone mapping :**
```
CPU decode → scale → format yuv420p → libx264 encode
```
```
-c:v libx264 -preset veryfast
-vf scale={W}:-2:flags=lanczos,format=yuv420p
```

**Avec tone mapping HDR→SDR :**
```
CPU decode → zscale/tonemap (mobius) → scale → libx264 encode
```
```
-c:v libx264 -preset veryfast
-vf zscale=t=linear:npl=100,format=gbrpf32le,
    zscale=p=bt709,tonemap=mobius:desat=0,
    zscale=t=bt709:m=bt709:r=tv,format=yuv420p,
    scale={W}:-2:flags=lanczos,format=yuv420p
```

## Alignement de la hauteur

Les encodeurs hardware H.264 (QSV, VAAPI) necessitent un alignement de la hauteur de sortie a 16 pixels (taille des macroblocs). Sans cet alignement, les pixels de padding non-initialises apparaissent en vert en bas de l'image, surtout visible avec du contenu 10-bit HDR.

| Pipeline | Alignement hauteur | Raison |
|----------|-------------------|--------|
| QSV / VAAPI | `h=-16` | Alignement macrobloc 16px obligatoire |
| NVENC | `h=-2` | `scale_cuda` + `format=nv12` gere l'alignement |
| CPU | `h=-2` | `format=yuv420p` explicite force la conversion 8-bit |

La hauteur annoncee dans le master playlist HLS (`RESOLUTION=WxH`) est calculee avec le meme alignement 16px (`Math.floor(rawH / 16) * 16`).

## Format pixel et HDR 10-bit

Quand le contenu source est en HDR 10-bit (P010/yuv420p10le) et qu'il est transcode **sans tone mapping** (le client supporte le HDR mais le codec/bitrate force le transcodage), une conversion de format explicite est necessaire pour eviter les artefacts :

| Pipeline | Conversion | Filtre |
|----------|-----------|--------|
| QSV / VAAPI | P010 → NV12 | `scale_vaapi=format=nv12` |
| NVENC | P010 → NV12 | `scale_cuda=format=nv12` (reste sur GPU) |
| CPU | 10-bit → 8-bit | `format=yuv420p` apres le scale |

## Tone mapping - algorithmes

| Pipeline | Algorithme | Notes |
|----------|-----------|-------|
| QSV / VAAPI | `reinhard` (via OpenCL) | Bon rendu HDR→SDR, preserve les details dans les hautes lumieres |
| NVENC / CPU | `mobius` (via zscale) | Bon compromis luminosite/contraste |

### Parametres communs
- `peak=100` / `npl=100` : luminosite nominale de reference (100 nits SDR)
- `desat=0` : pas de desaturation supplementaire
- `p=bt709:t=bt709:m=bt709` : espace colorimetrique cible SDR (BT.709)

## Priorite de selection

1. Si burn-in sous-titres actif → force CPU (les filtres ASS sont CPU-only)
2. Si crop actif + QSV → descend a VAAPI (QSV ne supporte pas le changement de dimensions via hwmap)
3. Si crop actif + VAAPI → reste VAAPI avec `hwdownload → crop → hwupload` (fallback CPU si crash)
4. Si crop actif + NVENC → `hwdownload → crop → hwupload_cuda` puis `scale_cuda`
5. Sinon utilise le `hwAccel` detecte/configure : `qsv` > `vaapi` > `nvenc` > `none`

Voir [crop-black-bars.md](crop-black-bars.md) pour le detail du systeme de suppression des bandes noires.

## Prerequis

- **QSV/VAAPI + tonemap** : necessite le runtime OpenCL Intel (`intel-opencl-icd` ou `intel-compute-runtime`)
- **NVENC** : necessite les drivers NVIDIA + CUDA
- **CPU** : aucun prerequis materiel
