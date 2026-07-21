// Streaming / buffering / reconnect mpv options shared by every backend so the
// buffering + resume behaviour can't drift per platform. Single source of truth:
//   • Windows subprocess (mpv-player.ts) maps each to a `--name=value` CLI arg.
//   • Linux compositor (index.ts) + macOS in-process player (mac-mpv-player.ts)
//     apply each via the addon's `setProperty` right after start (all seven are
//     runtime-mutable and set before the first load, so this matches the addons'
//     former pre-init set_option_string exactly).
//
// Rationale for the tuning:
//   • Buffer like the web (Shaka) engine: ~30s forward (cache-secs is the binding
//     forward TIME cap — with cache=yes it otherwise defaults to ~unlimited and
//     overrides readahead-secs; the byte caps are a ceiling), ~96s back.
//   • Reconnect on failure: a slow transcode (HDR tonemap re-encode) isn't ready
//     when mpv opens seg-0/init, and a separate multi-audio rendition's transcode
//     can fail at the TRANSPORT layer (reset / refused / TLS) rather than with a
//     4xx/5xx status — so reconnect_on_network_error is needed alongside
//     reconnect_on_http_error. The `4xx,5xx` value carries a comma, so it uses
//     mpv's `%len%` escaping (7 = strlen("4xx,5xx")) to survive the key-value-list
//     parser.

export const MPV_STREAM_OPTIONS: readonly (readonly [name: string, value: string])[] = [
  ['cache', 'yes'],
  ['cache-secs', '30'],
  ['demuxer-readahead-secs', '30'],
  ['demuxer-max-bytes', '256MiB'],
  ['demuxer-max-back-bytes', '96MiB'],
  ['cache-pause-wait', '1'],
  [
    'demuxer-lavf-o',
    'reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_on_http_error=%7%4xx,5xx,reconnect_delay_max=5',
  ],
];
