# Transcoding Pipelines

Suitarr supporte 4 pipelines de transcodage video, avec gestion du tone mapping HDR vers SDR.

## Pipelines

### 1. Intel QSV (Quick Sync Video)

Decode avec VAAPI, scale avec VAAPI, encode avec QSV. Le plus performant sur Intel.

**Sans tone mapping :**
```
VAAPI decode → scale_vaapi → hwmap QSV → h264_qsv encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-init_hw_device qsv=qs@va
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_qsv
-vf scale_vaapi=w={W}:h=-2:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv
```

**Avec tone mapping HDR→SDR :**
```
VAAPI decode → scale_vaapi → hwmap OpenCL → tonemap_opencl (bt2390) → hwmap QSV → h264_qsv encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-init_hw_device qsv=qs@va
-init_hw_device opencl=ocl:0.0 -filter_hw_device ocl
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_qsv
-vf scale_vaapi=w={W}:h=-2:extra_hw_frames=24,
    hwmap=derive_device=opencl:mode=read,
    tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,
    hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,
    format=qsv
```

### 2. VAAPI

Decode et encode entierement en VAAPI. Alternative a QSV sur Intel ou AMD.

**Sans tone mapping :**
```
VAAPI decode → scale_vaapi → h264_vaapi encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_vaapi
-vf scale_vaapi=w={W}:h=-2:format=nv12
```

**Avec tone mapping HDR→SDR :**
```
VAAPI decode → scale_vaapi → hwmap OpenCL → tonemap_opencl (bt2390) → hwmap VAAPI → h264_vaapi encode
```
```
-init_hw_device vaapi=va:/dev/dri/renderD128
-init_hw_device opencl=ocl:0.0 -filter_hw_device ocl
-hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device va
-c:v h264_vaapi
-vf scale_vaapi=w={W}:h=-2:extra_hw_frames=24,
    hwmap=derive_device=opencl:mode=read,
    tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,
    hwmap=derive_device=vaapi:mode=write:reverse=1,
    format=vaapi
```

### 3. NVENC (NVIDIA)

Decode avec CUDA, encode avec NVENC. Le tone mapping passe par le CPU (pas de support natif GPU NVIDIA dans FFmpeg pour tonemap).

**Sans tone mapping :**
```
CUDA decode → scale → h264_nvenc encode
```
```
-hwaccel cuda -hwaccel_output_format cuda
-c:v h264_nvenc -preset p4
-vf scale={W}:-2
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
CPU decode → scale → libx264 encode
```
```
-c:v libx264 -preset veryfast
-vf scale={W}:-2
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
    scale={W}:-2
```

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
4. Sinon utilise le `hwAccel` detecte/configure : `qsv` > `vaapi` > `nvenc` > `none`

Voir [crop-black-bars.md](crop-black-bars.md) pour le detail du systeme de suppression des bandes noires.

## Prerequis

- **QSV/VAAPI + tonemap** : necessite le runtime OpenCL Intel (`intel-opencl-icd` ou `intel-compute-runtime`)
- **NVENC** : necessite les drivers NVIDIA + CUDA
- **CPU** : aucun prerequis materiel
