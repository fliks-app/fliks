# Privacy Policy

_Last updated: 20 November 2026_

Fliks is an open-source self-hosted media server. This document
describes which data is collected, by whom, and how it is used in the
context of the Fliks application (web, Android, iOS, Android TV,
Apple TV) and the Fliks Chromecast receiver.

## In a nutshell

- **Fliks (the publisher of the software) operates no central server**
  receiving your data. Every user hosts their own Fliks instance on
  their own hardware. The one exception is the optional push relay,
  disabled by default, described in [Push notifications](#push-notifications).
- The mobile / web app talks **only to your Fliks server** (and, for
  notifications you turn on, to the push services of your platform). It does
  not communicate with any third party for analytics, advertising,
  tracking, or profiling purposes.
- The only data Fliks ever processes is the data you record yourself
  on your own instance (media library, user accounts, watch history).

## Data stored locally on the device

The Fliks application (web and mobile) stores the following data
locally, on the user's device only:

- **Authentication tokens** (JWT) used to keep you signed in to your
  Fliks server after first login, one session per account and per
  server so you can switch profiles without signing in again. On Apple TV
  they live in the system keychain; on iPhone and iPad they live in the
  app's private preferences, inside the app sandbox;
- **Push notification keys** (iPhone and iPad, Android): when you turn
  notifications on, a key pair made for that sign-in, so that notifications
  can be decrypted on the device. On iPhone and iPad it is kept in the
  keychain, shared with the app's notification extension and not synced to
  other devices; on Android it is wrapped by the Android Keystore;
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
- Playback quality reports: how each playback went (stalls, errors,
  throughput, buffer, dropped frames, decoder, and what the server did
  to the stream), stored with the user, a random id drawn for each
  viewing, the media title, the device (the user agent of the app or
  browser that started the playback, which can name the device model,
  and the system name) and the app version. No IP address and no media
  content. They are deleted 30 days after the playback was last seen
  by default; an administrator can change that, or turn the collection
  off;
- Application preferences.

Playback quality reports are sent by the apps to your own Fliks server
only. The Chromecast receiver hands its measurements to the app that
started the cast, which forwards them to your server. They are read
by your server's administrators and go to no third party.

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
| **Apple Push Notification service, Firebase Cloud Messaging** (iPhone, iPad, Android; only when you turn notifications on and your administrator enabled the Fliks Relay) | Delivering mobile notifications | The encrypted notification and the device's push token. See [Push notifications](#push-notifications) |
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

## Push notifications

Fliks can notify you of request decisions, watch party invitations, follow
requests, new episodes, sign-in requests from another device and messages from
plugins an administrator installed. There are four ways to receive them. Each
user turns each one on per device, and can mute each category (applied to all
their devices).

| Where | How it is delivered | Goes through a service of the publisher |
|---|---|---|
| In the app (web, desktop, Apple TV, Android TV, Tizen, webOS) | A message on screen over your server's live connection | No |
| Browser (Web Push) | Your server sends the notification, encrypted, to the push service of your browser vendor | No |
| Desktop app | Your server's live connection, shown by the operating system while the app runs in the background (an option you turn on) | No |
| iPhone, iPad, Android | Your server sends the notification, encrypted for the device, to the Fliks Relay, which hands it to Apple (APNs) or Google (FCM) | **Yes, only if your administrator enabled the Fliks Relay connection** |

### The Fliks Relay (optional)

The Fliks Relay is a small service the publisher of Fliks runs for mobile
notifications. It is **disabled by default**: nothing is sent to it until the
administrator of your server turns on the *Fliks Relay* connection in the
notification settings. A server owner can also point the server at their own
relay with the `FLIKS_PUSH_RELAY_URL` deployment variable; the apps published
in the stores only talk to the official relay.

**What your server sends it.** When the connection is enabled, the server
makes a key pair of its own, keeps it in a private file on the server, and
registers the public key with the relay. Each notification is then sent
already encrypted for the target device (RFC 8291, the standard also used by
Web Push), with a small routing envelope.

**What the relay stores:**

| Data | Why | Kept |
|---|---|---|
| The public key of each server | Check the signature of each request | Until the server unregisters, or 180 days without a request |
| For each subscribed device: server key, subscription id, platform (iOS or Android), the platform push token | Deliver a push | Until the app or the server deletes it, or 60 days unused |
| A hash of the key of a server blocked for abuse | Keep it from registering again | Until the operator unblocks it |
| Anonymous daily counters: servers, subscriptions per platform, notifications sent, delivered, refused by a limit, failed, tokens that expired | Run and protect the service | Global totals 2 years; per server 90 days, under an opaque id the relay cannot tie back to a key |

**What the relay does not store:** the content of notifications, which it
cannot read; a history of notifications; IP addresses; server names, versions
or addresses; user names or account ids. Its logs carry a key prefix, never a
token or a payload. A reverse proxy placed in front of the relay by its
operator is outside that list and may keep its own access logs.

**What Apple and Google see.** Apple (APNs) or Google (FCM) receive the
encrypted notification and the device's push token, as for every app that uses
their push services, and can tell when a notification is delivered to which
device. They cannot read the content. On Android the app starts Firebase Cloud
Messaging only when you turn notifications on, and ships no Firebase analytics.
On iPhone and iPad, if the notification cannot be decrypted, the system shows
a generic text that names no content.

**Stopping it and deleting the data.**

- Turn a device off, or sign out: the app deletes that device's token at the
  relay itself, even if your server is unreachable (it retries at the next
  launch).
- The administrator disables the *Fliks Relay* connection: the server deletes
  all its subscriptions and unregisters its key at the relay (retried until the
  relay answers). That removes the per-server counters; the global totals keep
  no identity and stay.
- A session revoked, a password changed or a user disabled: the server deletes
  that session's subscription at the relay.
- Whatever is left expires on the retentions above.

Web Push and desktop notifications never touch the relay and are not counted
by it.

### What your server keeps

Your server stores, for each device that receives system notifications, the
public key and the secret used to encrypt for it, the platform, the language,
and for browsers the address of the browser's push service. It also keeps which
categories each user muted. It deletes them when the session ends.

## Android permissions requested

- **Storage**: to cache video segments currently being played and
  files downloaded for offline viewing (if you opt in).
- **Network access**: to talk to your Fliks server.
- **Local network discovery** (mDNS / Bonjour): to detect Cast
  devices nearby.
- **Notifications**: to notify you of completed downloads and of the
  notifications described in [Push notifications](#push-notifications)
  (optional, can be denied).

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
