# Changelog

## [1.4.0](https://github.com/fliks-app/fliks/compare/v1.3.1...v1.4.0) (2026-05-04)


### Features

* **providers:** bake TMDB & TVDB keys into image at build time ([#30](https://github.com/fliks-app/fliks/issues/30)) ([5380a45](https://github.com/fliks-app/fliks/commit/5380a45c0fc20379c091eb3cb0fb82a78b6350cf))


### Bug Fixes

* **i18n:** point empty-state CTA at libraries, not root folders ([#28](https://github.com/fliks-app/fliks/issues/28)) ([e5ad486](https://github.com/fliks-app/fliks/commit/e5ad48650cc2b0bdd7b639df1444dc13de9c4567))
* **rescan:** skip non-episode files in series folders, drop orphan rows ([#31](https://github.com/fliks-app/fliks/issues/31)) ([6f5fe03](https://github.com/fliks-app/fliks/commit/6f5fe03cc2c5756ffa8671caafaf4034872e86d5))
* **system:** read version from package.json, not npm env var ([#29](https://github.com/fliks-app/fliks/issues/29)) ([2a41be4](https://github.com/fliks-app/fliks/commit/2a41be414657589a418f46b55c0de9c68d09dbf7))

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
