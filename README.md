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

## License

[AGPL-3.0-or-later](LICENSE) — anyone running a modified version of Fliks on
a network must make the modified source available to its users.
