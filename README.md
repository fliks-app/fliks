# Fliks

Self-hosted media server — alternative to Plex / Jellyfin / Emby with built-in
library management (replaces Radarr / Sonarr / Prowlarr).

NestJS backend, Angular client wrapped in Capacitor for iOS / Android /
Android TV, Chromecast receiver, FFmpeg / Shaka transcoding pipeline.

## Layout

- **`backend/`** — NestJS + TypeORM + PostgreSQL
- **`client/`** — Angular + DaisyUI / Tailwind + Shaka Player; same codebase
  ships as web app and as Capacitor-wrapped iOS / Android / Android TV apps
- **`cast-receiver/`** — custom CAF receiver hosted on GitHub Pages

## Self-hosting with Docker

The recommended way to run Fliks is via the published image on GitHub
Container Registry (`ghcr.io/fliks-app/fliks`). It bundles the backend,
the built Angular client served as static assets, and the FFmpeg /
hardware-acceleration stack.

```bash
# 1. Grab the example Compose
curl -LO https://raw.githubusercontent.com/fliks-app/fliks/main/docker-compose.example.yml
mv docker-compose.example.yml docker-compose.yml

# 2. Edit:
#    - `POSTGRES_PASSWORD` + `DB_PASSWORD` (set a real password)
#    - the `/path/to/your/media:/medias:ro` mount → point at your library
#    - `PORT` if 4848 collides on the host

# 3. Run
docker compose up -d
```

UI at `http://<host>:4848`.

### Pinning a version

`:latest` follows the most recent stable release. To pin, replace with a
specific tag (e.g. `:1.2.3`) — full list at
https://github.com/fliks-app/fliks/pkgs/container/fliks.

### Hardware-accelerated transcoding

Intel QSV / VAAPI works out of the box if you uncomment the `/dev/dri`
device mount in the example Compose. NVIDIA NVENC requires the host to
have `nvidia-container-toolkit` installed and a different Compose
snippet — the [transcoding docs](docs/transcoding-pipelines.md) cover
both paths.

## License

[AGPL-3.0-or-later](LICENSE) — anyone running a modified version of Fliks on
a network must make the modified source available to its users.
