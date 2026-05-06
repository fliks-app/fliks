# Changelog

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
