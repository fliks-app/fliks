# Fliks Cast Receiver

Static HTML/JS shell that runs **on the Chromecast device** itself when a
Fliks user starts casting. Hosted at a single fixed URL (one for the
whole project) and registered once in Google Cast Developer Console.

The receiver is **user-agnostic**: it knows nothing about who you are or
what NAS you run. The Fliks sender app pushes a stream URL via the
standard Cast LOAD message, and the receiver plays whatever it gets.
Your media stays on your NAS — only the receiver shell is centralised.

## Architecture

```
┌─────────────────┐    LOAD message       ┌─────────────────────┐
│ Fliks (sender)  │  ───────────────────▶ │ Chromecast device   │
│ on phone/web    │   stream URL +        │ runs receiver shell │
└─────────────────┘   customData          │ from cast.fliks.…   │
        │                                 └──────────┬──────────┘
        │                                            │ HLS / MP4
        │                                            ▼
        │              same LAN              ┌─────────────────┐
        └──────────────────────────────────▶ │ User's NAS      │
                                             │ (auth via token │
                                             │  in URL)        │
                                             └─────────────────┘
```

## Files

- `index.html` — entry point loaded by the Chromecast.
- `receiver.js` — boots CAF SDK, hooks LOAD/IDLE, applies subtitle defaults.
- `receiver.css` — branding, idle splash, `::cue` style.
- `fliks-mark.png` — splash logo.

No build step. The directory is published as-is to GitHub Pages by
[`.github/workflows/deploy-cast-receiver.yml`](../.github/workflows/deploy-cast-receiver.yml).

## First-time setup (project owner)

1. **Enable GitHub Pages** for this repo:
   `Settings → Pages → Source = "GitHub Actions"`.
2. **Push** anything that touches `cast-receiver/`. The workflow
   publishes to `https://<owner>.github.io/<repo>/` (URL appears in
   the action's `deploy` step output).
3. **Register the receiver** in [Cast Developer Console](https://cast.google.com/publish/):
   - New application → Custom Receiver.
   - Receiver Application URL = the GitHub Pages URL from step 2.
   - Description: `Fliks`.
   - Note the **App ID** Google generates.
4. **Add your test Chromecast** in the console:
   `Cast Receiver Devices → Add` with the device's serial number
   (System → About on the Chromecast). Required for unpublished
   receivers — you can only cast to *your own* registered devices
   until the app is published for everyone.
5. **Wire the App ID into Fliks**:
   - `client/src/environments/environment.ts` →
     `castAppId: '<your_app_id>'`.
   - `client/android/app/src/main/res/values/strings.xml` →
     `<string name="cast_receiver_app_id"><your_app_id></string>`.
   - Both MUST be the same — they cover web and native paths.
6. Rebuild Fliks (`npm run build` for web, `npm run cap:build` for
   Android) and cast from a registered device.

## Publishing for end-users

Once the receiver is stable, in Cast Console submit it for **Publication**.
Google reviews (~hours to days) and once approved, anyone can cast — no
device-side registration needed.

## Local dev

The Chromecast can't load `localhost`. To iterate on `cast-receiver/`
without re-deploying:

- Serve over a tunnel (`cloudflared tunnel`, `ngrok`, etc.) on HTTPS.
- In Cast Console, edit the receiver URL to your tunnel URL.
- Cast → check the receiver's debug overlay (`Receiver → Connect` in
  Chrome DevTools at `chrome://inspect`).

## customData contract

Sender sends, receiver reads:

```ts
{
  title: string,
  subtitle?: string,
  posterUrl?: string,
  mediaId?: number,    // Fliks media row id, for receiver-side actions
  episodeId?: number,  // when applicable
}
```

Reserved for upcoming features (skip-intro markers, queue auto-next,
watch-next on STOP). Add fields here and parse them in `receiver.js`'s
LOAD interceptor.
