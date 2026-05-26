# Changelog

## [1.7.1](https://github.com/fliks-app/fliks/compare/v1.7.0...v1.7.1) (2026-05-26)


### Features

* **activities:** auto-match orphan torrents + episode/season FKs ([#241](https://github.com/fliks-app/fliks/issues/241)) ([0aead51](https://github.com/fliks-app/fliks/commit/0aead5110c93467565c52c65a2af1b0d34824c3b))
* **auth:** refresh-token rotation for persistent native sessions ([#248](https://github.com/fliks-app/fliks/issues/248)) ([be2a7b8](https://github.com/fliks-app/fliks/commit/be2a7b888b628ae5b52a9363b185d32a350e6a42))
* **completion:** run cropdetect and subtitle warmup after grab import ([#222](https://github.com/fliks-app/fliks/issues/222)) ([252d65b](https://github.com/fliks-app/fliks/commit/252d65b9ff4bb86efb3a4e9b99a0c1499a0ea346))
* **library:** add watched / unwatched filter ([#224](https://github.com/fliks-app/fliks/issues/224)) ([8e196c5](https://github.com/fliks-app/fliks/commit/8e196c5a013549a2a5a880f060b25fd10e8aa7e1))
* **media-detail:** replace rescan menu entry with an analyse modal ([#225](https://github.com/fliks-app/fliks/issues/225)) ([af9343e](https://github.com/fliks-app/fliks/commit/af9343e6b242a092b0e179de7e74981e525da71e))
* **media:** log library imports and targeted search-missing counts ([#230](https://github.com/fliks-app/fliks/issues/230)) ([b2f3e15](https://github.com/fliks-app/fliks/commit/b2f3e151be5b188507ebbb5d052090f5a15c8a42))
* **release-parsing:** extractMediaTitle for orphan-torrent recovery ([#240](https://github.com/fliks-app/fliks/issues/240)) ([ed636da](https://github.com/fliks-app/fliks/commit/ed636daf265d11841e6ea9882cf49e28dbd08c1e))
* **subtitles:** centralised video-aware scoring (Bazarr-style) ([#234](https://github.com/fliks-app/fliks/issues/234)) ([dd7fc49](https://github.com/fliks-app/fliks/commit/dd7fc49ade2374b8d3a0cfebec32a42398ae0cc4))
* **subtitles:** circuit breaker on top of provider rate-limiter ([#237](https://github.com/fliks-app/fliks/issues/237)) ([59220b6](https://github.com/fliks-app/fliks/commit/59220b6d4e09abca2a42e7b74cb13fce4e6faeca))
* **subtitles:** defer upgrades on files that still have missing langs ([#233](https://github.com/fliks-app/fliks/issues/233)) ([3ec3f60](https://github.com/fliks-app/fliks/commit/3ec3f60dc8958fbee199410657d930a4bc7dd041))
* **subtitles:** per-language hearing-impaired enforcement ([#236](https://github.com/fliks-app/fliks/issues/236)) ([6febd09](https://github.com/fliks-app/fliks/commit/6febd0989b3b57c66a77f05209a6bdabada0c03a))
* **subtitles:** persist OSDb hash on MediaFile + hash-match invariant ([#235](https://github.com/fliks-app/fliks/issues/235)) ([41b82fe](https://github.com/fliks-app/fliks/commit/41b82fe9e9c9dacae6e31bba1bc01bd1a5333fbf))
* **thumbnail:** use VAAPI/QSV to accelerate sprite extraction ([#252](https://github.com/fliks-app/fliks/issues/252)) ([c1bbf05](https://github.com/fliks-app/fliks/commit/c1bbf0585e678ce8acd37451acb5a3c80e6c5215))
* **transcoding:** prefer HW-encodable codecs over source-codec match ([#257](https://github.com/fliks-app/fliks/issues/257)) ([d0dbdec](https://github.com/fliks-app/fliks/commit/d0dbdec3de5b318c3cd9cd0a6eb0e47d4dcc4adc))


### Bug Fixes

* **activities:** never unlink a media from its download history ([#238](https://github.com/fliks-app/fliks/issues/238)) ([590f093](https://github.com/fliks-app/fliks/commit/590f093321ed3b796a4acc7179a7943b748eec0e))
* **auto-grab:** hydrate series quality/language profiles in SearchMissing ([#227](https://github.com/fliks-app/fliks/issues/227)) ([e7aa1f3](https://github.com/fliks-app/fliks/commit/e7aa1f3762bcb26773a30db583a580b361fa1851))
* **auto-match:** run on empty grabbed + heal mediaId-NULL rows + match by originalTitle ([#242](https://github.com/fliks-app/fliks/issues/242)) ([1f6706f](https://github.com/fliks-app/fliks/commit/1f6706f51591cc215814bb463c346cff46cd69dd))
* **grab:** persist indexer on download-history rows from manual grabs ([#228](https://github.com/fliks-app/fliks/issues/228)) ([df4d4a1](https://github.com/fliks-app/fliks/commit/df4d4a1b8cc66e6a4cda901bbe111c7c3d967b27))
* **media-detail:** gate delete buttons on media.delete permission ([#220](https://github.com/fliks-app/fliks/issues/220)) ([5081449](https://github.com/fliks-app/fliks/commit/5081449f4b52a20c8d6c1d585e3218e6316d28f4))
* **media-info-header:** label letterboxed 1080p sources correctly ([#251](https://github.com/fliks-app/fliks/issues/251)) ([dbaa296](https://github.com/fliks-app/fliks/commit/dbaa296a6d318c8dc3835e5ad08538afcf950834))
* **media:** surface 4K releases in manual search ([#250](https://github.com/fliks-app/fliks/issues/250)) ([b75fa30](https://github.com/fliks-app/fliks/commit/b75fa3028aa4ef1ff37f9c66376393a50478bbd7))
* **player:** keep mobile play button slot during loading ([#255](https://github.com/fliks-app/fliks/issues/255)) ([2b17506](https://github.com/fliks-app/fliks/commit/2b17506fe714d7085cd8bf2d3fd46ada4391907a))
* **popover-menu:** keep options above &lt;dialog open&gt; top-layer ([#231](https://github.com/fliks-app/fliks/issues/231)) ([a1ac599](https://github.com/fliks-app/fliks/commit/a1ac599bf53deb961095771907c43f9f0b084f32))
* **quality:** share resolution bucketing across backend and client ([#256](https://github.com/fliks-app/fliks/issues/256)) ([5965f64](https://github.com/fliks-app/fliks/commit/5965f6479bbc91348bfa2bdc1af07b2711da7cf5))
* **seekbar:** revert track height on touch release ([#249](https://github.com/fliks-app/fliks/issues/249)) ([75d53d2](https://github.com/fliks-app/fliks/commit/75d53d2903fe8ec2f16961609517fc5de9959abf))
* **seekbar:** shrink sprite preview on phones + crop letterbox from tiles ([#254](https://github.com/fliks-app/fliks/issues/254)) ([857b796](https://github.com/fliks-app/fliks/commit/857b796bb00e736f6148590245c49f3fd3ca5710))
* **streaming:** emit av01.* CODECS for AV1 HLS variants ([#253](https://github.com/fliks-app/fliks/issues/253)) ([46d98f2](https://github.com/fliks-app/fliks/commit/46d98f2d23bd0ea3e71dca7249b2fcc31edf59c8))


### Miscellaneous Chores

* release 1.7.1 ([#223](https://github.com/fliks-app/fliks/issues/223)) ([452a0b1](https://github.com/fliks-app/fliks/commit/452a0b1a1cb2a0e453e4eb70d256b4b47024e2fc))

## [1.7.0](https://github.com/fliks-app/fliks/compare/v1.6.1...v1.7.0) (2026-05-24)


### Features

* **admin:** setup checklist widget (home + general settings) ([#179](https://github.com/fliks-app/fliks/issues/179)) ([ef05655](https://github.com/fliks-app/fliks/commit/ef056559741ce4520ceca34f025e6319d5b358f3))
* **app-settings:** display page with home background toggle ([#181](https://github.com/fliks-app/fliks/issues/181)) ([5f34603](https://github.com/fliks-app/fliks/commit/5f34603794f836fbf040515798f3e584e263cecf))
* **home:** lift setup checklist out of the TV section wrapper ([#190](https://github.com/fliks-app/fliks/issues/190)) ([6f7ac92](https://github.com/fliks-app/fliks/commit/6f7ac920c8639caf36386961c12da02676b59d87))
* **home:** two-pass SWR refresh on app open ([#200](https://github.com/fliks-app/fliks/issues/200)) ([4922f56](https://github.com/fliks-app/fliks/commit/4922f56e1e38d20292a76c1d9eaaad323c222fe1))
* **imports:** disk import copies/moves into Fliks-managed libraries ([#184](https://github.com/fliks-app/fliks/issues/184)) ([cff3458](https://github.com/fliks-app/fliks/commit/cff34584c2c4408bb57326edaa6b6a5d5727d93b))
* **imports:** require an existing target library for Radarr/Sonarr ([#183](https://github.com/fliks-app/fliks/issues/183)) ([d2aa06e](https://github.com/fliks-app/fliks/commit/d2aa06e63f0e5764542352959800efd11e81b133))
* **media-detail:** global page background + condensed season actions ([#174](https://github.com/fliks-app/fliks/issues/174)) ([e541199](https://github.com/fliks-app/fliks/commit/e54119901a551c4dc2bdd83f7a0961b7de6f31c2))
* **media:** per-season posters + random fanart pool on detail/home ([#176](https://github.com/fliks-app/fliks/issues/176)) ([097b745](https://github.com/fliks-app/fliks/commit/097b745105eb23362b96543c76ab776d3ff18cf5))
* **nav:** keyboard nav polish — focus opt-out, input boundary escape, popover sizing ([#197](https://github.com/fliks-app/fliks/issues/197)) ([72f0cb3](https://github.com/fliks-app/fliks/commit/72f0cb3cdf641446938c699fe6b15d8cbbc62215))
* **nav:** keyboard spatial navigation on desktop / laptop too ([#196](https://github.com/fliks-app/fliks/issues/196)) ([020f191](https://github.com/fliks-app/fliks/commit/020f19105513d6050cae57261fcb2867a971db3b))
* **pagination, subtitles:** ellipsis pagination + treat disk subs as trusted ([#182](https://github.com/fliks-app/fliks/issues/182)) ([d14eb7b](https://github.com/fliks-app/fliks/commit/d14eb7b3390ad247dcf174fe556c796cf19867f6))
* **player:** episode still as backdrop + progressive load + CW thumbnails ([#195](https://github.com/fliks-app/fliks/issues/195)) ([73b5aff](https://github.com/fliks-app/fliks/commit/73b5affe48df9d68e7d47502e120b24e69f11ab1))
* **pwa:** auto-reload when the service worker has a new version ready ([#202](https://github.com/fliks-app/fliks/issues/202)) ([8cdde73](https://github.com/fliks-app/fliks/commit/8cdde7364b9201db0af00a4251af96258e2d3685))
* **requests:** lifecycle hooks + immediate auto-grab + post-import marker detection ([942cc1a](https://github.com/fliks-app/fliks/commit/942cc1ab2078a73d8a28a32886d9c54cded71c27))
* **requests:** unique-per-user, profile-aware auto-approval, lifecycle hooks ([15ad61c](https://github.com/fliks-app/fliks/commit/15ad61c979fd34e3f0088439a91e16685d92983b))
* **search:** refocus input + reopen keyboard on same-route nav click ([#177](https://github.com/fliks-app/fliks/issues/177)) ([ef10dac](https://github.com/fliks-app/fliks/commit/ef10daced7291ff7e2cfca70e3e692e24ec71a15))
* **tmdb-preview:** align ui with media-detail (back button, page-wide fanart, breakpoint) ([63c0c4e](https://github.com/fliks-app/fliks/commit/63c0c4e5b67c651be11d67eb761711cdc3b170f9))
* **ui:** TV polish — focus lock, transient admin drawer, denser cards ([#199](https://github.com/fliks-app/fliks/issues/199)) ([abe528d](https://github.com/fliks-app/fliks/commit/abe528d242940a23d31f67c893adca16bd02219e))


### Bug Fixes

* **activity, media-detail:** show indexer on queue rows + drop duplicate grab toast ([#189](https://github.com/fliks-app/fliks/issues/189)) ([970f900](https://github.com/fliks-app/fliks/commit/970f900cf076d365793d399d86f95f660b8d68db))
* **admin-streams:** pass episodeId when reading playback state ([#178](https://github.com/fliks-app/fliks/issues/178)) ([ab4e733](https://github.com/fliks-app/fliks/commit/ab4e73339085b686395b59d2ff41675f67326efa))
* **android:** enable edge-to-edge on Android ≤ 14 ([#192](https://github.com/fliks-app/fliks/issues/192)) ([c1b76be](https://github.com/fliks-app/fliks/commit/c1b76be6bb43b63895c768ec1317f8f301b1365e))
* **data-imports:** wizard option uses lib.id (typo from rename) ([#186](https://github.com/fliks-app/fliks/issues/186)) ([3eb2fab](https://github.com/fliks-app/fliks/commit/3eb2fab3229b61fbf9539be98bad3794a454edd0))
* **imports:** write addedBy via the relation instead of the @RelationId ([#201](https://github.com/fliks-app/fliks/issues/201)) ([abf62f7](https://github.com/fliks-app/fliks/commit/abf62f73e4beeb471ae4fd5c430455e580cb2fbe))
* **ios:** anchor subtitle to container bottom, not safe area ([#214](https://github.com/fliks-app/fliks/issues/214)) ([804ae89](https://github.com/fliks-app/fliks/commit/804ae89f7b53d3400b851680eea983eba0002e3b))
* **ios:** drop A/V desync race on resume + harden load() ([#210](https://github.com/fliks-app/fliks/issues/210)) ([ad0209a](https://github.com/fliks-app/fliks/commit/ad0209a70703c9fb175a8fac4c4b9e21832ab9a7))
* **ios:** suppress accidental focus / zoom / native-select pop-ups ([#216](https://github.com/fliks-app/fliks/issues/216)) ([fed5958](https://github.com/fliks-app/fliks/commit/fed5958b7f8d02205227b09415a22c716e9ea654))
* **ios:** wait for AVPlayer seek completion before resolving seek() ([#211](https://github.com/fliks-app/fliks/issues/211)) ([de25cef](https://github.com/fliks-app/fliks/commit/de25cef9c5c9df19e99b4a221c19028662e4362d))
* **macos-dmg:** patch info.plist with the release version before building ([f6fc4f6](https://github.com/fliks-app/fliks/commit/f6fc4f632c02ba1a3fbdc72b6f5a418bb419f143))
* **media-info-header:** round the title anchor's focus ring ([4d63083](https://github.com/fliks-app/fliks/commit/4d6308330a9e23a033a98f069a9c06e83e7f83c2))
* **navigation:** library tabs out of history, player back always exits ([#191](https://github.com/fliks-app/fliks/issues/191)) ([5ba2873](https://github.com/fliks-app/fliks/commit/5ba28738b150fcd4c8bb4fe9125b3eeb3f48cfa4))
* **player:** restore "back hides controls first" only on TV ([#194](https://github.com/fliks-app/fliks/issues/194)) ([d979212](https://github.com/fliks-app/fliks/commit/d9792124c2e5aaef34c33125830a0a2562b197c8))
* **player:** seekbar polish + suppress native long-press selection ([#213](https://github.com/fliks-app/fliks/issues/213)) ([fc3ce15](https://github.com/fliks-app/fliks/commit/fc3ce1515cebd58911e1b197f3da93f4757c88b9))
* **popover-menu:** clipping / top-layer / focus polish for in-modal usage ([7d720d5](https://github.com/fliks-app/fliks/commit/7d720d5bb0c6632d351d8a817452ebb8504d0cdc))
* **qbittorrent:** follow indexer redirects manually + handle magnet target ([#188](https://github.com/fliks-app/fliks/issues/188)) ([80bd14e](https://github.com/fliks-app/fliks/commit/80bd14e48c114a6abf81612c431819277ab7ed5d))
* **settings:** correct /medias/movies placeholder in library path input ([#187](https://github.com/fliks-app/fliks/issues/187)) ([cae41d1](https://github.com/fliks-app/fliks/commit/cae41d1c04e1bfd13307fb0e85416157c1fa6917))
* **streaming:** map audio by absolute stream index (PGS-heavy remux fix) ([#198](https://github.com/fliks-app/fliks/issues/198)) ([ba6c430](https://github.com/fliks-app/fliks/commit/ba6c4304577db2b0fb34dfe3d6162ea9e8ee4102))
* **tv:** fanart visible through veils on Chromium-85 builds ([#193](https://github.com/fliks-app/fliks/issues/193)) ([a90b1bd](https://github.com/fliks-app/fliks/commit/a90b1bd9796622a35b4e1afff6f4d28971844f59))
* **ui:** media-detail polish, spatial-nav rework, watched-toggle rollout ([e86da5c](https://github.com/fliks-app/fliks/commit/e86da5ce29e63959928dede2d403bd14f633d3a0))
* **ui:** recover the 15 commits that never reached pr [#203](https://github.com/fliks-app/fliks/issues/203) ([5688434](https://github.com/fliks-app/fliks/commit/56884346a8469168c06b9f94a6042817814dd8e2))

## [1.6.1](https://github.com/fliks-app/fliks/compare/v1.6.0...v1.6.1) (2026-05-21)


### Bug Fixes

* **streaming:** force-transcode MP3 audio when remuxing to fMP4 (v1.6.1) ([#171](https://github.com/fliks-app/fliks/issues/171)) ([2e4fb07](https://github.com/fliks-app/fliks/commit/2e4fb07a73054d32aeb5b8b0742c3ee88b87edb5))
* **streaming:** retryable transient errors for HLS live transcoding ([#173](https://github.com/fliks-app/fliks/issues/173)) ([ac41541](https://github.com/fliks-app/fliks/commit/ac41541cba5e5934dd4d0c91ac616321e5f37c03))

## [1.6.0](https://github.com/fliks-app/fliks/compare/v1.5.1...v1.6.0) (2026-05-20)


### Features

* **blocklist:** show note and indexer in blocklist view ([#116](https://github.com/fliks-app/fliks/issues/116)) ([d90cb62](https://github.com/fliks-app/fliks/commit/d90cb628012dc60eebae9c63870e5a251bbc5fc7))
* **cast:** forward receiver errors to the sender's toast layer ([#69](https://github.com/fliks-app/fliks/issues/69)) ([997db40](https://github.com/fliks-app/fliks/commit/997db40fe519f4ff79d0525be4d610c305636d5a))
* **cast:** probe receiver MSE caps; AC-3 5.1 surround path; HLS-TS for AAC stereo ([#94](https://github.com/fliks-app/fliks/issues/94)) ([c24ee3b](https://github.com/fliks-app/fliks/commit/c24ee3bf03c23316976ed29c3a2055c0ca05e86d))
* **collections:** TMDB collection grouping in library ([#118](https://github.com/fliks-app/fliks/issues/118)) ([a537320](https://github.com/fliks-app/fliks/commit/a5373209c8c975623fa0c9ef9f39de9670afea46))
* **docker:** build linux/arm64 image for Apple Silicon + ARM NAS ([#124](https://github.com/fliks-app/fliks/issues/124)) ([c3fc0df](https://github.com/fliks-app/fliks/commit/c3fc0df4966e5eab68c0f0c8b17c84a9b62d6f70))
* **home:** show missing-files cross on unavailable recommendations ([#152](https://github.com/fliks-app/fliks/issues/152)) ([b66c2e0](https://github.com/fliks-app/fliks/commit/b66c2e0104955950a4240f30795033e366dc84e0))
* **i18n:** localize audio/subtitle track labels everywhere ([#88](https://github.com/fliks-app/fliks/issues/88)) ([012310f](https://github.com/fliks-app/fliks/commit/012310f81e0cc109e918d9fb3b4d64fd4c9cecb3))
* **indexers:** per-indexer rate limit + 429/Retry-After + backoff ([#164](https://github.com/fliks-app/fliks/issues/164)) ([7f2549c](https://github.com/fliks-app/fliks/commit/7f2549cea2e3302c0e7e59405ed9cea89b941303))
* **library:** Genres tab, history-aware tab navigation, layout polish ([#104](https://github.com/fliks-app/fliks/issues/104)) ([e123894](https://github.com/fliks-app/fliks/commit/e12389493338119a1a876e55f6ae54eec6b0593b))
* **library:** redesign toolbar — view tabs, sort+order, filter dropdown ([#102](https://github.com/fliks-app/fliks/issues/102)) ([a6a460d](https://github.com/fliks-app/fliks/commit/a6a460d12e4a011f28640d3f69d8a7faa1d27b23))
* **library:** Suggestions tab — continue-watching + history-based recommendations ([#103](https://github.com/fliks-app/fliks/issues/103)) ([c9a6274](https://github.com/fliks-app/fliks/commit/c9a627413b162ac4fae00d1365eabc69f85a951b))
* **macos:** bake TMDB/TVDB API keys at build time ([#127](https://github.com/fliks-app/fliks/issues/127)) ([9933413](https://github.com/fliks-app/fliks/commit/9933413b19c8ed34f4be169823dd3676c1cfb493))
* **macos:** native app with VideoToolbox hwaccel + DMG build pipeline ([#125](https://github.com/fliks-app/fliks/issues/125)) ([41af462](https://github.com/fliks-app/fliks/commit/41af462e5cae4983592a99a516517d5ec2825e86))
* **media-detail:** make genres clickable, navigate to library with genre filter ([#114](https://github.com/fliks-app/fliks/issues/114)) ([c045a64](https://github.com/fliks-app/fliks/commit/c045a6435ea9d9313bf86e42a07f88abcc9853a8))
* **media-detail:** TMDB info panel + header refactor ([#101](https://github.com/fliks-app/fliks/issues/101)) ([cd908b4](https://github.com/fliks-app/fliks/commit/cd908b48ba56b4c4fb9059ba645f5cc5040d7a42))
* **media:** track adder on Media + surface missing files on cards ([#78](https://github.com/fliks-app/fliks/issues/78)) ([37c07e5](https://github.com/fliks-app/fliks/commit/37c07e53a611451bc540d9797af52a7319d79c5f))
* **releases:** indexer caps detection, mobile modal layout, cache fix ([#115](https://github.com/fliks-app/fliks/issues/115)) ([544ef26](https://github.com/fliks-app/fliks/commit/544ef26760e56fe98a926a9d7dc31455c4d79dbf))
* **releases:** polish search results + UI ([#166](https://github.com/fliks-app/fliks/issues/166)) ([ec7eb68](https://github.com/fliks-app/fliks/commit/ec7eb6821a4696eb169c84fb2351f8e1706ecaa9))
* **rss-sync:** handle series, prefer season packs over single episodes ([#99](https://github.com/fliks-app/fliks/issues/99)) ([2781c47](https://github.com/fliks-app/fliks/commit/2781c4758738766d95471c58bfc5f5602792e38a))
* **scheduler:** targeted SearchMissing restart on stalled torrent ([#117](https://github.com/fliks-app/fliks/issues/117)) ([014409d](https://github.com/fliks-app/fliks/commit/014409d2c868df77002ae9249eae47115e245cd5))
* **search:** unify missing + cutoff-unmet rules across manual, auto and library ([#81](https://github.com/fliks-app/fliks/issues/81)) ([27719fc](https://github.com/fliks-app/fliks/commit/27719fcc969162be5964742fbb933cd8eb4eb4c6))
* **streaming:** admin-selectable HDR→SDR tone-mapping + opencl probe ([#144](https://github.com/fliks-app/fliks/issues/144)) ([5f670a1](https://github.com/fliks-app/fliks/commit/5f670a1c9313e2eb269ef8bdaf1f2760ff9d99c5))
* **streaming:** codec refactor + decoder registry + vpp_qsv tonemap ([b0288ba](https://github.com/fliks-app/fliks/commit/b0288bad5815b98d2dca259c840326b28a775c5e))
* **streaming:** HDR pass-through via HEVC remux variant ([#133](https://github.com/fliks-app/fliks/issues/133)) ([6a82f60](https://github.com/fliks-app/fliks/commit/6a82f60d11c0aa1c4e1192a8d3ece42b5bbdaa9b))
* **transcode:** hardware HDR tonemap via scale_vt on macOS ([#130](https://github.com/fliks-app/fliks/issues/130)) ([967d561](https://github.com/fliks-app/fliks/commit/967d5618e1c511c956bd35dcd0ab0fcf8605bffb))
* **tv:** tvPlatform signal + Tizen/webOS build pipelines + downloads-off-on-TV ([#60](https://github.com/fliks-app/fliks/issues/60)) ([269950a](https://github.com/fliks-app/fliks/commit/269950adc74fda8c9feba7790442e5e21018bcc4))


### Bug Fixes

* 2 s audio echo at rotation seam + media-card badge z-index ([#105](https://github.com/fliks-app/fliks/issues/105)) ([bc2734b](https://github.com/fliks-app/fliks/commit/bc2734bb3585d5a78324b9da90eedaf552adca91))
* **admin:** pass mediaId (not mediaFileId) to getState in streams view ([#72](https://github.com/fliks-app/fliks/issues/72)) ([38938ad](https://github.com/fliks-app/fliks/commit/38938ada56fcbbe2bd5c5a7c8b3a34bbaf514dc7))
* **auth:** unblock login spinner stuck on IDB cache wipe after server switch ([#98](https://github.com/fliks-app/fliks/issues/98)) ([65802e4](https://github.com/fliks-app/fliks/commit/65802e41ef965f9a442bce041b3a6f29bdd1d24b))
* **cache:** wipe server-data caches on logout / switch user / switch server ([#89](https://github.com/fliks-app/fliks/issues/89)) ([3398cfa](https://github.com/fliks-app/fliks/commit/3398cfa124906818391a79bb78a71438fcd421be))
* **cast-receiver:** drop customNamespaces declaration, let addCustomMessageListener auto-register ([#95](https://github.com/fliks-app/fliks/issues/95)) ([9a9974c](https://github.com/fliks-app/fliks/commit/9a9974cc9a6bba9afceeccea7600729bd8345f74))
* **cast:** codec drift respawn + H.264 level fix + cast profile pi from player ([#149](https://github.com/fliks-app/fliks/issues/149)) ([48d2327](https://github.com/fliks-app/fliks/commit/48d232778fb6b42ca7fa1214f577c59bb4c69e71))
* **cast:** drop custom Shaka tuning, use CAF defaults ([#68](https://github.com/fliks-app/fliks/issues/68)) ([a2b6f99](https://github.com/fliks-app/fliks/commit/a2b6f990d16dddc0fb47c9923afd2212016b20df))
* **cast:** drop receiver custom message bus that broke Android sessions ([#71](https://github.com/fliks-app/fliks/issues/71)) ([c1c7de4](https://github.com/fliks-app/fliks/commit/c1c7de4a407d103757562260a555d92a3d85c258))
* **cast:** stop backend session when the cast session drops ([#75](https://github.com/fliks-app/fliks/issues/75)) ([bea6f5f](https://github.com/fliks-app/fliks/commit/bea6f5fa58db717a0220dc334061f20fb70cbf71))
* **collections:** explicit column types + min 2 items filter ([#119](https://github.com/fliks-app/fliks/issues/119)) ([e3c2e00](https://github.com/fliks-app/fliks/commit/e3c2e00dda0c30250f35f7f65d59ec67c16bc5aa))
* **grab:** season grab actually grabs a pack — and uses original title ([#167](https://github.com/fliks-app/fliks/issues/167)) ([4b5e518](https://github.com/fliks-app/fliks/commit/4b5e5183015b58bde55ab3db031c7a0b1b25c7c8))
* **hdr:** detect HDR by transfer function, not bit depth ([#122](https://github.com/fliks-app/fliks/issues/122)) ([494daa8](https://github.com/fliks-app/fliks/commit/494daa88d9dd4d566dc9ca5985ada83236966b85))
* **home:** show play button on Continue Watching cards ([#169](https://github.com/fliks-app/fliks/issues/169)) ([9bc8dcd](https://github.com/fliks-app/fliks/commit/9bc8dcda3b5d46beeb81c5600bebac5624087d47))
* **horizontal-scroller:** hide arrows when content fits without scroll ([#93](https://github.com/fliks-app/fliks/issues/93)) ([6eaff08](https://github.com/fliks-app/fliks/commit/6eaff08546ba564978344b2daf35468b557bd692))
* **indexers:** query Torznab with original title (Radarr/Sonarr-style) ([#163](https://github.com/fliks-app/fliks/issues/163)) ([10a5f7c](https://github.com/fliks-app/fliks/commit/10a5f7cd307bc6e017652d3bd3dd63ba96093dd3))
* **macos:** HDR tonemap on VideoToolbox — full Metal pipeline + build script overwrite fix ([#153](https://github.com/fliks-app/fliks/issues/153)) ([a70b7bc](https://github.com/fliks-app/fliks/commit/a70b7bcabecc32fd3eb558edb4293233ace5feb5))
* **macos:** PG extension libs, backend logs, initdb share dir ([#126](https://github.com/fliks-app/fliks/issues/126)) ([2ec54cf](https://github.com/fliks-app/fliks/commit/2ec54cf8b973deb90e94fff1f8a4f7f8cc87dfcd))
* **media-detail:** hide Grab + Search-releases when not actionable ([#85](https://github.com/fliks-app/fliks/issues/85)) ([b581d4e](https://github.com/fliks-app/fliks/commit/b581d4e4ed947f37f3bf35fdf4c75e5b49dcbbc3))
* **media-detail:** show Grab/Search releases on episode header ([#165](https://github.com/fliks-app/fliks/issues/165)) ([76c90be](https://github.com/fliks-app/fliks/commit/76c90be4369740b7f1c66a0da7ed09fe4ddf6d4b))
* **media:** use upper-bound ceilings on both axes for resolution detection ([#79](https://github.com/fliks-app/fliks/issues/79)) ([146924d](https://github.com/fliks-app/fliks/commit/146924d09f4743380fb6b15875fbf294527f6562))
* **mobile:** keep player controls while a panel is up; never minimise on back ([#91](https://github.com/fliks-app/fliks/issues/91)) ([03829ea](https://github.com/fliks-app/fliks/commit/03829ea6a785fb49a8f452efeeb36c04841f292e))
* **nav:** mirror browser back/forward on the in-app history stack ([#80](https://github.com/fliks-app/fliks/issues/80)) ([7d601b8](https://github.com/fliks-app/fliks/commit/7d601b870656cc2dc44a646c963f6b493835cde8))
* **nav:** suppress back-arrow flash on first dock click ([#86](https://github.com/fliks-app/fliks/issues/86)) ([065c215](https://github.com/fliks-app/fliks/commit/065c215bae731bb8666d7529f484a2a8ce82d4a2))
* **playback:** FK race + propagate episode watched toggle ([#121](https://github.com/fliks-app/fliks/issues/121)) ([fec5dc3](https://github.com/fliks-app/fliks/commit/fec5dc3f18d178cce775b85b5fefbf48597a66f9))
* **player:** Android cold-prepare stall + BT.709 SDR tagging + codec level ([#143](https://github.com/fliks-app/fliks/issues/143)) ([3dfc492](https://github.com/fliks-app/fliks/commit/3dfc49292feb14846258b4ab338a6680cdfd3bdb))
* **player:** audio label now matches media-detail; tighten header rows ([#90](https://github.com/fliks-app/fliks/issues/90)) ([db49ad7](https://github.com/fliks-app/fliks/commit/db49ad7cb48b5fbcdeeab72a958a175b9aaee885))
* **player:** fallback firstFrame on Android when onRenderedFirstFrame stalls ([#142](https://github.com/fliks-app/fliks/issues/142)) ([8021862](https://github.com/fliks-app/fliks/commit/802186214fac6d09bd3ab9b0607f57cb6285e94d))
* **player:** hide controls by default on native + tighter mobile bottom bar ([#108](https://github.com/fliks-app/fliks/issues/108)) ([140ae66](https://github.com/fliks-app/fliks/commit/140ae66530da4f92b6eebf9a04d6dccd1ef1daba))
* **player:** hide PiP button when permission is revoked on Android/iOS ([#110](https://github.com/fliks-app/fliks/issues/110)) ([901d562](https://github.com/fliks-app/fliks/commit/901d562489ed9ef4101f9d088c57067d7707ebb5))
* **player:** increase subtitle lift when controls are visible to 10% ([#113](https://github.com/fliks-app/fliks/issues/113)) ([f50287e](https://github.com/fliks-app/fliks/commit/f50287ea4295ea437ce24a85ac0b45ee997d64e8))
* **player:** iOS spinner, ABR freezes, HDR -12927 ([#132](https://github.com/fliks-app/fliks/issues/132)) ([93e5fb2](https://github.com/fliks-app/fliks/commit/93e5fb23f5835820aa4945d9bd51696a37bff602))
* **player:** keep mobile play/seek buttons above the bottom bar ([#73](https://github.com/fliks-app/fliks/issues/73)) ([bf7e459](https://github.com/fliks-app/fliks/commit/bf7e459c8dc73ce99ae32de689f5fe7966093550))
* **player:** no HDR brightness when tonemapping to SDR ([#120](https://github.com/fliks-app/fliks/issues/120)) ([3ec25c5](https://github.com/fliks-app/fliks/commit/3ec25c5358575ca1a5b3fb7465286c05b04ea1a2))
* **player:** pin master to picked rung + keep audio index on engine switch ([#157](https://github.com/fliks-app/fliks/issues/157)) ([9d8f7d1](https://github.com/fliks-app/fliks/commit/9d8f7d15524eef3814ae283cf47eb68df9ad2385))
* **player:** reapply native subtitle style on orientation change ([#112](https://github.com/fliks-app/fliks/issues/112)) ([0ed3da5](https://github.com/fliks-app/fliks/commit/0ed3da5b219ce026de72e57a1e90df82ddd21e15))
* **player:** Tizen AVPlay stability + cross-platform polish ([#162](https://github.com/fliks-app/fliks/issues/162)) ([ba387ff](https://github.com/fliks-app/fliks/commit/ba387ff9fe56ccafa81d8123b92b3d2564b563f6))
* **qbittorrent:** decode HTML entities in torrent names ([#168](https://github.com/fliks-app/fliks/issues/168)) ([e220c68](https://github.com/fliks-app/fliks/commit/e220c68841c99aed145f0d3911887958ecffd867))
* **search:** capture torrentHash + grabSource on auto-grab DownloadHistory ([#82](https://github.com/fliks-app/fliks/issues/82)) ([67d6126](https://github.com/fliks-app/fliks/commit/67d61262d39902de68e56da901df4b7b24640015))
* **search:** filter Torznab results by show title + use external IDs ([#92](https://github.com/fliks-app/fliks/issues/92)) ([49b50a3](https://github.com/fliks-app/fliks/commit/49b50a31aaf2c08b4ba5991d7bf27c44cb134b18))
* **streaming:** align A/V tfdt on resume with -output_ts_offset ([#67](https://github.com/fliks-app/fliks/issues/67)) ([8850655](https://github.com/fliks-app/fliks/commit/8850655aa4e55bcc12ac20719a30435a1e3739e0))
* **streaming:** audit follow-ups red + orange priority ([#136](https://github.com/fliks-app/fliks/issues/136)) ([b2b8011](https://github.com/fliks-app/fliks/commit/b2b8011ada819ef73e2be6e9fb8f87bfd4b0ded9))
* **streaming:** audit round 2 — dead code + AV1 NVENC HDR crop + scale unification ([#138](https://github.com/fliks-app/fliks/issues/138)) ([11f3680](https://github.com/fliks-app/fliks/commit/11f3680a23756a0f1c57cee73c86e86f0a5e9dbb))
* **streaming:** correct HEVC level in HDR master CODECS for cropped 4K ([#154](https://github.com/fliks-app/fliks/issues/154)) ([42cf02b](https://github.com/fliks-app/fliks/commit/42cf02bbfdc8e70de7b5fa53c7b0839787620e2a))
* **streaming:** emit FRAME-RATE on HDR variants (AVPlayer requires it) ([#155](https://github.com/fliks-app/fliks/issues/155)) ([d2af811](https://github.com/fliks-app/fliks/commit/d2af81173ef7441bf800fcedbdca2a8e10a039f3))
* **streaming:** honour tonemapAlgo when crop + tonemap are both active ([#145](https://github.com/fliks-app/fliks/issues/145)) ([f8d133c](https://github.com/fliks-app/fliks/commit/f8d133cb36de5bc3a162d68f4c4326489bcfb6bb))
* **streaming:** libsvtav1 needs maxrate &gt; b:v under random-access mode ([#150](https://github.com/fliks-app/fliks/issues/150)) ([3e2151b](https://github.com/fliks-app/fliks/commit/3e2151bd953a9bb60cb4ac5258b56712aa5dead5))
* **streaming:** preserve source aspect in QSV scale output ([#159](https://github.com/fliks-app/fliks/issues/159)) ([9409fe1](https://github.com/fliks-app/fliks/commit/9409fe1f95a59162e5515f0bc58c933d3501c4e5))
* **streaming:** probe tonemap_opencl with crop chain too ([#146](https://github.com/fliks-app/fliks/issues/146)) ([bbf931e](https://github.com/fliks-app/fliks/commit/bbf931e07ea9305812b5f07f82ea0689a7effd0e))
* **streaming:** remove 4-session transcoding limit ([#111](https://github.com/fliks-app/fliks/issues/111)) ([8d94aa7](https://github.com/fliks-app/fliks/commit/8d94aa7f905cf426a19a7e22ab7cf634a6e199e9))
* **streaming:** revert hls +temp_file — broke seek-resume init.mp4 ([#141](https://github.com/fliks-app/fliks/issues/141)) ([82f69f3](https://github.com/fliks-app/fliks/commit/82f69f3ff195af1fa35040c41c51c80e0199cfcf))
* **streaming:** rotate ffmpeg by content seconds, not segment count ([#76](https://github.com/fliks-app/fliks/issues/76)) ([d9b5012](https://github.com/fliks-app/fliks/commit/d9b501269aa7bb2aa63a42a85026ee6abea0952f))
* **streaming:** rotate QSV encoder periodically to dodge BRC drift ([#70](https://github.com/fliks-app/fliks/issues/70)) ([342b77a](https://github.com/fliks-app/fliks/commit/342b77afecac1497b906518324531b0ee3d63859))
* **streaming:** serve audio init from var_stream_map on resume ([#65](https://github.com/fliks-app/fliks/issues/65)) ([2837bbf](https://github.com/fliks-app/fliks/commit/2837bbf0ff31de88a0fb56e483fb44e3c1c4b98d))
* **transcode:** drop H.264 level 4.0 constraint on VideoToolbox ([#131](https://github.com/fliks-app/fliks/issues/131)) ([983900b](https://github.com/fliks-app/fliks/commit/983900ba5263319583d0a83253f75b9dcb73cf13))
* **transcode:** fix CPU tonemap chain — drop colorspace filter ([#129](https://github.com/fliks-app/fliks/issues/129)) ([aca6a98](https://github.com/fliks-app/fliks/commit/aca6a984fe2e788fcc2ad63521863a39398edac9))
* **transcode:** move -output_ts_offset after -i to kill 2 s repeat at rotation seam ([#100](https://github.com/fliks-app/fliks/issues/100)) ([849dfcf](https://github.com/fliks-app/fliks/commit/849dfcfa69faf36a46564b8ef57c6704e7d2632b))
* **transcode:** preserve source PTS on every spawn, drop hls_init_time ([#107](https://github.com/fliks-app/fliks/issues/107)) ([b17f409](https://github.com/fliks-app/fliks/commit/b17f409eb9d5ca40f3d29ee89be61b2a837393a8))
* **transcode:** replace zscale tonemap chain with format+colorspace ([#128](https://github.com/fliks-app/fliks/issues/128)) ([d6d3407](https://github.com/fliks-app/fliks/commit/d6d3407db7f3f67bc572982ee8c35a91225ae9cb))
* **transcode:** stable long-running QSV + sample-accurate seek-resume ([#106](https://github.com/fliks-app/fliks/issues/106)) ([051199b](https://github.com/fliks-app/fliks/commit/051199b9dd21d474bfffbd577bd62bc047a54876))
* **transcode:** use hybrid seek on encoder rotation to keep A/V in sync ([#87](https://github.com/fliks-app/fliks/issues/87)) ([e0ea914](https://github.com/fliks-app/fliks/commit/e0ea914570fecc88ec70dceb65bcbc0fc38d693a))


### Performance Improvements

* **client:** multi-platform fixes (web + iOS + Android + TV) ([#140](https://github.com/fliks-app/fliks/issues/140)) ([9e2269d](https://github.com/fliks-app/fliks/commit/9e2269dcd60816634363aca576a5d1622c130104))
* **streaming:** atomic segments via hls temp_file + drop redundant fallback poll ([#139](https://github.com/fliks-app/fliks/issues/139)) ([7f0036c](https://github.com/fliks-app/fliks/commit/7f0036c9f90a16d3197bbe077e561b311c6508ff))

## [1.5.1](https://github.com/fliks-app/fliks/compare/v1.5.0...v1.5.1) (2026-05-06)


### Features

* **cast:** wire audio track switch through native Cast plugin ([#56](https://github.com/fliks-app/fliks/issues/56)) ([846fdf6](https://github.com/fliks-app/fliks/commit/846fdf651c4b4eb5e85a2ade63a77b2307214f04))


### Bug Fixes

* **cast:** align HLS playlist with hls_init_time + tune Shaka receiver ([#57](https://github.com/fliks-app/fliks/issues/57)) ([ed7cbe5](https://github.com/fliks-app/fliks/commit/ed7cbe5e651c2743a9b2ad4f37471e810ae71ba2))


### Miscellaneous Chores

* release as 1.5.1 ([#59](https://github.com/fliks-app/fliks/issues/59)) ([5560aad](https://github.com/fliks-app/fliks/commit/5560aad34a8c565c4ceae8fe5d916d1b13a4561f))

## [1.5.0](https://github.com/fliks-app/fliks/compare/v1.4.0...v1.5.0) (2026-05-05)


### Features

* **cast:** audio rendition switch via custom message bus ([#41](https://github.com/fliks-app/fliks/issues/41)) ([d63ec02](https://github.com/fliks-app/fliks/commit/d63ec02816f66fbefab73d4798eafbfcf8edb2ba))
* **cast:** client-side audio switch + faster startup + cleaner labels ([#50](https://github.com/fliks-app/fliks/issues/50)) ([379e804](https://github.com/fliks-app/fliks/commit/379e8043e1eac53bd933b225f6d3d0d09e6533eb))
* **cast:** expose Shaka audio renditions as CAF tracks ([#46](https://github.com/fliks-app/fliks/issues/46)) ([59bc4cf](https://github.com/fliks-app/fliks/commit/59bc4cfcb8f00388cff47eb14b44a1ebfa8d0471))


### Bug Fixes

* **cast:** add Shaka error surfacing to the receiver ([#39](https://github.com/fliks-app/fliks/issues/39)) ([c6bf4ab](https://github.com/fliks-app/fliks/commit/c6bf4abeae3a1075cf9a68f49800496d1285a2ad))
* **cast:** broadcast media-info update so senders see audio tracks ([#47](https://github.com/fliks-app/fliks/issues/47)) ([3be7529](https://github.com/fliks-app/fliks/commit/3be7529100d02bba2e2c28a78c56a39ce59a16c6))
* **cast:** cap quality dropdown by user's Cast maxQuality setting ([#53](https://github.com/fliks-app/fliks/issues/53)) ([a7b3ebd](https://github.com/fliks-app/fliks/commit/a7b3ebd856dfa20fd9971bc931ab282706d16b54))
* **cast:** handle audio-switch msg as STRING namespace ([#43](https://github.com/fliks-app/fliks/issues/43)) ([3d650c3](https://github.com/fliks-app/fliks/commit/3d650c36f3a13ff48499ca6c8e3243b9404aaa23))
* **cast:** register audio msg listener after context.start ([#44](https://github.com/fliks-app/fliks/issues/44)) ([62d99a4](https://github.com/fliks-app/fliks/commit/62d99a456f832d8280f5e675c39a46a84a495b9c))
* **cast:** route every play button through PlayableMediaService ([#52](https://github.com/fliks-app/fliks/issues/52)) ([c2b50c1](https://github.com/fliks-app/fliks/commit/c2b50c1b0cf77dd0d1233f378c7a2404d2637c08))
* **cast:** serve fMP4 HLS to the Cast device profile ([#40](https://github.com/fliks-app/fliks/issues/40)) ([2040d17](https://github.com/fliks-app/fliks/commit/2040d17b795947a0b8a3e8ae28a91ccfd47bce54))
* **cast:** swap splash PNG for lossless WebP + preload ([#51](https://github.com/fliks-app/fliks/issues/51)) ([8c8806d](https://github.com/fliks-app/fliks/commit/8c8806da9d19a55a75de265d5176b837abf4fbf7))
* **cast:** use Shaka for HLS playback on the receiver ([#35](https://github.com/fliks-app/fliks/issues/35)) ([8905ff2](https://github.com/fliks-app/fliks/commit/8905ff2c45f73f61dcef395b7db9d7b603223d35))
* **playback:** use relation-form criteria in hideFromContinueWatching ([#38](https://github.com/fliks-app/fliks/issues/38)) ([448491f](https://github.com/fliks-app/fliks/commit/448491f65378739ba07f558ca4ba601c8fc07552))

## [1.4.0](https://github.com/fliks-app/fliks/compare/v1.3.1...v1.4.0) (2026-05-04)


### Features

* **providers:** bake TMDB & TVDB keys into image at build time ([#30](https://github.com/fliks-app/fliks/issues/30)) ([e0de203](https://github.com/fliks-app/fliks/commit/e0de2030a7a12387597fa5e07a3d3d83928332f1))


### Bug Fixes

* **i18n:** point empty-state CTA at libraries, not root folders ([#28](https://github.com/fliks-app/fliks/issues/28)) ([b0fd7ac](https://github.com/fliks-app/fliks/commit/b0fd7ac9a35c3d7f4bc6379074990548778aedd2))
* **rescan:** skip non-episode files in series folders, drop orphan rows ([#31](https://github.com/fliks-app/fliks/issues/31)) ([8401901](https://github.com/fliks-app/fliks/commit/8401901419f12f6df9a838dcf78c6464da3edeb9))
* **system:** read version from package.json, not npm env var ([#29](https://github.com/fliks-app/fliks/issues/29)) ([0e64cc8](https://github.com/fliks-app/fliks/commit/0e64cc8d9d051c8e5c3fa2e17e1bef58dcbd7bd0))

## [1.3.1](https://github.com/fliks-app/fliks/compare/v1.3.0...v1.3.1) (2026-05-03)


### Bug Fixes

* **libraries:** resolve library view outside the create/update tx ([#26](https://github.com/fliks-app/fliks/issues/26)) ([4e59ae1](https://github.com/fliks-app/fliks/commit/4e59ae158d6a6be671f300cd437c61eff5f30af9))

## [1.3.0](https://github.com/fliks-app/fliks/compare/v1.2.0...v1.3.0) (2026-05-03)


### Features

* **imports:** path-mapping wizard for Radarr/Sonarr ([#24](https://github.com/fliks-app/fliks/issues/24)) ([f125994](https://github.com/fliks-app/fliks/commit/f1259943ef9a73dd89c6ce9459b55ff532dacba2))


### Bug Fixes

* **subtitles:** always detect embedded subs on rescan and import ([#23](https://github.com/fliks-app/fliks/issues/23)) ([234dc6b](https://github.com/fliks-app/fliks/commit/234dc6b8ae19e46b701e7088969e4ab7a152d293))

## [1.2.0](https://github.com/fliks-app/fliks/compare/v1.1.1...v1.2.0) (2026-05-03)


### Features

* **auth:** auto-generate JWT secret on first boot ([#20](https://github.com/fliks-app/fliks/issues/20)) ([9b75fbc](https://github.com/fliks-app/fliks/commit/9b75fbcf82ac237aec8d36c2ec10cee32721cbcd))


### Bug Fixes

* **ci:** use 'draft' status for Play Store uploads while the app itself is in draft ([#15](https://github.com/fliks-app/fliks/issues/15)) ([f0243d2](https://github.com/fliks-app/fliks/commit/f0243d2e6208cc8823a99206231375da6eb826de))
* **client:** update angular.json buildTarget refs after project rename ([#21](https://github.com/fliks-app/fliks/issues/21)) ([cbc4b73](https://github.com/fliks-app/fliks/commit/cbc4b735c00e2a9f986419ffbc2a493f6e769653))

## [1.1.1](https://github.com/fliks-app/fliks/compare/v1.1.0...v1.1.1) (2026-05-03)


### Miscellaneous Chores

* pin next release as 1.1.1 ([#9](https://github.com/fliks-app/fliks/issues/9)) ([06439ce](https://github.com/fliks-app/fliks/commit/06439ce663a1c30866450b62c10d256d5582a1a6))

## [1.1.0](https://github.com/fliks-app/fliks/compare/v1.0.0...v1.1.0) (2026-05-03)


### Features

* **db:** set up TypeORM migrations with dev/prod gating ([#4](https://github.com/fliks-app/fliks/issues/4)) ([1bd6e1e](https://github.com/fliks-app/fliks/commit/1bd6e1e8cae30a94bd85b38afa5b20b581a9150c))
* **release:** automated versioning via release-please ([#5](https://github.com/fliks-app/fliks/issues/5)) ([a1538ef](https://github.com/fliks-app/fliks/commit/a1538ef020b7bf1b254a1005c8b6ad9966425c53))
