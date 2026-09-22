# Live TV

Turns an existing IPTV subscription into another row of channels inside Fliks: a provider playlist
or panel becomes a lineup with its own program guide, and pausing or jumping back a few minutes on
a live channel works the same way it does on the rest of the library. Fliks does not sell or supply
any channels itself — you need a subscription from a provider before any of this is useful.

Everything below lives under **Settings > Live TV**, admin-only, across four tabs: **Sources**,
**Channels**, **Guide** and **Health**. The *Live TV* entry only appears in the main navigation once
at least one channel is enabled and visible to your account.

## Adding a source

**Settings > Live TV > Sources > New source.** A source is one provider connection; add one per
subscription. Two kinds:

- **M3U playlist** — either a **Playlist URL** (a link from the provider, re-fetched on every
  refresh) or **Upload a playlist file** for a `.m3u`/`.m3u8` file a provider mailed you instead of
  a link. An uploaded file is stored on the server but never updates itself; if the connection test
  below offers to swap it for a self-refreshing link rebuilt from the file's own entries, take it.
- **Xtream account** — **Server URL** (the panel address alone, without a path — nothing after the
  host) plus **Username** and **Password**. Editing an existing source and leaving Password blank
  keeps the current password.

Optional on either kind: **User agent** and **Referer**, for a provider that checks either header.

- **Max simultaneous streams (0 = unlimited)** caps how many upstream connections *this source* may
  hold open at once — not how many people can watch, since several viewers on the same channel share
  one upstream connection. The connection test or the first sync usually reads this from the account
  itself and locks the field; click **Override** to type your own number instead.
- **Refresh interval (hours)** — how often the lineup itself is re-fetched (12 by default).
- **Include groups matching** / **Exclude groups matching** — see the next section.
- **Source active** — an inactive source is skipped by the scheduler and by playback, but its
  channels and their history stay.

Fliks only ever keeps live channels from a playlist: any entry that looks like on-demand content
(the provider's own `/movie/` or `/series/` URL path) is dropped automatically, before any group
pattern is even applied — there is nothing to configure for that part.

## Test before you save

**Test connection** probes the URL or the Xtream login without saving anything. On success it
reports the channel count and the number of groups found, whether a program guide was found for the
source, and — for Xtream — how many simultaneous connections the account allows. If a pasted M3U
link is actually an Xtream panel link in disguise, or an uploaded file's own entries carry panel
credentials, the result also offers a one-click switch to the richer Xtream API. On failure it only
says the connection test failed; the actual reason (wrong credentials, an unreachable host, a
timeout...) shows up once you save, as the source's own sync error — see "What won't work" below.

## Group filters, with an example

A provider bouquet routinely mixes channels for dozens of countries and genres, plus a few groups
you'd rather never sync, under one playlist. **Exclude groups matching** drops any live channel
whose group name matches the pattern — for example:

```
adult|xxx|ppv|18\+
```

**Include groups matching** does the opposite: only groups matching it are kept, everything else is
dropped. To keep just two groups out of a huge bouquet:

```
^(News|Sport)$
```

Both fields are a case-insensitive regular expression tested against the provider's own group name
as a substring, not an exact match — `sport` also matches "Sports HD", so anchor it (`^Sport$`) if
you need an exact one. When both patterns are set, exclude always wins over include. This only
filters live channel *groups* — it plays no part in dropping on-demand content, which Fliks already
excludes on its own regardless of these patterns.

## Program guide (EPG)

**Settings > Live TV > Guide > New guide source.** Two kinds:

- **XMLTV feed** — a plain **URL** to an XMLTV document (Fliks accepts a gzip-compressed one too).
- **From a Live TV source** — a **Source** dropdown, picking one of the sources you already added.
  Fliks then reads whatever program guide URL that provider itself already publishes (captured from
  the playlist's own `x-tvg-url`/`url-tvg` header, or from the Xtream panel's own guide endpoint) the
  last time that source was synced. If the source doesn't publish one, this fails — check with
  **Test connection** on the source itself ("A program guide was found for this source.").

Also on the form: **Refresh interval (hours)** (12 by default), **Timezone offset (minutes)** —
shifts every program in the whole feed, for a feed whose clock is published in a different zone than
the channels actually air in — and **Source active**.

### Automatic matching, and the match report

Every ingested feed's own channels are matched against your lineup automatically, in three passes,
weakest last:

1. **By ID** — the channel's own **Guide channel ID** field, if already set, matched exactly against
   the feed's own channel id.
2. **By name** — both names normalized first (case, accents, punctuation and quality noise like "HD"
   or "1080p" stripped), then compared.
3. **Fuzzy** — a similarity score over what's left of the name; below a threshold, the channel is
   left unmatched rather than guessed at.

A channel matched by hand (see below) is never touched again by this pass, even if a later sync
would otherwise have picked something else.

The **Match report** on the Guide page shows how many channels landed in each of those three
buckets, plus every channel still unmatched with a search box next to it: type part of the real
channel name, pick the guide entry from the suggestions, and save. That sets the match permanently
("manual") for that one channel. You can also type a **Guide channel ID** directly into a channel's
own edit form on the Channels tab — it goes through the same manual, sticky path.

## Managing channels

**Settings > Live TV > Channels.** Filter by group (left rail), by source, by active/inactive state,
or search by name.

- The **Active** switch on each row — an inactive channel is invisible to every viewer and skipped
  by guide matching, but it keeps its number, group and history.
- Editing a channel: **Name**, **Number**, **Group**, **Guide channel ID** (manual guide match) and
  **Guide time shift (minutes)** — a per-channel version of the guide source's own timezone offset,
  for the one channel that airs shifted from the rest of its own feed.
- **Bulk actions**: select rows, or use "Bulk-edit all *N* matching channels" to act on everything
  the current filters match (only available once the active/inactive filter is cleared), then
  Enable, Disable, set a Group, or renumber from a starting number. Anything touching more than 50
  channels at once asks for confirmation first.
- **Find duplicate channels** groups channels whose names normalize to the same thing (case, accents
  and punctuation ignored) — typically the same channel synced from two different sources — and
  offers **Merge**: pick which one stays, and the others become its backup streams, used for
  failover if the one that stays goes down.
- **Favorites** and hiding a channel are each viewer's own preference, set from the Live TV page
  itself rather than here. Hiding is not the access control described next: it only changes what
  that one viewer sees, and they can undo it themselves at any time.

## Access control by channel group

There is no settings page for this yet — it's reached through the API directly, with an admin
session or API key:

- `GET`/`PUT /api/livetv/admin/access/restricted-groups`, body `{ "groups": ["Adult", "PPV"] }` —
  the list of channel group names that are invisible by default.
- `GET`/`PUT /api/livetv/admin/access/users/:userId`, same body shape — which of those restricted
  groups this one user is granted. Each `PUT` replaces the whole set for that user.

```bash
curl -X PUT https://<host>/api/livetv/admin/access/restricted-groups \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"groups": ["Adult", "PPV"]}'
```

A user who wasn't granted a restricted group never sees its channels at all, in any list — unlike
hiding a channel yourself, which only affects your own view and is reversible any time. An empty
restricted list means no filtering happens for anyone. Whoever administers Live TV always sees every
group, regardless of grants.

**Adult groups are restricted automatically.** Every sync checks each live group's name against a
built-in pattern (whole-word, case-insensitive: `xxx`, `adult`, `porn`, `erotic`, `18+`, `hot`) and
adds a newly-seen match to the restricted list. This runs again on every sync, so removing a group
from the list by hand doesn't stick if its name still matches the pattern — the next sync restricts
it again.

## Settings

These are tuning values, not exposed on any settings page — read and write them through the generic
settings API:

```
GET  /api/settings/<key>
PUT  /api/settings/<key>          body: { "value": "<string>" }
```

| Key | Default | What it does | When to touch it |
|---|---|---|---|
| `livetv_guide_days_past` / `livetv_guide_days_future` | `2` / `7` (days) | The guide retention window around "now". Programs outside it are dropped on ingest and pruned nightly. | Widen `_future` for a longer look-ahead guide; each extra day means more rows kept and re-ingested on every refresh. |
| `livetv_segment_seconds` | `2` (seconds) | Length of each live HLS segment Fliks packages when it isn't serving the provider's stream byte-for-byte. | Rarely; a shorter segment reaches the player sooner but adds more files to manage. |
| `livetv_timeshift_minutes` | `15` (minutes) | How far back the pause/rewind buffer reaches on a live channel. | Raise it to allow rewinding further back. Costs disk per open channel — roughly 528 KB per segment on a 2 Mbps channel. |
| `livetv_channel_idle_seconds` | `30` (seconds) | How long a channel session with no viewer left is kept warm, so switching back to it is instant. | Raise it if viewers often flip away and back within under a minute; lower it to free upstream connections sooner. |
| `livetv_probe_seconds` | `3` (seconds) | How wide a window ffmpeg gets to probe a new stream before Fliks gives up on it. | Raise it for a slow provider or a stream with a wide GOP — too narrow a probe and Fliks reports a working channel as dead. |
| `livetv_stale_stream_days` | `7` (days) | A stream absent from a sync for longer than this is deleted, along with anything only it fed. | Lower it if a flaky provider leaves stale entries you want cleared faster; raise it if a provider's sync drops channels that reappear a few days later. |
| `livetv_slot_release_seconds` | `15` (seconds) | How long a just-closed upstream connection still counts against the source's own **Max simultaneous streams** limit. | Raise it if you keep hitting "at capacity" errors right after closing a stream — it means the provider takes longer than this to actually free the slot. |
| `livetv_restricted_groups` | `[]` (JSON array) | The same list the access-control endpoints above read and write. | Use those endpoints instead; this key exists mainly so the value has somewhere to live. |
| `livetv_fast_zap` | unset | `"true"`/`"false"` override. Unset, Fliks only prefers a fast transcode start over a byte-exact copy where hardware encoding is actually available on the server, since that's the only case where it's free. | Set it explicitly to force one behavior regardless of hardware. |

## What won't work, and why

- **Wrong credentials or an unreachable host** — Test connection just says the test failed, with no
  detail. Save anyway (or wait for the scheduled sync) and the source's own sync error shows the
  real reason: an Xtream login answers with "authentication refused by the provider" on a bad
  username or password, a playlist URL reports a plain connection or timeout error.
- **An expired or suspended account** — Fliks doesn't check this for you. The account's own status
  and expiry date, once a sync has read them, are shown next to the source purely as information. If
  the account really stops working, streaming starts failing, or the next sync fails with the
  provider's own auth refusal — nothing here is enforced by Fliks itself.
- **An empty playlist** — on a source's very first sync, ending up with zero live channels is not an
  error; the source just has none. If the provider's playlist really is empty, that's confirmed by
  **Test connection** and there's nothing to fix on the Fliks side.
- **A sync that suddenly returns far fewer channels than before** (under half of what the source
  already had) is refused outright, and the previous lineup is kept untouched — that's treated as a
  provider rate limit or an error page mistaken for the real playlist, not your channels actually
  disappearing. The sync error explains why nothing changed; fix the underlying issue and sync
  again.
- **"has reached its limit of N simultaneous streams"** — the source's **Max simultaneous streams**
  cap is already fully used, including connections that only closed in the last
  `livetv_slot_release_seconds` seconds. Wait a moment, close another stream from that source, or
  raise the limit if the provider actually allows more than it's currently set to.
- **"Unable to start this channel."** — either the channel has no stream behind it left (every
  source that fed it was removed), or every stream it does have failed to open. Check the **Health**
  tab: it lists each channel's consecutive-failure count and, per stream, when it last actually
  worked and its last error.
