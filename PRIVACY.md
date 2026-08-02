# Privacy Policy

_Last updated: 3 May 2026_

Fliks is an open-source self-hosted media server. This document
describes which data is collected, by whom, and how it is used in the
context of the Fliks application (web, Android, iOS, Android TV,
Apple TV) and the Fliks Chromecast receiver.

## In a nutshell

- **Fliks (the publisher of the software) operates no central server**
  receiving your data. Every user hosts their own Fliks instance on
  their own hardware.
- The mobile / web app talks **only to your Fliks server**. It does
  not communicate with any third party for analytics, advertising,
  tracking, or profiling purposes.
- The only data Fliks ever processes is the data you record yourself
  on your own instance (media library, user accounts, watch history).

## Data stored locally on the device

The Fliks application (web and mobile) stores the following data
locally, on the user's device only:

- **Authentication tokens** (JWT) used to keep you signed in to your
  Fliks server after first login. On iOS and Apple TV they live in the
  system keychain, one session per account and per server, so you can
  switch profiles without signing in again;
- **Playback preferences** (preferred audio language, subtitle
  language, subtitle size / colour, etc.);
- **Playback cache** (pre-fetched HLS segments, sprite sheets for the
  seek-bar preview) — automatically purged on app shutdown or
  expiration;
- **Home page cache** (titles and artwork addresses of the rows last
  received from your server) so the app can show its previous state
  while it refreshes;
- **Server configuration** (the URL of the Fliks server you use,
  picked by you on first connection).

This data never leaves your device. Uninstalling the application
removes it entirely.

## Data processed by your Fliks server

When you install your own Fliks instance, the server stores the
following on **your infrastructure** and under your **exclusive
control**:

- User accounts (username, hashed password, role, avatar);
- Media catalogue imported from your sources (TMDB, Radarr, Sonarr,
  etc.);
- Watch history, playback progress, intro / outro markers;
- Downloaded subtitles;
- Application preferences.

Fliks (the publisher) **has no access to any of this data**: it lives
on your server, behind your network, and is never transmitted to any
third party by the application itself.

As the operator of your instance, you are the **data controller**
under GDPR with respect to the users you grant access to. This
includes the duty to inform, the rights of access and rectification,
and the security of the server.

## Third-party services

### App side (mobile / web)

The application itself communicates with a small, fixed set of
third-party services bundled into the software:

| Service | Purpose | Data involved |
|---|---|---|
| **Google Cast SDK** (web, Android, iOS — absent from the Apple TV app) | Streaming to Chromecast | Reference of the media to play, duration, position. No user data |
| **Google Play crash reports (Android)** | Diagnosing app crashes | Stack trace, Android version, device model — collected by Google if you opted in when installing from the Play Store. Disable from Android settings |

The application **does not use** Google Analytics, Firebase Analytics,
the Facebook SDK, Sentry, or any other advertising / behavioural
tracking tool.

### Server side (your Fliks instance)

Your Fliks server may query third-party services depending on the
features you enable (metadata providers, release indexers, subtitle
providers, external media servers, etc.). This list **is not
exhaustive** and evolves with the software releases; representative
examples:

- **Metadata providers**: The Movie Database (TMDB), The TVDB, etc.
  → identifiers of the media your server requests, to fetch titles,
  posters, summaries.
- **Torznab indexers** (Jackett, public or private trackers you
  configure) → search terms used to find releases.
- **Subtitle providers** (OpenSubtitles, Subscene, etc.) → media
  identifiers / file hashes.
- **External media servers** (Emby, Jellyfin, Plex) if you link your
  instance to one of them to synchronise watch history.

These calls leave **your server directly**, under your configuration
and your responsibility. None of them are routed through any server
operated by the publisher of Fliks.

## Android permissions requested

- **Storage**: to cache video segments currently being played and
  files downloaded for offline viewing (if you opt in).
- **Network access**: to talk to your Fliks server.
- **Local network discovery** (mDNS / Bonjour): to detect Cast
  devices nearby.
- **Notifications**: to notify you of completed downloads or
  available updates (optional, can be denied).

The application **does not request** access to your contacts, SMS,
camera, microphone, location, or calendar.

## Cookies / advertising trackers

None. The web app sets no third-party cookies. No advertising pixels,
no behavioural trackers, no ads.

## Your rights

Since Fliks's publisher holds no personal data about you, GDPR rights
(access, rectification, erasure, objection, portability) must be
exercised against the **operator of the Fliks instance you use** —
typically yourself, or the administrator of the server you have an
account on.

## Changes

This policy may be updated to reflect software evolution. The last
update date sits at the top of the document. The full history is
available via [the file's history on
GitHub](https://github.com/fliks-app/fliks/commits/main/PRIVACY.md).

## Contact

For any question about this privacy policy or how the software
operates, open an [issue on
GitHub](https://github.com/fliks-app/fliks/issues).
