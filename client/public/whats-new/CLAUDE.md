# What's new notes

The desktop and web clients show these notes once per account, in a carousel, on the first launch of a new version (`shared/components/whats-new-modal`). This file is excluded from the build (`angular.json` asset `ignore`).

## Layout

- `index.json`: every version that has notes. A version missing here is never shown, so add it with its folder.
- `<version>/<lang>.md` for the six app languages (`en fr de es it pt`, English is the fallback), and the pictures next to them.
- One modal chains the versions missed since the last one seen, oldest first, at most the latest three.

## Writing

- One `## Title` per slide, 4 to 6 slides per version. Under it: the picture line `![alt](name.webp)`, one intro sentence, then `###` sub-parts with short bullets.
- Be exact. Check every claim against `server/docs/spec/*.md`, the client code and `git log`, not against the plans. Leave out what you cannot confirm.
- Say when a feature is admin-only, off by default or experimental.
- Say which sources are plugins: those in `server/providers.lock` are "installed with Fliks"; any other comes "from the plugin catalogue" (`fliks-plugin-catalog`).
- Name UI elements with their exact label from `public/i18n/<lang>.json`, in every language.
- Write English and French first, then translate the other four with the same structure. Address the reader as the i18n file of that language does. Never use the em dash character.

## Pictures

- 1600x900 WebP, desktop form factor, English UI. Capture over CDP with headless Chromium (`Page.captureScreenshot`, `format: 'webp'`, `quality: 85`); force the desktop with `/?desktop=1`. The subject should sit in the middle: the modal shows the picture at 16:9.
- Never show real content. Before each capture, rewrite the DOM:
  - books, films: public-domain works and their real authors;
  - music, lyrics: invented artists, albums, tracks and lines;
  - covers and artwork: generated SVG (gradient and title for books, abstract shapes for albums);
  - people, file names, paths: neutral invented ones.
- Check every capture yourself, small text included (badges, mini-player, tooltips).
- When the dev library has nothing to show, invent it. For example, draw a few comic pages as HTML or SVG, render them to images, pack them into CBZ files with a `ComicInfo.xml`, put them in a new folder under a path the server container mounts (`docker inspect`), create a temporary library, scan it, and capture. Then delete the library and the files.
- Don't start playback on the admin account while the owner may be listening: ask for a test account instead.
- Close the browser by PID and delete its profile directory.

## Preview

Copy `<version>/` to a folder named after the version the client runs (`environment.version`) and list it in `index.json`, set `whatsNewSeen` on the test account to an older version (it lives on the account, not in local storage) and reload. Never commit that copy.
