# Changelog

## [1.15.0](https://github.com/fliks-app/fliks/compare/v1.14.1...v1.15.0) (2026-07-07)


### Features

* **downloads:** implement ios offline downloads ([846855b](https://github.com/fliks-app/fliks/commit/846855bbc438c0df6a349d000a4b951f4dd313cc))
* **downloads:** implement ios offline downloads ([#607](https://github.com/fliks-app/fliks/issues/607)) ([846855b](https://github.com/fliks-app/fliks/commit/846855bbc438c0df6a349d000a4b951f4dd313cc))


### Bug Fixes

* **desktop:** content-adaptive macOS color pipeline ([#606](https://github.com/fliks-app/fliks/issues/606)) ([f833484](https://github.com/fliks-app/fliks/commit/f833484776cd462a3c149f7ac9aa586fe734acda))
* **player:** webOS subtitle margin and remote control wake ([#603](https://github.com/fliks-app/fliks/issues/603)) ([015f661](https://github.com/fliks-app/fliks/commit/015f661a5f1545b91b2a353b9899897b1ce1e6ea))
* **update:** hide topbar update check on native apps ([#608](https://github.com/fliks-app/fliks/issues/608)) ([e04e269](https://github.com/fliks-app/fliks/commit/e04e2692f2e2b6a0aeee2224adeeca5da0362ac7))

## [1.14.1](https://github.com/fliks-app/fliks/compare/v1.14.0...v1.14.1) (2026-07-07)


### Features

* **desktop:** keep the screen awake during playback ([#592](https://github.com/fliks-app/fliks/issues/592)) ([d0daeda](https://github.com/fliks-app/fliks/commit/d0daeda156a7c1d43f8a9139b84e1c525bd0807d))
* **file-info:** add video range, Dolby profile and color fields ([#596](https://github.com/fliks-app/fliks/issues/596)) ([100b746](https://github.com/fliks-app/fliks/commit/100b746498f281163a72e130f11f935c4981616c))
* **player:** error diagnostics card + fail-fast on undecodable streams ([#589](https://github.com/fliks-app/fliks/issues/589)) ([87cbed0](https://github.com/fliks-app/fliks/commit/87cbed02eef05795cd1a0a55d84ec35e14b4f58d))


### Bug Fixes

* **activity:** drop no-video downloads and fix queue labels and links ([#598](https://github.com/fliks-app/fliks/issues/598)) ([0fe9c1f](https://github.com/fliks-app/fliks/commit/0fe9c1fb367174e85a40d2d956883649028f03bd))
* **activity:** translate the blocked-from-queue status message ([#602](https://github.com/fliks-app/fliks/issues/602)) ([5e4d610](https://github.com/fliks-app/fliks/commit/5e4d610d8c5806591d8903cdd441fdaff2b6585a))
* **desktop:** restore caption buttons after exit-fullscreen on windows ([#601](https://github.com/fliks-app/fliks/issues/601)) ([87e57aa](https://github.com/fliks-app/fliks/commit/87e57aadce1015bffb309494cb9be41b49e4f498))
* **imports:** derive imported file quality from real resolution ([#597](https://github.com/fliks-app/fliks/issues/597)) ([c205be0](https://github.com/fliks-app/fliks/commit/c205be0a3af9df0e697d81e0331f7e6843f45753))
* **media:** exclude owned movies from coming-soon ([#594](https://github.com/fliks-app/fliks/issues/594)) ([649f4d3](https://github.com/fliks-app/fliks/commit/649f4d3d428d8778b10b16081e35751914d09cd8))
* **player:** keep subtitles off on desktop when disabled in controls ([#590](https://github.com/fliks-app/fliks/issues/590)) ([f50beb1](https://github.com/fliks-app/fliks/commit/f50beb167869714641f5d969c42c0c6ea7f9fb6d))
* **player:** translate reload/init error card, never show raw text ([#599](https://github.com/fliks-app/fliks/issues/599)) ([7169090](https://github.com/fliks-app/fliks/commit/71690907728b3cd08bfa74d7223f2741928cbc2f))
* **toast:** add top gap, show above modals, pin close button right ([#595](https://github.com/fliks-app/fliks/issues/595)) ([ef7613f](https://github.com/fliks-app/fliks/commit/ef7613f3188e0eb91f6838036b1d9e0d59365a8d))


### Miscellaneous Chores

* set next release version to 1.14.1 ([#593](https://github.com/fliks-app/fliks/issues/593)) ([015f0bf](https://github.com/fliks-app/fliks/commit/015f0bf36943ce87826be275ec79e4e45176a75e))

## [1.14.0](https://github.com/fliks-app/fliks/compare/v1.13.1...v1.14.0) (2026-06-26)


### Features

* **libraries:** folder auto-create, request access scoping, per-user order ([f0451a2](https://github.com/fliks-app/fliks/commit/f0451a2464e077f42e431409fbab4ccccb43ed74))
* **libraries:** move library editing to a dedicated tabbed page ([#566](https://github.com/fliks-app/fliks/issues/566)) ([8de08cf](https://github.com/fliks-app/fliks/commit/8de08cfdc587b98f2cba9e8dcced05f738aa8d7a))
* **libraries:** scan a library folder and re-link orphan files to TMDB/TVDB ([#567](https://github.com/fliks-app/fliks/issues/567)) ([bd9cb70](https://github.com/fliks-app/fliks/commit/bd9cb70405acd63a90655cbb62dc03ee78e9965f))
* **player:** keyboard/TV-friendly skip cue and default focus ([#586](https://github.com/fliks-app/fliks/issues/586)) ([0903f3d](https://github.com/fliks-app/fliks/commit/0903f3df5f21de44d64876b7765c830e89107f59))
* **player:** switch episodes in place instead of remounting ([#587](https://github.com/fliks-app/fliks/issues/587)) ([4cb7628](https://github.com/fliks-app/fliks/commit/4cb7628fdf61c0701480bcbacfd341067a428a5d))
* **subtitles:** image subtitle burn-in and native rendering by device ([#565](https://github.com/fliks-app/fliks/issues/565)) ([7692a17](https://github.com/fliks-app/fliks/commit/7692a17825ff3746a320ad6e4921a49966859d41))
* **subtitles:** prefer OCR for image tracks and hide them in players ([#559](https://github.com/fliks-app/fliks/issues/559)) ([475be2c](https://github.com/fliks-app/fliks/commit/475be2cc5dfa817dc22886d3e14eb6321ebfaf7a))
* **system:** group manual commands into per-domain dropdowns ([#561](https://github.com/fliks-app/fliks/issues/561)) ([722809a](https://github.com/fliks-app/fliks/commit/722809a75ec265cd5d09e9123ebc62fcc4fe91c1))
* **updates:** document the GitHub update check and add an opt-out flag ([#555](https://github.com/fliks-app/fliks/issues/555)) ([fe95de3](https://github.com/fliks-app/fliks/commit/fe95de371d1b659393ab30a534cdf6ace1ccad0c))


### Bug Fixes

* **auth:** derive cookie Secure flag from request protocol, not NODE_ENV ([#557](https://github.com/fliks-app/fliks/issues/557)) ([c387670](https://github.com/fliks-app/fliks/commit/c38767078eedf40d6235c72bd7ec874873dc3181))
* **auto-grab:** format release rejections in logs instead of [object Object] ([#560](https://github.com/fliks-app/fliks/issues/560)) ([c9ca790](https://github.com/fliks-app/fliks/commit/c9ca790871247044f785c02dfadc52e75e499c88))
* **cast:** show the eco indicator in the Chromecast quality dropdown ([#569](https://github.com/fliks-app/fliks/issues/569)) ([a07b681](https://github.com/fliks-app/fliks/commit/a07b6811c7a1e531c3131af341f14c65e7822656))
* **dropdown-menu:** close other open menus when opening one ([#562](https://github.com/fliks-app/fliks/issues/562)) ([229118b](https://github.com/fliks-app/fliks/commit/229118b3790e0674c2713b7a7c5723c48265ff03))
* **player:** gate sidecar sub preload on NativeEngine not isNative ([#581](https://github.com/fliks-app/fliks/issues/581)) ([c1e67fd](https://github.com/fliks-app/fliks/commit/c1e67fdc2ec5374d61206516524255456d1c89b8))
* **player:** keep the previous episode out of the back stack ([#588](https://github.com/fliks-app/fliks/issues/588)) ([4fb2ff1](https://github.com/fliks-app/fliks/commit/4fb2ff116b5ef280f64bc4750e5518860b5f36e7))
* **player:** native direct-play subtitle selection and image handling ([96f2614](https://github.com/fliks-app/fliks/commit/96f261443ea8aa4caf9cd77a31ed3177e2c4c37d))
* **releases:** match titles when groups drop the possessive apostrophe ([#584](https://github.com/fliks-app/fliks/issues/584)) ([36954d4](https://github.com/fliks-app/fliks/commit/36954d427ad41a7b90bce0964b306f1a68ce10cf))
* **requests:** monitor only the requested seasons on a scoped import ([#583](https://github.com/fliks-app/fliks/issues/583)) ([0fd2a68](https://github.com/fliks-app/fliks/commit/0fd2a68a90188582c3817c3825e45f65ac66234f))
* **scroller:** keep nav arrow above a card's hover play overlay ([#570](https://github.com/fliks-app/fliks/issues/570)) ([cade276](https://github.com/fliks-app/fliks/commit/cade276a665b4e53d0eb1749f1a1f47ca96f0508))
* **streaming:** A/V timing fixes — fps-aware seek/tfdt grid, tfdt overflow, sprite backfill ([d8a3dc7](https://github.com/fliks-app/fliks/commit/d8a3dc760a257daf15ffa1c9b0cbf81016e416d2))
* **streaming:** anchor remux segment grid at the source start PTS ([5373104](https://github.com/fliks-app/fliks/commit/537310478e9c8296faac1fa95fffffa563694041))
* **streaming:** declare real transcoded segment duration to stop A/V drift ([8ac8461](https://github.com/fliks-app/fliks/commit/8ac84613705ad875cd588e47dc15bd5ad2f3c114))
* **streaming:** drop the duplicate -ss in audio-only resume ([a3a93d5](https://github.com/fliks-app/fliks/commit/a3a93d505105d477bdac013196e7c15813f17426))
* **streaming:** gate eco quality rungs on source video bitrate ([#568](https://github.com/fliks-app/fliks/issues/568)) ([3ce2acd](https://github.com/fliks-app/fliks/commit/3ce2acd52d5b271aac231177769788c827a597dd))
* **streaming:** offset subtitle cues by the source start PTS on TS rips ([8c3cc4e](https://github.com/fliks-app/fliks/commit/8c3cc4e76e2aff4aa9d85faa502f4be36f185346))
* **streaming:** stop spurious mid-stream transcode respawns that desync A/V ([#582](https://github.com/fliks-app/fliks/issues/582)) ([a775063](https://github.com/fliks-app/fliks/commit/a775063e2c2aaf1489e2e8ebfc9c82cf54642e0a))
* **subtitles:** demote no-embedded-subtitles log to debug ([#563](https://github.com/fliks-app/fliks/issues/563)) ([80693d2](https://github.com/fliks-app/fliks/commit/80693d213b96be74ae35b432b89fb60b275cd0cc))
* **subtitles:** drop provider results outside the requested language ([#558](https://github.com/fliks-app/fliks/issues/558)) ([59b8b9e](https://github.com/fliks-app/fliks/commit/59b8b9ea1e2fe338d1699db7cf85517a10971eb0))

## [1.13.1](https://github.com/fliks-app/fliks/compare/v1.13.0...v1.13.1) (2026-06-21)


### Bug Fixes

* **desktop:** publish release assets onto the published GitHub release ([#550](https://github.com/fliks-app/fliks/issues/550)) ([0d5cd5a](https://github.com/fliks-app/fliks/commit/0d5cd5acd1867cf340d71cf5e614926ed8adc4dd))
* **docker:** publish port 4848 instead of host networking in example compose ([#554](https://github.com/fliks-app/fliks/issues/554)) ([29ae72e](https://github.com/fliks-app/fliks/commit/29ae72e47213ed74cca690a9670a9446f2b6d47c))

## [1.13.0](https://github.com/fliks-app/fliks/compare/v1.12.3...v1.13.0) (2026-06-21)


### Features

* **card-actions:** poster + title + subtitle header on the card menu ([#536](https://github.com/fliks-app/fliks/issues/536)) ([e98b837](https://github.com/fliks-app/fliks/commit/e98b837555d2ae9ab7976066cbbf07f08fac6c18))
* **home:** mark a recommendation watched from its card menu ([#537](https://github.com/fliks-app/fliks/issues/537)) ([34c7852](https://github.com/fliks-app/fliks/commit/34c7852bd422feb40822cffc50b632c9c0c98396))
* **ios:** advertise native codec support from the OS decode APIs ([#532](https://github.com/fliks-app/fliks/issues/532)) ([3a8562e](https://github.com/fliks-app/fliks/commit/3a8562efc04af88f98f94f00367ddea6b4a3bb4c))
* **media-detail:** mark a season watched from the other-seasons cards ([#535](https://github.com/fliks-app/fliks/issues/535)) ([14525ad](https://github.com/fliks-app/fliks/commit/14525adb158f1aad0b6140e18ecdd658ce003a00))
* **media-detail:** recompute intros/outros option in the analyze modal ([#538](https://github.com/fliks-app/fliks/issues/538)) ([4976419](https://github.com/fliks-app/fliks/commit/49764190b31d9ce914478ff6dc4cd8a8ad7bb32a))
* native macOS player and real device OS labels ([#542](https://github.com/fliks-app/fliks/issues/542)) ([772c7d8](https://github.com/fliks-app/fliks/commit/772c7d83e9ba5d9e6b1857c92bc89be119d4f765))
* **quick-connect:** use the real device name, not the UA model ([#547](https://github.com/fliks-app/fliks/issues/547)) ([d312213](https://github.com/fliks-app/fliks/commit/d3122135a6103de414e6f544ea2cd04980dde3f9))
* **streaming:** admin toggle to keep black bars instead of cropping ([#533](https://github.com/fliks-app/fliks/issues/533)) ([6e9c8c7](https://github.com/fliks-app/fliks/commit/6e9c8c7d9612e0d3b7d47cf5323e259943d714af))
* **updates:** in-app update awareness for desktop and web ([#549](https://github.com/fliks-app/fliks/issues/549)) ([78ad9be](https://github.com/fliks-app/fliks/commit/78ad9beda691db7fcb4bc8682fcd04c759a985a9))


### Bug Fixes

* **quick-connect:** restore device name and add an OS info line ([#546](https://github.com/fliks-app/fliks/issues/546)) ([30cf0a2](https://github.com/fliks-app/fliks/commit/30cf0a2312254e177249b1dc07c374630df1a24c))
* **search:** prefix-match local search, add watched + progress to cards ([#540](https://github.com/fliks-app/fliks/issues/540)) ([447b470](https://github.com/fliks-app/fliks/commit/447b4706e9dcf5d1eaf922432177086ba6a16fdd))
* **spatial-nav:** land on first item when changing rows ([#541](https://github.com/fliks-app/fliks/issues/541)) ([eff829f](https://github.com/fliks-app/fliks/commit/eff829f55cde5649e8cd9ff906db5803aa7e8431))
* **streaming:** keyframe-aligned segment durations for the remux HLS playlist ([#530](https://github.com/fliks-app/fliks/issues/530)) ([6c23e94](https://github.com/fliks-app/fliks/commit/6c23e941ddc251e63d49c9dee0962356af91e87f))

## [1.12.3](https://github.com/fliks-app/fliks/compare/v1.12.2...v1.12.3) (2026-06-17)


### Bug Fixes

* **setup:** store the post-redirect server URL so login POST isn't downgraded ([#528](https://github.com/fliks-app/fliks/issues/528)) ([e8d20b0](https://github.com/fliks-app/fliks/commit/e8d20b0795ead610fa493e72ca5598546f7adbdc))

## [1.12.2](https://github.com/fliks-app/fliks/compare/v1.12.1...v1.12.2) (2026-06-17)


### Bug Fixes

* **desktop:** force mpv unpause on load so reopened player autoplays ([#523](https://github.com/fliks-app/fliks/issues/523)) ([b6efe53](https://github.com/fliks-app/fliks/commit/b6efe53b9c711f9cddfd4d82039e56034ea36a04))
* **media-detail:** show the full media path in the file info panel ([#526](https://github.com/fliks-app/fliks/issues/526)) ([f658b0b](https://github.com/fliks-app/fliks/commit/f658b0b06f33b0dea7df73000a0e2df02d7ce5ed))
* **media:** delete on-disk files when removing media from the library ([#525](https://github.com/fliks-app/fliks/issues/525)) ([24967ce](https://github.com/fliks-app/fliks/commit/24967cededef2fcb5562904aa23a8e8f5a559138))
* **player:** set tab title from playing media without flicker ([#527](https://github.com/fliks-app/fliks/issues/527)) ([945568b](https://github.com/fliks-app/fliks/commit/945568b522aae9676d59c40e9787466ce5e61956))

## [1.12.1](https://github.com/fliks-app/fliks/compare/v1.12.0...v1.12.1) (2026-06-16)


### Bug Fixes

* **admin-streams:** label electron desktop clients as applications ([#516](https://github.com/fliks-app/fliks/issues/516)) ([5435925](https://github.com/fliks-app/fliks/commit/5435925df00b8075ab5636487a29f6ccca7a0af8))
* **admin-streams:** show direct-play label under container row ([#514](https://github.com/fliks-app/fliks/issues/514)) ([077fd18](https://github.com/fliks-app/fliks/commit/077fd18b01a55af68b1d0c78714f5120054befb9))
* **auto-grab:** match season packs and optional resolution upgrades ([#520](https://github.com/fliks-app/fliks/issues/520)) ([d05a0f6](https://github.com/fliks-app/fliks/commit/d05a0f62dab989f191fb60dd00d423c12e94a5ac))
* **auto-grab:** reject wrong-movie hits in search missing ([#521](https://github.com/fliks-app/fliks/issues/521)) ([7989973](https://github.com/fliks-app/fliks/commit/79899737dd889e33f9b064d87659fd6b1dd48d94))
* **scheduler:** skip at-cutoff media before indexer search ([#522](https://github.com/fliks-app/fliks/issues/522)) ([1417103](https://github.com/fliks-app/fliks/commit/141710336704d7c635ce30c97e381cc75adb7710))
* **scheduler:** use original title for auto series grabs ([#518](https://github.com/fliks-app/fliks/issues/518)) ([f3bd0ab](https://github.com/fliks-app/fliks/commit/f3bd0ab43dcf27ffac2a7fe4b9ad464f97975796))
* **streaming:** scope admin stop to one device session ([#517](https://github.com/fliks-app/fliks/issues/517)) ([1b639c1](https://github.com/fliks-app/fliks/commit/1b639c1ed8de84c9cb240b2ac7211549fd2a9e4e))

## [1.12.0](https://github.com/fliks-app/fliks/compare/v1.11.0...v1.12.0) (2026-06-15)


### Features

* **desktop:** native linux client with embedded mpv compositor ([ef3a30c](https://github.com/fliks-app/fliks/commit/ef3a30c4624208810bbc23d88b12b51a825884d4))
* **downloads:** faithful multi-source status on the download badges ([#450](https://github.com/fliks-app/fliks/issues/450)) ([cd78c4d](https://github.com/fliks-app/fliks/commit/cd78c4d897a369f988aad06eca0c69dfdf331d2e))
* **player:** add a direct-play arrow under the stats container line ([#476](https://github.com/fliks-app/fliks/issues/476)) ([ae80c9c](https://github.com/fliks-app/fliks/commit/ae80c9c084ec14752d457a5bc0a83800f0981545))
* **player:** leaf icon by the quality value when an eco rung is active ([#455](https://github.com/fliks-app/fliks/issues/455)) ([5deccfa](https://github.com/fliks-app/fliks/commit/5deccfa01f61a71cad07ed493570909438fa650c))
* **player:** show target channel layout on transcoded audio ([#469](https://github.com/fliks-app/fliks/issues/469)) ([943fe42](https://github.com/fliks-app/fliks/commit/943fe4278addede2eb3fac324255ecf63e09bd15))
* **streaming:** report mobile audio decode capability, not the output sink ([#468](https://github.com/fliks-app/fliks/issues/468)) ([0b33d3e](https://github.com/fliks-app/fliks/commit/0b33d3eb3f714fff5ba7687f5a34db942388554b))


### Bug Fixes

* **auth:** reset credentials on server switch so streaming re-mints ([#490](https://github.com/fliks-app/fliks/issues/490)) ([2c82b7c](https://github.com/fliks-app/fliks/commit/2c82b7c2a5671ae74053cb7dfa8b53e99c8fdbe4))
* **auth:** stop multi-tab refresh races from revoking every session ([#457](https://github.com/fliks-app/fliks/issues/457)) ([f8c1ec5](https://github.com/fliks-app/fliks/commit/f8c1ec5567e622cf91817500d2d28cfd05df253d))
* **client:** restore spec-build compile after the desktop client merge ([#496](https://github.com/fliks-app/fliks/issues/496)) ([841add6](https://github.com/fliks-app/fliks/commit/841add6bdf8c6ce2dfa811bc3678e90a86eaad9e))
* **desktop:** add homepage and author for the .deb package metadata ([#505](https://github.com/fliks-app/fliks/issues/505)) ([579d649](https://github.com/fliks-app/fliks/commit/579d649867e503bd3a155c3f92225fb07628b38e))
* **desktop:** generate the app icon from fliks-icon.svg ([#502](https://github.com/fliks-app/fliks/issues/502)) ([b13798b](https://github.com/fliks-app/fliks/commit/b13798b05100b0613a4b176f3904eb226c785641))
* **desktop:** move deb options to the config root for electron-builder ([#504](https://github.com/fliks-app/fliks/issues/504)) ([8d97209](https://github.com/fliks-app/fliks/commit/8d972091d6382b64c946a1b34e0e5d0f6e392bc5))
* **desktop:** poll mpv time-pos so playback progress advances ([#498](https://github.com/fliks-app/fliks/issues/498)) ([edf3cf2](https://github.com/fliks-app/fliks/commit/edf3cf2fee4d20eba3b43cc433112afbd2cc5c14))
* **desktop:** set the compositor window WM_CLASS and icon ([#500](https://github.com/fliks-app/fliks/issues/500)) ([16f9e53](https://github.com/fliks-app/fliks/commit/16f9e53974853be48ea8b1e72cf9517770df6500))
* **desktop:** show Fliks icon in window, dock and packaging ([#497](https://github.com/fliks-app/fliks/issues/497)) ([a451b6a](https://github.com/fliks-app/fliks/commit/a451b6aefa96e0bfd25342f5ef9c039f24dc7c42))
* **desktop:** use the transparent logo mark for the app icon ([#501](https://github.com/fliks-app/fliks/issues/501)) ([f6f4126](https://github.com/fliks-app/fliks/commit/f6f41263dedaf2d4b54514e6b5307aedf8787872))
* **device-profile:** probe MP3 inside MP4 for the browser profile ([#461](https://github.com/fliks-app/fliks/issues/461)) ([ea5f6b2](https://github.com/fliks-app/fliks/commit/ea5f6b242478df79cce62e3cf547d425346b7c56))
* **downloads:** show ∞ for a stalled torrent's ETA, colon in the i18n string ([#453](https://github.com/fliks-app/fliks/issues/453)) ([7334643](https://github.com/fliks-app/fliks/commit/7334643d6e1ba4430a0a2ab5af4a7ab8e164b51a))
* **player:** add a colon to the stats overlay Reasons label ([#471](https://github.com/fliks-app/fliks/issues/471)) ([531d8eb](https://github.com/fliks-app/fliks/commit/531d8ebf317ebe2466c65fd565872c6dc63bbfff))
* **player:** label untagged audio tracks by index instead of und ([#475](https://github.com/fliks-app/fliks/issues/475)) ([9005826](https://github.com/fliks-app/fliks/commit/9005826e32e2775764c79a84ad72d7aa36a8b9df))
* **player:** lower default subtitle bottom margin to 5% ([#492](https://github.com/fliks-app/fliks/issues/492)) ([f807287](https://github.com/fliks-app/fliks/commit/f807287ffb245b3612eb261569aa2e607c3df584))
* **player:** re-present iOS video layer on foreground and PiP exit ([#495](https://github.com/fliks-app/fliks/issues/495)) ([911851c](https://github.com/fliks-app/fliks/commit/911851c74d59e043c9c3a5d6a296727229e655e7))
* **player:** seek preview and controls fixes on Tizen and keyboard ([c2f124a](https://github.com/fliks-app/fliks/commit/c2f124a9fe162bcc4cbbfde609a7cec0aeade34b))
* **player:** send HLS subtitle renditions to Android TV ([#487](https://github.com/fliks-app/fliks/issues/487)) ([3aca66e](https://github.com/fliks-app/fliks/commit/3aca66ee0a09e81b919732e87d7f12207316907a))
* **player:** Shaka subtitle select/disable, desktop Escape, buffer flicker and subtitle polish ([#512](https://github.com/fliks-app/fliks/issues/512)) ([250a153](https://github.com/fliks-app/fliks/commit/250a15349053b5a2969882bae081d8f5b36afa22))
* **player:** stop sessions on close and cap the native reload loop ([#494](https://github.com/fliks-app/fliks/issues/494)) ([a9b5f4b](https://github.com/fliks-app/fliks/commit/a9b5f4b5d2c86bc491eacdd67d18d3d37d57f5a6))
* **player:** stop Tizen pause→resume from reloading the whole stream ([#458](https://github.com/fliks-app/fliks/issues/458)) ([00c8be8](https://github.com/fliks-app/fliks/commit/00c8be8fd4a5b429e96a6e53ae5a6ccced1bc84c))
* **seekbar:** keep position fill through seeks and show buffering sweep ([#460](https://github.com/fliks-app/fliks/issues/460)) ([89307fe](https://github.com/fliks-app/fliks/commit/89307fef01623559c06357580def17a87297ae2b))
* **settings:** tab title as "page | layout" on own-layout shells ([#456](https://github.com/fliks-app/fliks/issues/456)) ([c07c2a1](https://github.com/fliks-app/fliks/commit/c07c2a1d36a3b85408be17f8112ad7def69d4929))
* spatial-nav, library UX and direct-play binding ([#463](https://github.com/fliks-app/fliks/issues/463)) ([87cb39e](https://github.com/fliks-app/fliks/commit/87cb39e54408084e9b8f1e0192a8e88a06d4d126))
* **spatial-nav:** make home request cards a single focus leaf ([#452](https://github.com/fliks-app/fliks/issues/452)) ([aeaf420](https://github.com/fliks-app/fliks/commit/aeaf420cb0ea1dfe77753907232ef95b40af26d2))
* **streaming:** block the 0-byte audio rendition init to avoid a fatal 404 ([#507](https://github.com/fliks-app/fliks/issues/507)) ([73a014f](https://github.com/fliks-app/fliks/commit/73a014f8100316b2e4ac2d01dbe63e6fdc51ae55))
* **streaming:** cap transcode bitrate to source, fix reduction reason ([#477](https://github.com/fliks-app/fliks/issues/477)) ([fc7c1a4](https://github.com/fliks-app/fliks/commit/fc7c1a4d3655c6641b1b02dbb14e90f9a65bc0f2))
* **streaming:** decide audio copy/transcode per track, not just the default ([#466](https://github.com/fliks-app/fliks/issues/466)) ([9d41f3b](https://github.com/fliks-app/fliks/commit/9d41f3b06a750c7df705d831074247daaf13ce7c))
* **streaming:** direct-play a requested rung at the source resolution ([#510](https://github.com/fliks-app/fliks/issues/510)) ([810de58](https://github.com/fliks-app/fliks/commit/810de58afdd00cf263bd9e77b9f69c3506cab904))
* **streaming:** downmix every multi-audio rendition with -ac:a:i ([#473](https://github.com/fliks-app/fliks/issues/473)) ([8d6bfd2](https://github.com/fliks-app/fliks/commit/8d6bfd21d58a0b5253f76b2f8da07708cbb8929a))
* **streaming:** multi-audio keeps surround via a uniform group codec ([#467](https://github.com/fliks-app/fliks/issues/467)) ([a3830a3](https://github.com/fliks-app/fliks/commit/a3830a34b7d2e89d61497670b8dfbf1465e52d13))
* **streaming:** order low-consumption quality rungs after the normal one ([#454](https://github.com/fliks-app/fliks/issues/454)) ([6e2b083](https://github.com/fliks-app/fliks/commit/6e2b083624830f1d865a4dce06f0fed93e279da9))
* **streaming:** preserve HDR for non-HEVC sources, not just HEVC ([#465](https://github.com/fliks-app/fliks/issues/465)) ([3c8d24a](https://github.com/fliks-app/fliks/commit/3c8d24aaeac3388d737f5f6c56ac5b43e3675162))
* **streaming:** reap all stream variants on admin stop, trim the video-activity dashboard ([#509](https://github.com/fliks-app/fliks/issues/509)) ([9c2e5fd](https://github.com/fliks-app/fliks/commit/9c2e5fd2ff1c01bcf1845754ec96ac3d2aec96bf))
* **streaming:** reap stale sessions and cap per-user concurrency ([#493](https://github.com/fliks-app/fliks/issues/493)) ([b66eff0](https://github.com/fliks-app/fliks/commit/b66eff0541be7de513ddc26de592c1dd5538d6d9))
* **streaming:** respawn the early companion for audio renditions on resume ([0531565](https://github.com/fliks-app/fliks/commit/05315656f94c3810c4e84321daaaf0929c884026))
* **streaming:** surface both audio transcode reasons when both apply ([#470](https://github.com/fliks-app/fliks/issues/470)) ([21dd729](https://github.com/fliks-app/fliks/commit/21dd7293a26a25f61e7e358968ade0810103baad))


### Performance Improvements

* **library:** faster TV card grid scroll and card UI fixes ([c8b7b60](https://github.com/fliks-app/fliks/commit/c8b7b60d5a90887a7f08f55e2e69f54602066157))

## [1.11.0](https://github.com/fliks-app/fliks/compare/v1.10.1...v1.11.0) (2026-06-10)


### Features

* **media-detail:** clickable download status badge with detail modal ([#449](https://github.com/fliks-app/fliks/issues/449)) ([89b86a5](https://github.com/fliks-app/fliks/commit/89b86a500e80e74a0cd41251439d02343bce40d3))
* **requests:** dedupe requests globally and lock series profiles ([#447](https://github.com/fliks-app/fliks/issues/447)) ([042b5b8](https://github.com/fliks-app/fliks/commit/042b5b8e364b56ccfc287ab19e6081b6347e06a8))
* **requests:** live download progress on requests and media-detail ([#448](https://github.com/fliks-app/fliks/issues/448)) ([0319ba5](https://github.com/fliks-app/fliks/commit/0319ba5de95a93ff92ca4edc82e697de0a932fdf))
* **streaming:** expose full quality ladder, gate direct play on quality ([#441](https://github.com/fliks-app/fliks/issues/441)) ([f3bdec0](https://github.com/fliks-app/fliks/commit/f3bdec05d7ea211d294056d7da9a9d39f1dc9910))


### Bug Fixes

* **player:** name audio by source codec in stats overlay, not transcode output ([#444](https://github.com/fliks-app/fliks/issues/444)) ([636a1e0](https://github.com/fliks-app/fliks/commit/636a1e06c12349c6f40bfa5e63af7a184b3f28a4))
* **scheduler:** align availability gates across SearchMissing and RSS ([#445](https://github.com/fliks-app/fliks/issues/445)) ([31ccd47](https://github.com/fliks-app/fliks/commit/31ccd47a9d48509903ea2c815540431648c4bc14)), closes [#442](https://github.com/fliks-app/fliks/issues/442)


### Performance Improvements

* **requests:** return approval immediately and import media out of band ([#446](https://github.com/fliks-app/fliks/issues/446)) ([209e97b](https://github.com/fliks-app/fliks/commit/209e97ba20a4bb54f2f69c1e1eedf06af3e547d4))

## [1.10.1](https://github.com/fliks-app/fliks/compare/v1.10.0...v1.10.1) (2026-06-09)


### Bug Fixes

* **activity:** use shared pagination in the subtitles tab ([#440](https://github.com/fliks-app/fliks/issues/440)) ([fd9da33](https://github.com/fliks-app/fliks/commit/fd9da33cce31e5e95e80ab1b6bcb48db2bf215d1))
* **bottom-sheet:** animate slide-down close for every dismiss path ([#439](https://github.com/fliks-app/fliks/issues/439)) ([eb36b42](https://github.com/fliks-app/fliks/commit/eb36b42b8c22d4c665327c4e57d32fb7a816eb20))
* **subtitles:** canonical language codes and atomic upgrade replace ([#438](https://github.com/fliks-app/fliks/issues/438)) ([171f77a](https://github.com/fliks-app/fliks/commit/171f77a107bcae35ddad43fa1f95a4775acc3ecb))
* **webos:** use a solid-background store icon and add a splash ([#436](https://github.com/fliks-app/fliks/issues/436)) ([8bcfa4f](https://github.com/fliks-app/fliks/commit/8bcfa4ff15dd366edafe005d25ebfe3f6260268c))

## [1.10.0](https://github.com/fliks-app/fliks/compare/v1.9.0...v1.10.0) (2026-06-08)


### Features

* **downloads:** add original-file download to the quality modal ([#419](https://github.com/fliks-app/fliks/issues/419)) ([63612bf](https://github.com/fliks-app/fliks/commit/63612bfaac28ecde850c32f632e4e9ba6dbac13a))
* **indexers:** skip indexers in cooldown during release searches ([#422](https://github.com/fliks-app/fliks/issues/422)) ([42af83b](https://github.com/fliks-app/fliks/commit/42af83bf265397e7c7831ecc2e19b776a3817271))
* **native:** refresh data pages when the app resumes from background ([#435](https://github.com/fliks-app/fliks/issues/435)) ([2fb6de8](https://github.com/fliks-app/fliks/commit/2fb6de85377aee892fb2ba65f3be9c92592b2df5))
* **subtitles:** extract image subtitles to text via OCR ([0a71116](https://github.com/fliks-app/fliks/commit/0a71116559ac3a167f67886fa79bae23d7fb370c))
* **subtitles:** hide burn-required subtitles behind an app setting ([#427](https://github.com/fliks-app/fliks/issues/427)) ([7f7cbf0](https://github.com/fliks-app/fliks/commit/7f7cbf0311707fa9ef0ce5ccc1be9106cf784673))


### Bug Fixes

* **confirmation:** render in the top layer to stack above modals ([#425](https://github.com/fliks-app/fliks/issues/425)) ([c16d6c5](https://github.com/fliks-app/fliks/commit/c16d6c50061743c586ae505554879a621931efe2))
* **media:** hide the clearlogo img when its image fails to load ([#433](https://github.com/fliks-app/fliks/issues/433)) ([e7f9705](https://github.com/fliks-app/fliks/commit/e7f970509ef81d6e438634a693c1d1cc9c51f802))
* **player:** align top-bar edge spacing with the app navbar ([#430](https://github.com/fliks-app/fliks/issues/430)) ([99cf414](https://github.com/fliks-app/fliks/commit/99cf414e4e96cc72ce6091671643bd9bedde0e07))
* **popover-menu:** keep the anchored dropdown inside the viewport ([#426](https://github.com/fliks-app/fliks/issues/426)) ([664ebf9](https://github.com/fliks-app/fliks/commit/664ebf9f7165f9607a6332b442841a2721b70a2c))
* **subtitles:** clear the iOS overlay when subtitles are disabled ([#432](https://github.com/fliks-app/fliks/issues/432)) ([7c0170d](https://github.com/fliks-app/fliks/commit/7c0170de775bfe913da3b7888d18d084421a7e70))
* **subtitles:** gate management on subtitles.manage, not media.grab ([#429](https://github.com/fliks-app/fliks/issues/429)) ([009ac5a](https://github.com/fliks-app/fliks/commit/009ac5af608a3b6d0901d79a65d0379aff7d66ba))
* **subtitles:** normalize score so non-hash matches can clear min-score ([#423](https://github.com/fliks-app/fliks/issues/423)) ([89c58b4](https://github.com/fliks-app/fliks/commit/89c58b4a6f6dd962ab52129348a6e52bce482e17))
* **subtitles:** search every missing profile language from the modal ([#424](https://github.com/fliks-app/fliks/issues/424)) ([77ec797](https://github.com/fliks-app/fliks/commit/77ec7979f31f1c49a55da8ab79cdfd93f60ad79a))
* **tmdb-preview:** drop duplicate back arrow and show the clearlogo ([#431](https://github.com/fliks-app/fliks/issues/431)) ([f4bd902](https://github.com/fliks-app/fliks/commit/f4bd90283950ebf1ea22471c5ad0ab6685ae0ab4))

## [1.9.0](https://github.com/fliks-app/fliks/compare/v1.8.0...v1.9.0) (2026-06-06)


### Features

* **cast:** resilient mid-cast sessions, receiver recovery, and seekbar loading ([c6395dc](https://github.com/fliks-app/fliks/commit/c6395dc116badc4a23fe2cfa0a616376fcb3c992))
* **clearlogo:** show title clearlogos across the app ([2981a7e](https://github.com/fliks-app/fliks/commit/2981a7e8712d358404b3e8609bdd4e0ebe310b1e))
* **downloads:** rank releases by availability and prefer season packs ([#405](https://github.com/fliks-app/fliks/issues/405)) ([7664eb5](https://github.com/fliks-app/fliks/commit/7664eb5bb7d2f81ef01e1fcc6f0c4adca9f440e4))
* **media-detail:** hide the open episode and jump to the next ([cb8075d](https://github.com/fliks-app/fliks/commit/cb8075d031a3be44bac7a9a318bea07a9c0c9ced))
* **scroller:** reveal large edge arrows on cursor proximity ([#387](https://github.com/fliks-app/fliks/issues/387)) ([a253ecf](https://github.com/fliks-app/fliks/commit/a253ecfdd088da6571333d2a8051cfd767bbbffd))
* **streaming:** offer a low-consumption quality on desktop ([#389](https://github.com/fliks-app/fliks/issues/389)) ([a8da81f](https://github.com/fliks-app/fliks/commit/a8da81f73b8526b28d038524d507b977d1df2a34))
* **streaming:** show the low-consumption rung on forced transcode ([#390](https://github.com/fliks-app/fliks/issues/390)) ([d6bdbaf](https://github.com/fliks-app/fliks/commit/d6bdbaf481d5a5d0325b23849553e7145c40e1ab))
* **streaming:** unify ladders + eco quality controls ([#391](https://github.com/fliks-app/fliks/issues/391)) ([0d62da5](https://github.com/fliks-app/fliks/commit/0d62da51bc39a4bdcd415dac424b8f4ca7bbe88e))


### Bug Fixes

* **activity:** stack release name under the badges on phones ([#402](https://github.com/fliks-app/fliks/issues/402)) ([b4816b0](https://github.com/fliks-app/fliks/commit/b4816b0610f823431d3d8849617668d84117b589))
* **android:** draw under the landscape display cutout ([#394](https://github.com/fliks-app/fliks/issues/394)) ([5367e5f](https://github.com/fliks-app/fliks/commit/5367e5f697947f35a9b9c82d949b82d2db6c3b5e))
* **android:** keep the status bar edge-to-edge on cold start ([#392](https://github.com/fliks-app/fliks/issues/392)) ([076dc41](https://github.com/fliks-app/fliks/commit/076dc410b19689a7b31d0892865d25d42daab8a4))
* **downloads:** mint a live session so HLS segments resolve a variant ([#417](https://github.com/fliks-app/fliks/issues/417)) ([9c132d6](https://github.com/fliks-app/fliks/commit/9c132d6bb05357027c831b2ea6d10263dee1f4fe))
* **downloads:** reconcile the queue badge when torrents vanish ([75b077c](https://github.com/fliks-app/fliks/commit/75b077c2629f71957860945159ae802c7e55aa26))
* **downloads:** respect cutoff when grabbing season packs ([1dd4fbc](https://github.com/fliks-app/fliks/commit/1dd4fbc7370f63a6dfb46379773cdb782ef271dd))
* **downloads:** stop orphaning grabs when qBittorrent fetch fails ([#404](https://github.com/fliks-app/fliks/issues/404)) ([8aa16c0](https://github.com/fliks-app/fliks/commit/8aa16c0138ab84fda61afbfc5dd1d7bfd8fed81c))
* **downloads:** stuck-torrent cleanup reliability and activity queue UX ([#398](https://github.com/fliks-app/fliks/issues/398)) ([8ce6a19](https://github.com/fliks-app/fliks/commit/8ce6a19b8dd4da4b9e9e5385aff433b33c2e5ead))
* **layout:** align horizontal-scroller bleed with the main padding ([4abaff7](https://github.com/fliks-app/fliks/commit/4abaff7b46cdf3d29b51816ca2245b4dda23a02d))
* **playback:** only record watch history after 5s of playback ([daf1ed6](https://github.com/fliks-app/fliks/commit/daf1ed6575c21abfcf609f0d00cc72d0e801b274))
* **player:** faster native startup and play/pause A/V desync hardening ([#416](https://github.com/fliks-app/fliks/issues/416)) ([f029fb8](https://github.com/fliks-app/fliks/commit/f029fb874fbef105e9465b726b0958b2413499dc))
* **player:** reduce max height of the clearlogo overlay ([#415](https://github.com/fliks-app/fliks/issues/415)) ([9ba996f](https://github.com/fliks-app/fliks/commit/9ba996ff2bdd5d299c9578bdc25e383c96ab7262))
* **requests:** harden the home-load changes after adversarial review ([e60436d](https://github.com/fliks-app/fliks/commit/e60436db989d11eec38dba5417f88e54e9556230))
* **streaming:** 410 segment requests with no resolvable live session ([432eda4](https://github.com/fliks-app/fliks/commit/432eda4d6ae1bfe49fd1ed3aebc84e0d217a6ca7))
* **users:** stop leaking password hashes in api responses ([#399](https://github.com/fliks-app/fliks/issues/399)) ([df9352a](https://github.com/fliks-app/fliks/commit/df9352a976d8f558ba6dcf84ef61db0b73dce2ce))
* **watch-history:** show the episode still, not the series art ([#395](https://github.com/fliks-app/fliks/issues/395)) ([944fadd](https://github.com/fliks-app/fliks/commit/944fadd84ebcc8a612ae3e80297df644c7dcea1c))


### Performance Improvements

* **android:** widen native player buffer for degraded links ([#397](https://github.com/fliks-app/fliks/issues/397)) ([1316c0f](https://github.com/fliks-app/fliks/commit/1316c0f559ec13ff36249a00e63b28145e40dbe2))
* **layout:** replace home queue fetch with a counts endpoint ([#400](https://github.com/fliks-app/fliks/issues/400)) ([45c6a0f](https://github.com/fliks-app/fliks/commit/45c6a0fc8426407b2858d5a7971fe6f547f162b2))
* **player:** raise web buffering goal to 30s ([#396](https://github.com/fliks-app/fliks/issues/396)) ([c0a3b75](https://github.com/fliks-app/fliks/commit/c0a3b75ec2ca6c4fba2226378d78e313960e15b0))
* **requests:** serve request card art from the local image pipeline ([#401](https://github.com/fliks-app/fliks/issues/401)) ([b69ba5e](https://github.com/fliks-app/fliks/commit/b69ba5ea86ad97ed8f71b0be1f49decfb5a2e016))

## [1.8.0](https://github.com/fliks-app/fliks/compare/v1.7.1...v1.8.0) (2026-06-01)


### Features

* **activity:** add block-torrent action with rule-based re-grab ([#275](https://github.com/fliks-app/fliks/issues/275)) ([d31312c](https://github.com/fliks-app/fliks/commit/d31312cb52119ee1fc196969039569b750f86970))
* **activity:** add queue search and group downloads by add date ([#274](https://github.com/fliks-app/fliks/issues/274)) ([add54d6](https://github.com/fliks-app/fliks/commit/add54d620647efb8a9fc482b485e22f1d827b749))
* **activity:** filter the download queue by status with pagination ([#273](https://github.com/fliks-app/fliks/issues/273)) ([e162f43](https://github.com/fliks-app/fliks/commit/e162f43f2ed2ae19e7893d46bd071d13e4f39d67))
* **ci:** publish iOS to App Store Connect on every release tag ([#265](https://github.com/fliks-app/fliks/issues/265)) ([8d5bac2](https://github.com/fliks-app/fliks/commit/8d5bac2012bcd44a796aeb501c816e3d5974db2c))
* **home:** add "Demandes récentes" zone with request cards ([#311](https://github.com/fliks-app/fliks/issues/311)) ([b848046](https://github.com/fliks-app/fliks/commit/b848046eacf622875c8e84ad55e9814ed401701d)), closes [#291](https://github.com/fliks-app/fliks/issues/291)
* **home:** personalizable zones + per-library recently added ([#310](https://github.com/fliks-app/fliks/issues/310)) ([6de7f44](https://github.com/fliks-app/fliks/commit/6de7f44e5df6a950b1f07f32d087ab88e4968e3c)), closes [#291](https://github.com/fliks-app/fliks/issues/291)
* **media-detail:** add tracking-status modal per item ([#276](https://github.com/fliks-app/fliks/issues/276)) ([bc6d2ed](https://github.com/fliks-app/fliks/commit/bc6d2edaa14c147ca0e6d1112437173b4471672f))
* **media:** cascade monitored toggle to seasons and episodes ([#314](https://github.com/fliks-app/fliks/issues/314)) ([174cf50](https://github.com/fliks-app/fliks/commit/174cf50eb0bf7763be632b6d487ec9e090d9e676))
* **player:** native HLS subtitle renditions with client iOS rendering ([729c6cc](https://github.com/fliks-app/fliks/commit/729c6cc369ec79e02e8095f7f0a56fe8284697f0))
* **settings:** toggles for auto-grab on approval and marker auto-detect ([#342](https://github.com/fliks-app/fliks/issues/342)) ([996540d](https://github.com/fliks-app/fliks/commit/996540d4ebb09b6020362394a8c388415057868d)), closes [#212](https://github.com/fliks-app/fliks/issues/212)
* **sse:** scope events to recipients and add admin viewer messages ([#270](https://github.com/fliks-app/fliks/issues/270)) ([17015c9](https://github.com/fliks-app/fliks/commit/17015c9b53b3d515aaa7f443973792f0c16944ed))
* **streaming:** auto-recover player when backend loses the LiveSession ([#302](https://github.com/fliks-app/fliks/issues/302)) ([77478aa](https://github.com/fliks-app/fliks/commit/77478aa3cf028b2a46764006112775bb1d309b35)), closes [#291](https://github.com/fliks-app/fliks/issues/291)
* **streaming:** profile-keyed cache, heartbeat-driven lifecycle, multi-profile coexistence ([#290](https://github.com/fliks-app/fliks/issues/290)) ([a547fa4](https://github.com/fliks-app/fliks/commit/a547fa4ec9bc87e20d16829faef1a7e062d78704))
* **streaming:** transcode-cache size + purge in admin, deprecate bulk-stop ([#309](https://github.com/fliks-app/fliks/issues/309)) ([b77eed8](https://github.com/fliks-app/fliks/commit/b77eed834d94ce0fe3f2d9707513ac9ceeead09f)), closes [#291](https://github.com/fliks-app/fliks/issues/291)
* **streams:** show client device on the active-streams dashboard ([#271](https://github.com/fliks-app/fliks/issues/271)) ([0a6df8b](https://github.com/fliks-app/fliks/commit/0a6df8bf8b5c8a64d39afeb3bd13ef5b6f80d225))
* **system-streams:** translate device label from the User-Agent header ([#305](https://github.com/fliks-app/fliks/issues/305)) ([13519a7](https://github.com/fliks-app/fliks/commit/13519a7c8e20680556b16791772ad517c80583d7))
* **webos:** native LG TV player and platform fixes ([#280](https://github.com/fliks-app/fliks/issues/280)) ([3b4ac99](https://github.com/fliks-app/fliks/commit/3b4ac99c6e3225c55b22d3040fc48bcd24a029b6))


### Bug Fixes

* **auto-grab:** grab only the targeted episode and heal history links ([#272](https://github.com/fliks-app/fliks/issues/272)) ([3512cae](https://github.com/fliks-app/fliks/commit/3512caeb1df6366822bcdcb1d0bd66e32964681b))
* **cache:** revalidate browsing pages after the cache preload ([#284](https://github.com/fliks-app/fliks/issues/284)) ([a67255b](https://github.com/fliks-app/fliks/commit/a67255b68fd22b2fb1dc9cd02a5bd2713f56f670))
* **ci:** bump iOS publish workflow to Xcode 26 / iOS 26 SDK ([#268](https://github.com/fliks-app/fliks/issues/268)) ([3a3e523](https://github.com/fliks-app/fliks/commit/3a3e523f18103a9d8841a73fc0cfc79a5662cad3))
* **ci:** select Xcode via maxim-lobanov/setup-xcode action ([#269](https://github.com/fliks-app/fliks/issues/269)) ([4b35661](https://github.com/fliks-app/fliks/commit/4b3566176cfa59b54f420dcfab040558dff6415e))
* **episodes:** treat multi-episode files as on-disk via derived coverage ([#277](https://github.com/fliks-app/fliks/issues/277)) ([9b8300a](https://github.com/fliks-app/fliks/commit/9b8300abc38ed4b4cf78d23265ec7a5a7440721f))
* **ios-player:** re-emit tracks after media selection group populates ([#380](https://github.com/fliks-app/fliks/issues/380)) ([6901695](https://github.com/fliks-app/fliks/commit/690169533a7c762a3db12882ff348d90e9e35051)), closes [#378](https://github.com/fliks-app/fliks/issues/378)
* **layout:** tablet native top toolbar offset and dock nav swap ([#293](https://github.com/fliks-app/fliks/issues/293)) ([96d146d](https://github.com/fliks-app/fliks/commit/96d146dc63ef147fca1d2bbfc30dbd5ab3c107ec))
* **media-card:** right-size home cards across breakpoints ([#312](https://github.com/fliks-app/fliks/issues/312)) ([624554d](https://github.com/fliks-app/fliks/commit/624554d80127506c81d077015c8e4faf1f1e4547)), closes [#291](https://github.com/fliks-app/fliks/issues/291)
* **media-detail:** compact header on mobile landscape + clamp synopsis ([#313](https://github.com/fliks-app/fliks/issues/313)) ([7ebe7f2](https://github.com/fliks-app/fliks/commit/7ebe7f20a15ce05e919c1733b0a394d402c7d38b))
* **media-detail:** hide profiles + monitored badge below lg ([#375](https://github.com/fliks-app/fliks/issues/375)) ([a0f711c](https://github.com/fliks-app/fliks/commit/a0f711c892bea7323892bb8f685eaae997d070d2))
* **media:** forwardRef the SchedulerService dep on MediaMetadataService ([#283](https://github.com/fliks-app/fliks/issues/283)) ([efc9b3c](https://github.com/fliks-app/fliks/commit/efc9b3c807188f3971f63ea2b2503c32886fb582))
* **media:** make the cutoff-unmet series filter multi-episode aware ([#278](https://github.com/fliks-app/fliks/issues/278)) ([c6e2c8b](https://github.com/fliks-app/fliks/commit/c6e2c8b80a0a10c449ed3a640ddb19e0b2a9cb4f))
* **player:** audited quick wins — stuck spinner, leaks, startup latency, i18n, a11y ([#318](https://github.com/fliks-app/fliks/issues/318)) ([2c3e9f5](https://github.com/fliks-app/fliks/commit/2c3e9f58cf5ea43b37fca79bf529257d90e1326a))
* **player:** clean session-recovery reload (spinner, prewarmed resume) ([#316](https://github.com/fliks-app/fliks/issues/316)) ([dadaa7f](https://github.com/fliks-app/fliks/commit/dadaa7f4b155ac1e1c5a48c3c2d1eb2e7fac01a2))
* **player:** correct Tizen/webOS/Cast teardown and reload edge cases ([#333](https://github.com/fliks-app/fliks/issues/333)) ([3732d82](https://github.com/fliks-app/fliks/commit/3732d829cb96344f9c2570ed003a236ec2ebed97)), closes [#325](https://github.com/fliks-app/fliks/issues/325)
* **player:** cross-platform audio + seek correctness fixes ([#341](https://github.com/fliks-app/fliks/issues/341)) ([617237f](https://github.com/fliks-app/fliks/commit/617237f7efc8c25ebe109921ebb8d86674aac5ef)), closes [#325](https://github.com/fliks-app/fliks/issues/325)
* **player:** i18n Tizen/webOS engine errors, drop redundant auto-pick ([#338](https://github.com/fliks-app/fliks/issues/338)) ([dd691b1](https://github.com/fliks-app/fliks/commit/dd691b10f0c75bab3b8dceebdf4d58be565a9c55)), closes [#328](https://github.com/fliks-app/fliks/issues/328)
* **player:** iOS stall-recovery spinner via timeControlStatus ([#329](https://github.com/fliks-app/fliks/issues/329)) ([c8cc148](https://github.com/fliks-app/fliks/commit/c8cc148ebffb4e96c1a6e9d9c94c9b385a527d64))
* **player:** recover from stalled playback with capped backoff ([#340](https://github.com/fliks-app/fliks/issues/340)) ([9554995](https://github.com/fliks-app/fliks/commit/9554995f63d0b294a5e45b2c27e39e2496cc3757)), closes [#322](https://github.com/fliks-app/fliks/issues/322)
* **player:** refresh sid via playback-info on cast disconnect ([#295](https://github.com/fliks-app/fliks/issues/295)) ([10514ef](https://github.com/fliks-app/fliks/commit/10514ef75361236944987a53eb9401db81b52dcb)), closes [#291](https://github.com/fliks-app/fliks/issues/291)
* **player:** remove leaked DOM listeners, abort sprite fetch on teardown ([#332](https://github.com/fliks-app/fliks/issues/332)) ([da54545](https://github.com/fliks-app/fliks/commit/da545456058cc52a7d0a868a76ec60efae4d90d5)), closes [#326](https://github.com/fliks-app/fliks/issues/326)
* **player:** report the selected audio track on iOS ([#339](https://github.com/fliks-app/fliks/issues/339)) ([8415145](https://github.com/fliks-app/fliks/commit/841514517e7d463639b01af1977bb5aa58b8f803))
* **player:** stop background relaunch after closing the player ([#337](https://github.com/fliks-app/fliks/issues/337)) ([300cae7](https://github.com/fliks-app/fliks/commit/300cae7874b75c476a568164dafa10a311fcac6b))
* **player:** surface recovery failures and keep resume position ([#334](https://github.com/fliks-app/fliks/issues/334)) ([08b864b](https://github.com/fliks-app/fliks/commit/08b864b21819fd8a12a76a4942ee78f556aec4f2)), closes [#322](https://github.com/fliks-app/fliks/issues/322)
* **requests, media:** unify metadata workflow and kick auto-grab on every approval/refresh ([#281](https://github.com/fliks-app/fliks/issues/281)) ([ea2ed22](https://github.com/fliks-app/fliks/commit/ea2ed22eaabbb40757bbd38372e5f6a77abc5661))
* **streaming:** 410 gone for stale sids + cross-engine recovery ([#306](https://github.com/fliks-app/fliks/issues/306)) ([748db00](https://github.com/fliks-app/fliks/commit/748db00643de3ce504dd7015715d1086caaefb11))
* **streaming:** derive early-companion read window from segment duration ([#367](https://github.com/fliks-app/fliks/issues/367)) ([204ac29](https://github.com/fliks-app/fliks/commit/204ac298f2b700546b88232cc2e4caf4d06bbff1)), closes [#346](https://github.com/fliks-app/fliks/issues/346)
* **streaming:** don't grid-snap remux segment tfdt ([#370](https://github.com/fliks-app/fliks/issues/370)) ([b693386](https://github.com/fliks-app/fliks/commit/b69338655d55d77fbf4e136d6db72ccd2c3c30a3)), closes [#349](https://github.com/fliks-app/fliks/issues/349)
* **streaming:** drop -master_display/-max_cll from hevc_qsv (NVENC-only opt) ([#374](https://github.com/fliks-app/fliks/issues/374)) ([dab581b](https://github.com/fliks-app/fliks/commit/dab581bdeb810381a889d887f65f7e34c6f018f0))
* **streaming:** enforce library ACL on subtitle routes (IDOR) ([#358](https://github.com/fliks-app/fliks/issues/358)) ([f72ca96](https://github.com/fliks-app/fliks/commit/f72ca969a3784611383d076e44fd2e4a19efe28d)), closes [#345](https://github.com/fliks-app/fliks/issues/345)
* **streaming:** enforce library ACL on the segment-serve fast path ([#364](https://github.com/fliks-app/fliks/issues/364)) ([37a1f39](https://github.com/fliks-app/fliks/commit/37a1f39c0ecdea04776ab1a22fc520ff457321ce))
* **streaming:** keep transcode cache to one timeline across restarts and seeks ([#317](https://github.com/fliks-app/fliks/issues/317)) ([39dcd1b](https://github.com/fliks-app/fliks/commit/39dcd1b381558f44e5097e304491588022038e53))
* **streaming:** label copy-mode Opus/FLAC audio correctly in CODECS ([#361](https://github.com/fliks-app/fliks/issues/361)) ([555c6e0](https://github.com/fliks-app/fliks/commit/555c6e07576d0fbef195ff5aed9c476adb4980b0)), closes [#347](https://github.com/fliks-app/fliks/issues/347)
* **streaming:** make the TS (Tizen) path .m4s/.ts agnostic ([#362](https://github.com/fliks-app/fliks/issues/362)) ([a8546a1](https://github.com/fliks-app/fliks/commit/a8546a1e28086cff3566b1e66a8bf3a9443daa5b)), closes [#357](https://github.com/fliks-app/fliks/issues/357)
* **streaming:** pin HDR original/remux to a single master variant ([#377](https://github.com/fliks-app/fliks/issues/377)) ([5cdab40](https://github.com/fliks-app/fliks/commit/5cdab409d5326703868ba36a9ba32aa26ec89289))
* **streaming:** propagate source HDR10 static metadata to encoders ([#371](https://github.com/fliks-app/fliks/issues/371)) ([cdc5849](https://github.com/fliks-app/fliks/commit/cdc58494e67c54464ace99f3e496d96f9ea91edd))
* **streaming:** report real audio channel count in EXT-X-MEDIA CHANNELS ([#366](https://github.com/fliks-app/fliks/issues/366)) ([82514fa](https://github.com/fliks-app/fliks/commit/82514fa7e0e7bf294cc027fcd95b333c9a75d336)), closes [#348](https://github.com/fliks-app/fliks/issues/348)
* **streaming:** return a retryable 503 when a segment vanishes mid-serve ([#365](https://github.com/fliks-app/fliks/issues/365)) ([a984edd](https://github.com/fliks-app/fliks/commit/a984edd3886b251b088200f891a6c52a068ee846)), closes [#351](https://github.com/fliks-app/fliks/issues/351)
* **streaming:** scale to mod-2 so encode height matches the manifest ([#373](https://github.com/fliks-app/fliks/issues/373)) ([de08917](https://github.com/fliks-app/fliks/commit/de08917cd63cb4d63d5bfa61b677c37806b32331)), closes [#344](https://github.com/fliks-app/fliks/issues/344)
* **streaming:** skip the seg-0 early-start companion for native players ([#379](https://github.com/fliks-app/fliks/issues/379)) ([ddc34ca](https://github.com/fliks-app/fliks/commit/ddc34cae7d0dac81aa9298a9dd97349502cdb4c6))
* **streaming:** start native resumes at the resume segment, not 0 ([#381](https://github.com/fliks-app/fliks/issues/381)) ([8bd1e43](https://github.com/fliks-app/fliks/commit/8bd1e435b5dbe531a41a295d7f6460d9fbcb14b5))
* **streaming:** stop cache GC evicting live dirs; track post-boot growth ([#359](https://github.com/fliks-app/fliks/issues/359)) ([8137c01](https://github.com/fliks-app/fliks/commit/8137c01c4fb54292a38f9a860983f0f27eaf5876)), closes [#343](https://github.com/fliks-app/fliks/issues/343)
* **streaming:** unblock AV1 seeks and surface ffmpeg errors in logs ([#384](https://github.com/fliks-app/fliks/issues/384)) ([88f019f](https://github.com/fliks-app/fliks/commit/88f019fe747c9d27ba33a561fc46b216208e1717))
* **streaming:** validate direct-play Range header (RFC 7233) ([#360](https://github.com/fliks-app/fliks/issues/360)) ([5e4e2a3](https://github.com/fliks-app/fliks/commit/5e4e2a3ab0325c474ac6d1c874eb2b2a3fa8c129)), closes [#350](https://github.com/fliks-app/fliks/issues/350)
* **subtitles:** pick the right native subtitle track (language + forced) ([#336](https://github.com/fliks-app/fliks/issues/336)) ([1fbd93d](https://github.com/fliks-app/fliks/commit/1fbd93d8f0af1d2ba833a3ddd6e2141c0ef6e6ce))
* **system-streams:** target commands via LiveSession instead of transcode key ([#307](https://github.com/fliks-app/fliks/issues/307)) ([aa1d371](https://github.com/fliks-app/fliks/commit/aa1d371e1e4d51a94fe2ddb3a67562f5b9e0ea32))
* **webos-player:** emit sessionExpired on network errors for 410 recovery ([#308](https://github.com/fliks-app/fliks/issues/308)) ([6af6cb8](https://github.com/fliks-app/fliks/commit/6af6cb8ccebf09a357760ff116fb6bc992b823ea))


### Performance Improvements

* **player:** cache a cue cursor for the TV subtitle overlay ([#331](https://github.com/fliks-app/fliks/issues/331)) ([469afcd](https://github.com/fliks-app/fliks/commit/469afcd2b850c57c5c303a329283db16b6d7aa0e)), closes [#324](https://github.com/fliks-app/fliks/issues/324)


### Reverts

* **layout:** put requests back in the phone dock and history in the more menu ([#297](https://github.com/fliks-app/fliks/issues/297)) ([56506a8](https://github.com/fliks-app/fliks/commit/56506a898beb9c8d711bcc3ef55ebfec9eb14e22))


### Miscellaneous Chores

* prepare 1.7.2 release ([#267](https://github.com/fliks-app/fliks/issues/267)) ([198151d](https://github.com/fliks-app/fliks/commit/198151d5c65e44abfb9fe33920955e27c5f9dd68))
* set next release to 1.8.0 ([#376](https://github.com/fliks-app/fliks/issues/376)) ([8773f07](https://github.com/fliks-app/fliks/commit/8773f076f8362662adbec951a83fecedd415b7cb))

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
* **auth:** use userRole relation when rotating refresh tokens ([#261](https://github.com/fliks-app/fliks/issues/261)) ([4d4ed31](https://github.com/fliks-app/fliks/commit/4d4ed319970fa7cd24fe467d59d8330c47eb5e29))
* **auto-grab:** hydrate series quality/language profiles in SearchMissing ([#227](https://github.com/fliks-app/fliks/issues/227)) ([e7aa1f3](https://github.com/fliks-app/fliks/commit/e7aa1f3762bcb26773a30db583a580b361fa1851))
* **auto-match:** run on empty grabbed + heal mediaId-NULL rows + match by originalTitle ([#242](https://github.com/fliks-app/fliks/issues/242)) ([1f6706f](https://github.com/fliks-app/fliks/commit/1f6706f51591cc215814bb463c346cff46cd69dd))
* **ffprobe:** infer stream language from tags.title when language is und ([#262](https://github.com/fliks-app/fliks/issues/262)) ([eac8c4b](https://github.com/fliks-app/fliks/commit/eac8c4b446b7c2732d4a683d04e9d3c47805632c))
* **ffprobe:** read stream language/title tags case-insensitively ([#264](https://github.com/fliks-app/fliks/issues/264)) ([2af8073](https://github.com/fliks-app/fliks/commit/2af807393b3c1a4a079ceaaa14d9aa165f3503c9))
* **grab:** persist indexer on download-history rows from manual grabs ([#228](https://github.com/fliks-app/fliks/issues/228)) ([df4d4a1](https://github.com/fliks-app/fliks/commit/df4d4a1b8cc66e6a4cda901bbe111c7c3d967b27))
* **hls:** give each audio rendition a unique NAME ([#263](https://github.com/fliks-app/fliks/issues/263)) ([db1650e](https://github.com/fliks-app/fliks/commit/db1650e5d232008e7e67f282e4f4a7e21d20949b))
* **media-detail:** gate delete buttons on media.delete permission ([#220](https://github.com/fliks-app/fliks/issues/220)) ([5081449](https://github.com/fliks-app/fliks/commit/5081449f4b52a20c8d6c1d585e3218e6316d28f4))
* **media-info-header:** label letterboxed 1080p sources correctly ([#251](https://github.com/fliks-app/fliks/issues/251)) ([dbaa296](https://github.com/fliks-app/fliks/commit/dbaa296a6d318c8dc3835e5ad08538afcf950834))
* **media:** surface 4K releases in manual search ([#250](https://github.com/fliks-app/fliks/issues/250)) ([b75fa30](https://github.com/fliks-app/fliks/commit/b75fa3028aa4ef1ff37f9c66376393a50478bbd7))
* **player:** keep mobile play button slot during loading ([#255](https://github.com/fliks-app/fliks/issues/255)) ([2b17506](https://github.com/fliks-app/fliks/commit/2b17506fe714d7085cd8bf2d3fd46ada4391907a))
* **popover-menu:** keep options above &lt;dialog open&gt; top-layer ([#231](https://github.com/fliks-app/fliks/issues/231)) ([a1ac599](https://github.com/fliks-app/fliks/commit/a1ac599bf53deb961095771907c43f9f0b084f32))
* **quality:** route remaining bucketing through the shared helper ([#260](https://github.com/fliks-app/fliks/issues/260)) ([de66ecb](https://github.com/fliks-app/fliks/commit/de66ecb502a391fd151d284428f2e5084c01f08d))
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
