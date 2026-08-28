# Changelog

## [3.5.0](https://github.com/fliks-app/fliks/compare/v3.4.1...v3.5.0) (2026-08-28)


### Features

* **account:** add spoiler protection for unwatched episodes ([#1108](https://github.com/fliks-app/fliks/issues/1108)) ([e22a4eb](https://github.com/fliks-app/fliks/commit/e22a4eb23171bb8c4e66632a55da7de65a6e3ac2))
* **acquisition:** hand the episode title down with the target ([#1103](https://github.com/fliks-app/fliks/issues/1103)) ([6f6bb78](https://github.com/fliks-app/fliks/commit/6f6bb787ca8ed4c846ab5eb7f2bf4b8364a902bd))
* **media-detail:** polish the season episode row ([#1107](https://github.com/fliks-app/fliks/issues/1107)) ([ff1b444](https://github.com/fliks-app/fliks/commit/ff1b444358fcb5488d344786dbd08aac7ceab798))
* **plugins:** let an admin waive the compatibility check and pick a version ([#1104](https://github.com/fliks-app/fliks/issues/1104)) ([b38f48a](https://github.com/fliks-app/fliks/commit/b38f48aab28d57f3943bcdb75f66f38a5d4d4456))
* **series:** keep the specials season instead of dropping it ([#1100](https://github.com/fliks-app/fliks/issues/1100)) ([4aded79](https://github.com/fliks-app/fliks/commit/4aded791e6fcfe78217c2f5e2b33a4b3970b09d0))
* **specials:** place a special file in season 0 instead of on a real episode ([#1102](https://github.com/fliks-app/fliks/issues/1102)) ([a9b0aa4](https://github.com/fliks-app/fliks/commit/a9b0aa4a26ddf7d7539828f9f9ca8c4231b8546b))
* **subtitles:** bleed the table to the modal edges on a phone ([#1118](https://github.com/fliks-app/fliks/issues/1118)) ([45ebadf](https://github.com/fliks-app/fliks/commit/45ebadfba2b74557a440e96ffccc4efd091ea6c2))


### Bug Fixes

* **auto-approval:** type the rule criteria and rebuild the editor ([#1092](https://github.com/fliks-app/fliks/issues/1092)) ([5c8a747](https://github.com/fliks-app/fliks/commit/5c8a747b71b2c645ff49d071c57d8381af8abc40))
* **bottom-sheet:** keep the host out of an enclosing modal's grid ([#1117](https://github.com/fliks-app/fliks/issues/1117)) ([5ff45ae](https://github.com/fliks-app/fliks/commit/5ff45ae3f865c47bf5b296cd1cc94e66268f4a09))
* **card-actions:** pad and bold the actions panel header ([#1116](https://github.com/fliks-app/fliks/issues/1116)) ([bc81dff](https://github.com/fliks-app/fliks/commit/bc81dffaad33575f14635d6ce6f5eed1f8664203))
* **downloads:** show download progress to everyone who can see the media ([#1112](https://github.com/fliks-app/fliks/issues/1112)) ([4bcf7e3](https://github.com/fliks-app/fliks/commit/4bcf7e32065fb8400cb3517f56073c6a2e9d13df))
* **home:** don't morph an unrelated poster when opening a recent request ([#1114](https://github.com/fliks-app/fliks/issues/1114)) ([b41e024](https://github.com/fliks-app/fliks/commit/b41e024d9149b81a60eb423ee97d879c86bbeff2))
* **import:** read a new title through the provider its library prefers ([#1101](https://github.com/fliks-app/fliks/issues/1101)) ([f5d7964](https://github.com/fliks-app/fliks/commit/f5d7964d37517ec0d00f56526c6995809edff106))
* **media-card:** hide the metadata actions on a card with no library row ([#1094](https://github.com/fliks-app/fliks/issues/1094)) ([8460f65](https://github.com/fliks-app/fliks/commit/8460f65ecd484447fad19f1b43b5a02333f4706e))
* **media-card:** place artwork behind a placeholder and drop the cold-start bridge wait ([#1120](https://github.com/fliks-app/fliks/issues/1120)) ([83b601c](https://github.com/fliks-app/fliks/commit/83b601c456ff3c38bbab1e7dc2cc7318311f0b25))
* **media-detail:** close the highlighted card border and keep the current season in the row ([#1119](https://github.com/fliks-app/fliks/issues/1119)) ([133d305](https://github.com/fliks-app/fliks/commit/133d305a31b91a5951a63a48f16f55e6f7da330a))
* **media-detail:** stop the resume bar flashing on a series page ([#1113](https://github.com/fliks-app/fliks/issues/1113)) ([56dc906](https://github.com/fliks-app/fliks/commit/56dc906ecc2b4de805706b58a94614fa94533e2e))
* **media-info:** always show the subtitle picker without the origin hint ([#1106](https://github.com/fliks-app/fliks/issues/1106)) ([a466d07](https://github.com/fliks-app/fliks/commit/a466d07abfa5e1bbe36be3a04cff0690851976cd))
* **metadata-search:** report why a provider search failed instead of a bare 500 ([#1098](https://github.com/fliks-app/fliks/issues/1098)) ([f0e83b1](https://github.com/fliks-app/fliks/commit/f0e83b1a08c06ec9f6273ee61cdbb2d2952d70ee))
* **migrations:** drop the criteria column default that fails the drift check ([#1095](https://github.com/fliks-app/fliks/issues/1095)) ([6379940](https://github.com/fliks-app/fliks/commit/6379940a813c7f2f32cac84a664c5ce353e5f1c8))
* **release-scoring:** refuse a sequel, another year, or a multi-film pack ([#1105](https://github.com/fliks-app/fliks/issues/1105)) ([7c6e764](https://github.com/fliks-app/fliks/commit/7c6e764bc016d07c8b79b56034ef81998d627c5c))
* **release-search:** stop an indexer tab spinning after the search answered ([#1097](https://github.com/fliks-app/fliks/issues/1097)) ([ad0232a](https://github.com/fliks-app/fliks/commit/ad0232ae66721367e931ae89c97bc99e4f9a6d1b))
* **release-sort:** rank a season pack above loose episodes at equal resolution ([#1096](https://github.com/fliks-app/fliks/issues/1096)) ([8c443ac](https://github.com/fliks-app/fliks/commit/8c443ac3267d0293544a16e677e88ac6664c1085))
* **series-refresh:** converge a season on one provider instead of mixing two ([#1099](https://github.com/fliks-app/fliks/issues/1099)) ([a29fac3](https://github.com/fliks-app/fliks/commit/a29fac39945469d212d1cac6014e6ab884408c2c))
* **spoilers:** mask the season synopsis too ([#1109](https://github.com/fliks-app/fliks/issues/1109)) ([64a05df](https://github.com/fliks-app/fliks/commit/64a05df51d221ad4b2d2a788feb28400d8e8f7c7))
* **spoilers:** mask the synopsis of an unwatched movie ([#1110](https://github.com/fliks-app/fliks/issues/1110)) ([d587035](https://github.com/fliks-app/fliks/commit/d587035105cefa368547533c5d4b074bb13f0a91))
* **subtitles:** scroll the modal action row instead of wrapping it ([#1115](https://github.com/fliks-app/fliks/issues/1115)) ([46378b1](https://github.com/fliks-app/fliks/commit/46378b1ac55a9c2cf3d44bb15ad4f0eb544dde4e))

## [3.4.1](https://github.com/fliks-app/fliks/compare/v3.4.0...v3.4.1) (2026-08-27)


### Bug Fixes

* **card-actions:** swap submenus in place on the sheet instead of stacking ([#1086](https://github.com/fliks-app/fliks/issues/1086)) ([370cad8](https://github.com/fliks-app/fliks/commit/370cad84afbe5076172eafc7283c721f99b8b6f0))
* **ci:** fall back to the newest mpv winbuild when the pin is gone ([#1080](https://github.com/fliks-app/fliks/issues/1080)) ([770b9bc](https://github.com/fliks-app/fliks/commit/770b9bc706754d11ee3c2eef31f69cb5568646ff))
* **identify:** finish the job — relink the files, refresh off the request, bust the image cache ([#1085](https://github.com/fliks-app/fliks/issues/1085)) ([83e81f0](https://github.com/fliks-app/fliks/commit/83e81f050ea2644f284abab8febe0a7d14b28228))
* **identify:** make re-identification work on a TVDB library ([#1083](https://github.com/fliks-app/fliks/issues/1083)) ([50d7546](https://github.com/fliks-app/fliks/commit/50d7546e6924039cda62109490eb646b462e9714))
* **media-menu:** stop doubling Download and Edit subtitles on an episode ([#1082](https://github.com/fliks-app/fliks/issues/1082)) ([01ca716](https://github.com/fliks-app/fliks/commit/01ca716172641280cdff1568a8b4ac15b7fd460d))
* **releases:** let the table reach the modal edges on a narrow screen ([#1091](https://github.com/fliks-app/fliks/issues/1091)) ([258e5f0](https://github.com/fliks-app/fliks/commit/258e5f0db9ca55923564f0701895443dea28c4ba))
* **releases:** stop the mobile row overflowing sideways ([#1089](https://github.com/fliks-app/fliks/issues/1089)) ([60541d6](https://github.com/fliks-app/fliks/commit/60541d63fcc5d17069f2917ea0cdeec4faf42305))

## [3.4.0](https://github.com/fliks-app/fliks/compare/v3.3.0...v3.4.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* **plugin-ui:** one list, one dispatcher, one resolver for media menus
* **profiles:** a fresh install starts with no quality profile, so auto-grab reports unprofiled until an admin creates one. Existing rows are left untouched - no migration deletes them.

### Features

* **media-detail:** identify a media from its actions menu ([dd35ae6](https://github.com/fliks-app/fliks/commit/dd35ae6ee9d7dab2e9467e6bf4188319f7208011))
* **media-menu:** group the actions into submenus, with Like and Download ([ad05331](https://github.com/fliks-app/fliks/commit/ad05331d8f979241c33707042639b600290a3811))
* **media-menu:** open the tracking and identify dialogs in place ([216d756](https://github.com/fliks-app/fliks/commit/216d756bc1fd409da15e392f2418537e081c1317))
* **media:** re-point a media at another work ([c9bf9d6](https://github.com/fliks-app/fliks/commit/c9bf9d654e436c757f3c276e96a3554449131fa8))
* **plugin-ui:** add a surface predicate to when ([ae60f51](https://github.com/fliks-app/fliks/commit/ae60f510eef3d2ab72cfc5192eb61418adc4b75c))
* **profiles:** stop seeding a default quality and language profile ([3115375](https://github.com/fliks-app/fliks/commit/31153759b3fded3d09f9563b06f80145e21ca9f2))
* **requests:** act on a pending request from the title preview ([8c9dc82](https://github.com/fliks-app/fliks/commit/8c9dc825066d4f7c1dacdd2524ab67cda15bf887))
* **subtitles:** report why a provider connection test failed ([5995e7e](https://github.com/fliks-app/fliks/commit/5995e7ec2e252eb2b2e8b343815b73cbfb91d9c7))


### Bug Fixes

* **auto-grab:** accept any language when no language profile is set ([f0ee821](https://github.com/fliks-app/fliks/commit/f0ee82169bc4a38c933212ec90822e3b75c6aae5))
* **db:** clear the entity drift and enforce the CI check ([#1070](https://github.com/fliks-app/fliks/issues/1070)) ([f034abe](https://github.com/fliks-app/fliks/commit/f034abe10aa70507204987ae32d4c9c5c191c2d2)), closes [#1057](https://github.com/fliks-app/fliks/issues/1057)
* **focus-ring:** keep the ring visible in three more scrollers ([41486f0](https://github.com/fliks-app/fliks/commit/41486f0b71164825c82a42810645baddd30f6081))
* **focus-ring:** keep the ring visible inside scroll containers ([bdd00a9](https://github.com/fliks-app/fliks/commit/bdd00a934df7a1868d347645bc0b072ef38643c0))
* **media-menu:** keep the page-owned dialogs off a card, refresh in place ([704edef](https://github.com/fliks-app/fliks/commit/704edef38dceffd302dd8bd5af2aeffadbd92be0))
* **media-menu:** side flyout, card routing and the two live toggles ([3eb4229](https://github.com/fliks-app/fliks/commit/3eb4229a5416c60e59f891003093a8f87fbbb298))
* **provider-list:** center the editor modal header ([ac6419c](https://github.com/fliks-app/fliks/commit/ac6419c9fe16f1ecf6b5417e552ee9e3c0d4e47d))
* **requests:** hide the import button while a request is pending, and unify the labels ([1ca873e](https://github.com/fliks-app/fliks/commit/1ca873e5cb18d2ff3ac0e97da8190994f50eb3c5))
* **scheduler:** walk the subtitle passes in batches instead of all at once ([236c84d](https://github.com/fliks-app/fliks/commit/236c84d83c39fc54ba0da690afd5682f59b9f9e2))
* **subtitles:** stop the missing-subtitles list from hanging the server ([f3c75f5](https://github.com/fliks-app/fliks/commit/f3c75f56ccc75ed563a25597922c759c247a7f50))


### Performance Improvements

* **notifications:** dispatch download.complete before the episode lookup ([#1071](https://github.com/fliks-app/fliks/issues/1071)) ([dffdc64](https://github.com/fliks-app/fliks/commit/dffdc6454d7ece740d2f7809977f32f3f7184cf5)), closes [#893](https://github.com/fliks-app/fliks/issues/893)


### Miscellaneous Chores

* cut the next release as 3.4.0 ([#1076](https://github.com/fliks-app/fliks/issues/1076)) ([a28928b](https://github.com/fliks-app/fliks/commit/a28928b73d191b231542f4916a2074c660fc6b3f))


### Code Refactoring

* **plugin-ui:** one list, one dispatcher, one resolver for media menus ([c0ea0e2](https://github.com/fliks-app/fliks/commit/c0ea0e229025b4627f57e424b373143d64cbaa7f))

## [3.3.0](https://github.com/fliks-app/fliks/compare/v3.2.1...v3.3.0) (2026-08-27)


### Features

* **offline:** rework downloads, artwork cache and playback sync ([#1060](https://github.com/fliks-app/fliks/issues/1060)) ([9a6ba72](https://github.com/fliks-app/fliks/commit/9a6ba721d033f5e490ed166c7d27a4c1f2f9a66a))


### Bug Fixes

* **release:** restore the iOS version markers and fail on unreadable commits ([#1061](https://github.com/fliks-app/fliks/issues/1061)) ([c8750b8](https://github.com/fliks-app/fliks/commit/c8750b830c878e3aab33511b00ae7d5bf05ad70c))
* **streaming:** resume a slept client on the sid it already holds ([#1058](https://github.com/fliks-app/fliks/issues/1058)) ([fab97f5](https://github.com/fliks-app/fliks/commit/fab97f551f1585d1a348591db04ab995e5d252b1))

## [3.2.1](https://github.com/fliks-app/fliks/compare/v3.2.0...v3.2.1) (2026-08-26)


### Bug Fixes

* **acquisition:** offer a packed season its episodes, and say why a row was skipped ([#1053](https://github.com/fliks-app/fliks/issues/1053)) ([cfe1c8c](https://github.com/fliks-app/fliks/commit/cfe1c8cb573cb9576aa5d78fc41c4eaed1dd88ed))
* **acquisition:** stop dropping every series candidate, and unbound the sweep's deadline ([#1055](https://github.com/fliks-app/fliks/issues/1055)) ([b6fe715](https://github.com/fliks-app/fliks/commit/b6fe71572debf0c6578465a789107527b0dc75ec))
* **release-scoring:** season packs, resolution upgrades, coverage, and remove delay profiles ([#1056](https://github.com/fliks-app/fliks/issues/1056)) ([1a3a5a2](https://github.com/fliks-app/fliks/commit/1a3a5a236105f6e6d9e760248f2a74ff0af78f93))

## [3.2.0](https://github.com/fliks-app/fliks/compare/v3.1.0...v3.2.0) (2026-08-26)


### Features

* **media-detail:** show the file import date in the file info panel ([#1039](https://github.com/fliks-app/fliks/issues/1039)) ([d111ab8](https://github.com/fliks-app/fliks/commit/d111ab8b5489039a18d92066fd7a1fa97f92c533))
* **plugin-catalogue:** state the version running instead of listing every version offered ([#1048](https://github.com/fliks-app/fliks/issues/1048)) ([fca84a7](https://github.com/fliks-app/fliks/commit/fca84a7ac624fea2ceae5da229a787739f4fb747))
* **provider-list:** show the cooldown a row is in, and thin the actions cell ([#1047](https://github.com/fliks-app/fliks/issues/1047)) ([c830dc6](https://github.com/fliks-app/fliks/commit/c830dc6e4dc64752d163591166106dcbe88d2843))
* **release-picker:** fill the modal as indexers answer, with a tab per indexer ([#1040](https://github.com/fliks-app/fliks/issues/1040)) ([c4b3fe8](https://github.com/fliks-app/fliks/commit/c4b3fe80026fedd8e86e2ebd4248f88e85f8c405))
* **secrets:** let a client erase a stored credential with an explicit null ([#1032](https://github.com/fliks-app/fliks/issues/1032)) ([e523ed0](https://github.com/fliks-app/fliks/commit/e523ed0105b742fd57d64ebd99b8e25e96ed3931))


### Bug Fixes

* **media-detail:** track grab-best per target so several can run at once ([#1036](https://github.com/fliks-app/fliks/issues/1036)) ([dc4902e](https://github.com/fliks-app/fliks/commit/dc4902ee68f6fcc7f9851f996108e7cdae588606))
* **notifications:** derive one event vocabulary instead of three that disagree ([#1034](https://github.com/fliks-app/fliks/issues/1034)) ([610365c](https://github.com/fliks-app/fliks/commit/610365c96dfb1636c6c885ee99301e773f8e7982))
* **plugin-ui:** re-merge plugin translations whenever the registry reloads ([#1037](https://github.com/fliks-app/fliks/issues/1037)) ([1b956c3](https://github.com/fliks-app/fliks/commit/1b956c33ec205cab9fbd024a266db5ec050eb389))
* **plugins:** only offer a catalog version core could verify ([#1050](https://github.com/fliks-app/fliks/issues/1050)) ([f23283b](https://github.com/fliks-app/fliks/commit/f23283b8a1a694262ac340354f945a8ae1887514))
* **plugins:** refresh stale catalog sources at boot, not only at 3am ([#1038](https://github.com/fliks-app/fliks/issues/1038)) ([7aa2dee](https://github.com/fliks-app/fliks/commit/7aa2dee2cb93f0a9008cf39e6a8ac13f56af49f3))
* **plugins:** stop showing an install error twice ([#1049](https://github.com/fliks-app/fliks/issues/1049)) ([f2d40af](https://github.com/fliks-app/fliks/commit/f2d40af4139d04bf9d2dbc1023a53aad04de9fef))
* **release-picker:** give an empty search its own centred state ([#1042](https://github.com/fliks-app/fliks/issues/1042)) ([46b1fad](https://github.com/fliks-app/fliks/commit/46b1fad175b95b742178620ffdc2810e719f5fbb))
* **release-picker:** keep each indexer tab on one line, and move progress into the strip ([#1041](https://github.com/fliks-app/fliks/issues/1041)) ([0a16b35](https://github.com/fliks-app/fliks/commit/0a16b3507642b5d2ae341b9b1d0a46890983db50))
* **release-picker:** stop the release table nesting a second vertical scrollbar ([#1046](https://github.com/fliks-app/fliks/issues/1046)) ([e3dc21b](https://github.com/fliks-app/fliks/commit/e3dc21be9bb938a090924a66129d3a11faf0e97f))
* **release-picker:** tell apart a tab still searching, one that failed, and one with no hits ([#1043](https://github.com/fliks-app/fliks/issues/1043)) ([1bb2f59](https://github.com/fliks-app/fliks/commit/1bb2f59ca21cecd33bb845dd493aebc4d26b327a))
* **release-scoring:** honour the requested episode and season scope ([#1035](https://github.com/fliks-app/fliks/issues/1035)) ([0909c07](https://github.com/fliks-app/fliks/commit/0909c07db353e6a6c1d9f95414767ee7aaebee47))

## [3.1.0](https://github.com/fliks-app/fliks/compare/v3.0.0...v3.1.0) (2026-08-21)


### Features

* **docker:** add a compose dev stack, and drop the Dockerfiles it replaces ([#1028](https://github.com/fliks-app/fliks/issues/1028)) ([421aec5](https://github.com/fliks-app/fliks/commit/421aec58c08528e9da631d612d21e62ce2262f69))
* **libraries:** replace the creation modal with a 3-step wizard page ([#1031](https://github.com/fliks-app/fliks/issues/1031)) ([f94b12d](https://github.com/fliks-app/fliks/commit/f94b12dabec0bb0c676649a1f8d160a410ce0436))


### Bug Fixes

* **docker:** publish the runtime stage, not whatever ends the Dockerfile ([#1030](https://github.com/fliks-app/fliks/issues/1030)) ([cf51c75](https://github.com/fliks-app/fliks/commit/cf51c75b70cb315fa02f01ae40da009c8ad7bf91))

## [3.0.0](https://github.com/fliks-app/fliks/compare/v2.0.1...v3.0.0) (2026-08-19)


### Features

* **client:** stop the client naming the acquisition plugin ([#945](https://github.com/fliks-app/fliks/issues/945)) ([4d73b08](https://github.com/fliks-app/fliks/commit/4d73b08e02e43b39ec2402ee37e7d406d7cf97f9))
* **download:** make the download bundle optional and prove the boundary ([#934](https://github.com/fliks-app/fliks/issues/934)) ([5c7b877](https://github.com/fliks-app/fliks/commit/5c7b877d3e7112a83065af4b33dc74730aaaba4b)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **events:** add a domain event bus alongside the SSE one ([#885](https://github.com/fliks-app/fliks/issues/885)) ([eb688d0](https://github.com/fliks-app/fliks/commit/eb688d0ed71d85f121e756841b158f3fec142523))
* **indexers:** let an admin actually add a plugin-declared tracker ([#912](https://github.com/fliks-app/fliks/issues/912)) ([36fcd90](https://github.com/fliks-app/fliks/commit/36fcd906a3c26e8c6184df66dfac5b786d18ea20))
* **media-detail:** bring back the release picker, opened by plugin contributions ([#954](https://github.com/fliks-app/fliks/issues/954)) ([9257068](https://github.com/fliks-app/fliks/commit/9257068661db385cc90e93e7b9549ec35dfce965))
* **notifications:** authenticate ntfy pushes and expose webhook tokens ([#1002](https://github.com/fliks-app/fliks/issues/1002)) ([d0994a8](https://github.com/fliks-app/fliks/commit/d0994a8051fe03118cb5882b97789093a97502fa))
* **player:** play the pre-roll items a plugin named before the main video ([#988](https://github.com/fliks-app/fliks/issues/988)) ([1adb6bc](https://github.com/fliks-app/fliks/commit/1adb6bcf67598587abbdad134f6cddc6d10e48e1))
* **plugin-ui:** a speed format, a clipped column, and a table that refreshes ([#1022](https://github.com/fliks-app/fliks/issues/1022)) ([d1aeea4](https://github.com/fliks-app/fliks/commit/d1aeea47bae4a614e38348ae441e05113a83e4c4))
* **plugin-ui:** add the providers and table view kinds ([#928](https://github.com/fliks-app/fliks/issues/928)) ([b5094ee](https://github.com/fliks-app/fliks/commit/b5094ee4902c28edb3fad68551fd443af7f87aab)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugin-ui:** let a plugin's pages express a real admin surface ([#948](https://github.com/fliks-app/fliks/issues/948)) ([ebb042e](https://github.com/fliks-app/fliks/commit/ebb042eaeed16e2e03475f2c198e155981999b26))
* **plugin-ui:** registry, when evaluator and i18n merge for plugin contributions ([#923](https://github.com/fliks-app/fliks/issues/923)) ([fbbc765](https://github.com/fliks-app/fliks/commit/fbbc765cccc62c1f4186516ddb29c7cabb41bda3)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugin-ui:** render a GET row action's answer as its declared table ([#953](https://github.com/fliks-app/fliks/issues/953)) ([640d9cd](https://github.com/fliks-app/fliks/commit/640d9cd47ccbc45a0615cfef247308a3b8b895af))
* **plugin-ui:** render media-card actions from the contribution registry ([#929](https://github.com/fliks-app/fliks/issues/929)) ([d3ca158](https://github.com/fliks-app/fliks/commit/d3ca158557d7ddae4ab09b9293584ccca1ee2249)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugin-ui:** render the admin settings sidebar from the registry ([#926](https://github.com/fliks-app/fliks/issues/926)) ([bf93823](https://github.com/fliks-app/fliks/commit/bf938236ae720ec8602b5b855e971a3666d2049f)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugin-ui:** render the main navigation from the contribution registry ([#925](https://github.com/fliks-app/fliks/issues/925)) ([af590c5](https://github.com/fliks-app/fliks/commit/af590c548c233a58b35d3f667195134068698550))
* **plugin-ui:** render the media-detail action menu from the registry ([#927](https://github.com/fliks-app/fliks/issues/927)) ([b189e66](https://github.com/fliks-app/fliks/commit/b189e667f180b7003963257533c09a2539988f89)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugin-view:** badges and nowrap on a declared table column ([#1008](https://github.com/fliks-app/fliks/issues/1008)) ([76e5485](https://github.com/fliks-app/fliks/commit/76e54852b06d4ba3d8dd51e4e25beb3e9f20491d))
* **plugin-view:** open a cell's detail in a dialog, and read tables at text-sm ([#1009](https://github.com/fliks-app/fliks/issues/1009)) ([7885e20](https://github.com/fliks-app/fliks/commit/7885e207ae6f78fb5b477300da52b67e735fb4c2))
* **plugins:** a settings dialog, and an opt-in daily plugin update ([#1013](https://github.com/fliks-app/fliks/issues/1013)) ([eccbb1f](https://github.com/fliks-app/fliks/commit/eccbb1fc9cc9e5f2dd8ff8821f3f494409b37955))
* **plugins:** add sources management and catalogue browsing ([#914](https://github.com/fliks-app/fliks/issues/914)) ([532f123](https://github.com/fliks-app/fliks/commit/532f123c6784dce1150d60cbe4da6534186420e2))
* **plugins:** add the plugin contract as types only ([#889](https://github.com/fliks-app/fliks/issues/889)) ([ebbc02d](https://github.com/fliks-app/fliks/commit/ebbc02dab5ba8b1be850008507d57bb50144c2b3))
* **plugins:** add the plugins admin page and its install consent sheet ([#906](https://github.com/fliks-app/fliks/issues/906)) ([a9831af](https://github.com/fliks-app/fliks/commit/a9831af42d8fb12c9973d26fd0ce1b0ea837abc7))
* **plugins:** add the three plugin tables and the data-tier validator ([#899](https://github.com/fliks-app/fliks/issues/899)) ([4e4425e](https://github.com/fliks-app/fliks/commit/4e4425e26a142129b27dc1b90e0d668295618b00))
* **plugins:** answer each plugin in its own contract revision ([#981](https://github.com/fliks-app/fliks/issues/981)) ([92a6cf0](https://github.com/fliks-app/fliks/commit/92a6cf04e6f830b71d18a5118dc525e2e01d930b))
* **plugins:** bind a host instance to the plugin that owns the call ([#946](https://github.com/fliks-app/fliks/issues/946)) ([614983a](https://github.com/fliks-app/fliks/commit/614983ad05201f8b30be24f115429cf5e4588b69))
* **plugins:** collapse stalled-download cleanup into four plugin settings ([#942](https://github.com/fliks-app/fliks/issues/942)) ([95ba9c2](https://github.com/fliks-app/fliks/commit/95ba9c263c3a77cee406c6d15ce50231a0056321))
* **plugins:** deliver domain events to plugin-declared webhooks ([#903](https://github.com/fliks-app/fliks/issues/903)) ([fe5dd94](https://github.com/fliks-app/fliks/commit/fe5dd942431a61209216db9feaa8781c98acc415))
* **plugins:** detach the bundle module and close the host contract gaps ([#937](https://github.com/fliks-app/fliks/issues/937)) ([5c29aff](https://github.com/fliks-app/fliks/commit/5c29aff57cf3ce787e91d5239cf3f6ce49e99a80))
* **plugins:** fence the plugin off from core and convert what is provably equivalent ([#936](https://github.com/fliks-app/fliks/issues/936)) ([8f6462b](https://github.com/fliks-app/fliks/commit/8f6462b5e616d944fff3dcbcd3ddf6be6bfd90bc)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugins:** fetch and cache signed plugin catalogs ([#904](https://github.com/fliks-app/fliks/issues/904)) ([1e64138](https://github.com/fliks-app/fliks/commit/1e64138f8cb10347dab324e093f39c8cd5aef696))
* **plugins:** freeze the contract items a major locks in ([#984](https://github.com/fliks-app/fliks/issues/984)) ([0fff3ff](https://github.com/fliks-app/fliks/commit/0fff3ffc22c047e7a165ae36f4608ac4b07df44c))
* **plugins:** give a form page captions, sections and a status line ([#989](https://github.com/fliks-app/fliks/issues/989)) ([9d041cc](https://github.com/fliks-app/fliks/commit/9d041ccbe324cc7624b92457b7445b2b18560a6c))
* **plugins:** give the plugin API a deprecation window, and let a prerelease rehearse it ([#978](https://github.com/fliks-app/fliks/issues/978)) ([ac48254](https://github.com/fliks-app/fliks/commit/ac48254a1c08c1ca29a44e7794a0c58646cf7017))
* **plugins:** implement core's side of the 17 plugin-facing methods ([#935](https://github.com/fliks-app/fliks/issues/935)) ([5590035](https://github.com/fliks-app/fliks/commit/559003557167981b46a8daec2b190a9ae6c922dc)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugins:** install, update and uninstall a data plugin ([#905](https://github.com/fliks-app/fliks/issues/905)) ([91bfae6](https://github.com/fliks-app/fliks/commit/91bfae63620bb85ac6f2e0ab9489c5b2601e8b3e))
* **plugins:** let a data plugin declare a Torznab tracker ([#901](https://github.com/fliks-app/fliks/issues/901)) ([4f7a63f](https://github.com/fliks-app/fliks/commit/4f7a63ff4576409d9ffc502bedc8f7c68233afee))
* **plugins:** let a data plugin's webhook point at the operator's own endpoint ([#966](https://github.com/fliks-app/fliks/issues/966)) ([bdcd69f](https://github.com/fliks-app/fliks/commit/bdcd69f0c436cab3e999fc450efdd08b0cb2ce6f))
* **plugins:** let a form page offer a test of the event delivery core performs for it ([#968](https://github.com/fliks-app/fliks/issues/968)) ([358c74c](https://github.com/fliks-app/fliks/commit/358c74c6ec26b42367ebffdc93408a4acd484bd2))
* **plugins:** let a plugin declare its own permissions and jobs ([#921](https://github.com/fliks-app/fliks/issues/921)) ([51d8c7a](https://github.com/fliks-app/fliks/commit/51d8c7aa79f07b2caa53df9ceb0fe8aa15ff1b2c)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugins:** let a plugin name what plays before the main video ([#987](https://github.com/fliks-app/fliks/issues/987)) ([f607d7d](https://github.com/fliks-app/fliks/commit/f607d7d55131163c472add24ff3e797fe4af97a6))
* **plugins:** let a spawned plugin's host calls reach core ([#949](https://github.com/fliks-app/fliks/issues/949)) ([5c9d75c](https://github.com/fliks-app/fliks/commit/5c9d75c1cb482c333bf62033ecfc08dba966749c))
* **plugins:** let a table view declare server-side filters ([#973](https://github.com/fliks-app/fliks/issues/973)) ([84439bf](https://github.com/fliks-app/fliks/commit/84439bff2e72e927e9be20e38ad98aaa2e5db996))
* **plugins:** let core boot with no acquisition code at all ([#944](https://github.com/fliks-app/fliks/issues/944)) ([9aeb287](https://github.com/fliks-app/fliks/commit/9aeb2879be776bac7ed9dafd73361d506112ede1))
* **plugins:** let the bundle own its counts, its job names and stall detection ([#941](https://github.com/fliks-app/fliks/issues/941)) ([9a55916](https://github.com/fliks-app/fliks/commit/9a5591617dd53e04154505b8809181735219a811))
* **plugins:** load installed plugins into a registry at boot ([#900](https://github.com/fliks-app/fliks/issues/900)) ([f75c1c4](https://github.com/fliks-app/fliks/commit/f75c1c46cc0227e9d924676321d4c874043349bc))
* **plugins:** make a plugin's runtime observable, and stop losing its state on every start ([#982](https://github.com/fliks-app/fliks/issues/982)) ([fb4fd54](https://github.com/fliks-app/fliks/commit/fb4fd542eebcf5fd45dbfe560a26274916700271))
* **plugins:** make acquisition plugin-only ([#947](https://github.com/fliks-app/fliks/issues/947)) ([2fbd7aa](https://github.com/fliks-app/fliks/commit/2fbd7aa0d71fbc0d97aa4915383bc21b680adf17))
* **plugins:** move the blocklist to the bundle that owns its domain ([#943](https://github.com/fliks-app/fliks/issues/943)) ([783fe6b](https://github.com/fliks-app/fliks/commit/783fe6b9922d2d3abc7b5e2a93adca37b1fed4a1))
* **plugins:** offer a newer version to a plugin that is already installed ([#971](https://github.com/fliks-app/fliks/issues/971)) ([bd1d0cc](https://github.com/fliks-app/fliks/commit/bd1d0ccaff9af48239f07d0ca721bfb26acd197e))
* **plugins:** provision a postgres role and schema per process plugin ([#918](https://github.com/fliks-app/fliks/issues/918)) ([e41c36e](https://github.com/fliks-app/fliks/commit/e41c36eb53413c7af18b9124190ef11128845783))
* **plugins:** proxy a process plugin's declared routes behind a policy guard ([#920](https://github.com/fliks-app/fliks/issues/920)) ([a461188](https://github.com/fliks-app/fliks/commit/a461188db852a8364f9903d99536da81b37384c5)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugins:** publish the contract instead of restating it ([#992](https://github.com/fliks-app/fliks/issues/992)) ([91d7a4e](https://github.com/fliks-app/fliks/commit/91d7a4e1b9145179cb267d6822206e533cb0525b)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugins:** publish the handshake, enforce the scopes, name the errors ([#976](https://github.com/fliks-app/fliks/issues/976)) ([a8c9fb5](https://github.com/fliks-app/fliks/commit/a8c9fb5e622a4216cc1423bee7fb75c6dc069cef))
* **plugins:** report what each process plugin costs the host ([#991](https://github.com/fliks-app/fliks/issues/991)) ([fdb4319](https://github.com/fliks-app/fliks/commit/fdb431915c648a95914b37e05d00e348712f5692)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugins:** revoke a published plugin, and carry its state across a reinstall ([#990](https://github.com/fliks-app/fliks/issues/990)) ([738934f](https://github.com/fliks-app/fliks/commit/738934fdf32838c05c75d0e7d6c688a794b98e67))
* **plugins:** run a process-tier plugin under the supervisor ([#919](https://github.com/fliks-app/fliks/issues/919)) ([54f6257](https://github.com/fliks-app/fliks/commit/54f625718b0cc8cf77a564732f78c7806e7ade46))
* **plugins:** run each plugin under its own uid ([#985](https://github.com/fliks-app/fliks/issues/985)) ([bf1c0c8](https://github.com/fliks-app/fliks/commit/bf1c0c81aa5a77f8f39ce9d8931778acf569c42b))
* **plugins:** ship a packaging tool, so an author does not hand-roll an archive ([#986](https://github.com/fliks-app/fliks/issues/986)) ([4ef2b88](https://github.com/fliks-app/fliks/commit/4ef2b883f3c958dfae9f120b5e8a5b401a4bd267))
* **plugins:** ship a scaffold that starts, and say what an archive can hold ([#993](https://github.com/fliks-app/fliks/issues/993)) ([5d79852](https://github.com/fliks-app/fliks/commit/5d798520a52c692437acdc6b66aa5a4f93a9975e)), closes [#894](https://github.com/fliks-app/fliks/issues/894)
* **plugins:** stop core from knowing what a download client is ([#938](https://github.com/fliks-app/fliks/issues/938)) ([078e2fb](https://github.com/fliks-app/fliks/commit/078e2fb29bb8cb4a810bd653bef578a759d62022))
* **plugins:** supervise a plugin process over a socket pair ([#917](https://github.com/fliks-app/fliks/issues/917)) ([0014476](https://github.com/fliks-app/fliks/commit/0014476c08310e0c72f523b31a4e674a9f164668))
* **plugins:** switch an installed plugin off without destroying it ([#962](https://github.com/fliks-app/fliks/issues/962)) ([9677ef4](https://github.com/fliks-app/fliks/commit/9677ef423af2b92e11a1ffed9f0a37328bc6bdeb))
* **plugins:** trust the official catalog signing key ([#909](https://github.com/fliks-app/fliks/issues/909)) ([362418d](https://github.com/fliks-app/fliks/commit/362418d087e944e3bef5768b7d2136be67e2c286))
* **plugins:** update plugins by default, and reuse the shared toggle ([#1014](https://github.com/fliks-app/fliks/issues/1014)) ([326d447](https://github.com/fliks-app/fliks/commit/326d44738b42850b8187f92d53917da8457682ac))
* **plugins:** validate plugin archives before anything touches disk ([#897](https://github.com/fliks-app/fliks/issues/897)) ([64a7026](https://github.com/fliks-app/fliks/commit/64a7026528e52240d3ec15839f6f8e3ce31b6ddc))
* **schedulers:** list the plugin-source refresh, and stop core naming plugin jobs ([#1012](https://github.com/fliks-app/fliks/issues/1012)) ([663e977](https://github.com/fliks-app/fliks/commit/663e9775111a5c8f0ea9f48f055c8a5dcf34b01c))
* **settings:** move subtitle activity into the admin settings sidebar ([#960](https://github.com/fliks-app/fliks/issues/960)) ([cdb59ea](https://github.com/fliks-app/fliks/commit/cdb59eaea50795f64f25a40624ee2810c449b42a))
* **settings:** schema-driven form and a shared secret-field contract ([#924](https://github.com/fliks-app/fliks/issues/924)) ([631bae1](https://github.com/fliks-app/fliks/commit/631bae1e48172eb8edb2ec8ba17bf7fefc89fe0e))
* **store:** add the App Store screenshot sets for iPhone, iPad and Apple TV ([#862](https://github.com/fliks-app/fliks/issues/862)) ([8a4e06d](https://github.com/fliks-app/fliks/commit/8a4e06dd1fc372adbfff398dce425694371b12e3))


### Bug Fixes

* **acquisition:** let a manual release search reach the indexers ([#974](https://github.com/fliks-app/fliks/issues/974)) ([543b468](https://github.com/fliks-app/fliks/commit/543b468b22540e7ae313c9d6bf41e4c0cc23b4ad))
* **auth:** deny handlers that declare no policy in PoliciesGuard ([#872](https://github.com/fliks-app/fliks/issues/872)) ([c907bdf](https://github.com/fliks-app/fliks/commit/c907bdfabc2aee1a8319cf4588bbe9ed3feb0d82))
* **auth:** let an authenticated user open the event stream again ([#956](https://github.com/fliks-app/fliks/issues/956)) ([e3fbe8a](https://github.com/fliks-app/fliks/commit/e3fbe8a49d2c9ef1e5ba03cf1b5358ea8668c9ba))
* **auth:** stop leaking settings and provider credentials to requesters ([#871](https://github.com/fliks-app/fliks/issues/871)) ([22918c9](https://github.com/fliks-app/fliks/commit/22918c9db77ea9a5458c9f94256e541e73199f35))
* **backend:** pin the build output layout so dist/main is where the image runs it ([#999](https://github.com/fliks-app/fliks/issues/999)) ([ec7de96](https://github.com/fliks-app/fliks/commit/ec7de96312246cd476e809793f4d3269633f2139))
* **blocklist:** enforce source-title uniqueness, drop raw SQL on requests ([#870](https://github.com/fliks-app/fliks/issues/870)) ([88173bd](https://github.com/fliks-app/fliks/commit/88173bd37a4303b6e31b4c660e84838f15a200f9))
* **boot:** survive an operator-imposed container uid ([#874](https://github.com/fliks-app/fliks/issues/874)) ([8e8dd74](https://github.com/fliks-app/fliks/commit/8e8dd748a2a761c61225d525ae8a6b104b7f8541))
* **client:** stop replaying a stale SSE event and coalesce redundant refetches ([#996](https://github.com/fliks-app/fliks/issues/996)) ([e68ddad](https://github.com/fliks-app/fliks/commit/e68ddadd23b8e9aff7e9b60b65047e2a7fc1bec5))
* **compose:** point the segment cache at the volume mounted for it ([#875](https://github.com/fliks-app/fliks/issues/875)) ([3fddb80](https://github.com/fliks-app/fliks/commit/3fddb8078ead460f252974406281a2e6a2c629cf))
* **db:** store every creation and update timestamp as timestamptz ([#910](https://github.com/fliks-app/fliks/issues/910)) ([bf37f99](https://github.com/fliks-app/fliks/commit/bf37f992c5cc75661c477a9efaf533f00fcb86ea))
* **docker:** swap pgsrip's opencv-python for the headless build ([#866](https://github.com/fliks-app/fliks/issues/866)) ([10f96a4](https://github.com/fliks-app/fliks/commit/10f96a4fdc5ddf9499963dd17fda167c32534f8c))
* **events:** catch rejected promises from domain event handlers ([#890](https://github.com/fliks-app/fliks/issues/890)) ([103d925](https://github.com/fliks-app/fliks/commit/103d92572c4d53d15549954997ed4edc92510743))
* **i18n:** describe plugins by what they do, not by today's features ([#911](https://github.com/fliks-app/fliks/issues/911)) ([13ac7b9](https://github.com/fliks-app/fliks/commit/13ac7b921c9f62b7e04d78a6c99e6c23cd1ef519))
* **i18n:** name the manual install action for what it does ([#915](https://github.com/fliks-app/fliks/issues/915)) ([eaab620](https://github.com/fliks-app/fliks/commit/eaab620e23dbadfa6e5ac9851e7826bed5ada807))
* **i18n:** say the uninstall prompt in the reader's terms ([#965](https://github.com/fliks-app/fliks/issues/965)) ([d7df715](https://github.com/fliks-app/fliks/commit/d7df715e9cdfd1854c2dbb3ea064a3b89ae57e0b))
* **library-ingest:** stop duplicating rows and mislabelling successful imports ([#881](https://github.com/fliks-app/fliks/issues/881)) ([9bd0a45](https://github.com/fliks-app/fliks/commit/9bd0a4509d5090e95f20b9beb230d445666c5c23))
* localize hardcoded French option labels, document the default login ([#1006](https://github.com/fliks-app/fliks/issues/1006)) ([6ee8abd](https://github.com/fliks-app/fliks/commit/6ee8abd65da7bbd757fd2bc25614098594baf104))
* **media-detail:** clear the resume state when the header switches episode ([#1017](https://github.com/fliks-app/fliks/issues/1017)) ([5ea8c8f](https://github.com/fliks-app/fliks/commit/5ea8c8fc9936975a0b50357acfb31bc5d36a0dd6))
* **media:** stop a failed probe from downgrading a file to 480p ([#880](https://github.com/fliks-app/fliks/issues/880)) ([d30064b](https://github.com/fliks-app/fliks/commit/d30064b083d58cb815c39fe4cb765b146f64fdfa))
* **navbar:** keep back arrow visible after a hard refresh ([#869](https://github.com/fliks-app/fliks/issues/869)) ([e6cef12](https://github.com/fliks-app/fliks/commit/e6cef121272ca6bfbc9d10054d19f1a04b231ced))
* **navigation:** disable view transitions on capacitor ([#1018](https://github.com/fliks-app/fliks/issues/1018)) ([f8aa358](https://github.com/fliks-app/fliks/commit/f8aa35859ae37981a070bde6698ac557de6fc863))
* **notifications:** send the endpoint under the key each sender reads ([#1001](https://github.com/fliks-app/fliks/issues/1001)) ([951ac46](https://github.com/fliks-app/fliks/commit/951ac46dec84639c0e866ff1faf47f373b17db95))
* **perf:** cache scans, leaked listeners and dead SSE streams ([#1019](https://github.com/fliks-app/fliks/issues/1019)) ([be18c4d](https://github.com/fliks-app/fliks/commit/be18c4d167a02a68ff6cc49e10803781707318ab))
* **playback:** persist a seek instead of debouncing it away ([#1016](https://github.com/fliks-app/fliks/issues/1016)) ([ea27caf](https://github.com/fliks-app/fliks/commit/ea27caf48836ff5906f658ff614fb699000d04d7))
* **plugin-ui:** align the refresh button right when the table has no title ([#1025](https://github.com/fliks-app/fliks/issues/1025)) ([a2bd0e4](https://github.com/fliks-app/fliks/commit/a2bd0e446fffdcdd071a5c6df4b73fdc43711131))
* **plugin-ui:** read a plugin setting as its declared type, not as text ([#961](https://github.com/fliks-app/fliks/issues/961)) ([76a6778](https://github.com/fliks-app/fliks/commit/76a677887be3a9a687c9856f45d2201fe5cec78c))
* **plugin-ui:** send a plugin page's requests to the plugin ([#950](https://github.com/fliks-app/fliks/issues/950)) ([5378227](https://github.com/fliks-app/fliks/commit/53782271ad7b0c4ad11d61c80d794b3c8b610868))
* **plugin-ui:** stop treating a row action as a connection test ([#951](https://github.com/fliks-app/fliks/issues/951)) ([7739224](https://github.com/fliks-app/fliks/commit/773922459056914c762dabddc4b064aec855ebf5))
* **plugins:** call the manual path importing a plugin, and fix the sources dialog layout ([#916](https://github.com/fliks-app/fliks/issues/916)) ([2e6c865](https://github.com/fliks-app/fliks/commit/2e6c865f1d4ff51f253e85e8e89a753bec0c6a6b))
* **plugins:** drop the version from the install button, and say what uninstalling costs ([#963](https://github.com/fliks-app/fliks/issues/963)) ([0bec068](https://github.com/fliks-app/fliks/commit/0bec068621cb60f88ecee64a95a8953a6759f84b))
* **plugins:** index the episode coverage lookup, and stop a plugin taking the server with it ([#975](https://github.com/fliks-app/fliks/issues/975)) ([4247a98](https://github.com/fliks-app/fliks/commit/4247a9891aa33f9678eefec7459a2008c5e01e70))
* **plugins:** isolate the plugin sockets, and report an unsafe core foreign key ([#979](https://github.com/fliks-app/fliks/issues/979)) ([6769e52](https://github.com/fliks-app/fliks/commit/6769e52c8d5ca2f142bd41f50118cc51ec2cabdb))
* **plugins:** re-read contributions after an install or an uninstall ([#967](https://github.com/fliks-app/fliks/issues/967)) ([a3121e5](https://github.com/fliks-app/fliks/commit/a3121e51efba50af1564cb62f7e3af1acf7bfa4f))
* **plugins:** refuse an oversize frame at the sender, and land an import atomically ([#980](https://github.com/fliks-app/fliks/issues/980)) ([b232656](https://github.com/fliks-app/fliks/commit/b232656f1db19ad508582cb3caad3180872da4c3))
* **plugins:** stop an ingest that is still copying from being called a failure ([#970](https://github.com/fliks-app/fliks/issues/970)) ([8eb5b4a](https://github.com/fliks-app/fliks/commit/8eb5b4ae96033596565fbc10863cee0ac58ee6a6))
* **plugins:** stop any layer from caching a plugin response ([#972](https://github.com/fliks-app/fliks/issues/972)) ([c5369f7](https://github.com/fliks-app/fliks/commit/c5369f7976572c59d1e26a8a86a2e380c12f60eb))
* **plugins:** stop cutting slow routes and leaking their RPC error ([#1007](https://github.com/fliks-app/fliks/issues/1007)) ([7573382](https://github.com/fliks-app/fliks/commit/7573382ea43e5c29cf2e834be8770e9916e664e4))
* **plugins:** stop reporting a healthy plugin's warnings as errors ([#952](https://github.com/fliks-app/fliks/issues/952)) ([628d849](https://github.com/fliks-app/fliks/commit/628d849b5f1edaa42e025fa0885356e5082d0d5c))
* **plugins:** stop the alias catch-all from swallowing core routes ([#955](https://github.com/fliks-app/fliks/issues/955)) ([7c336cd](https://github.com/fliks-app/fliks/commit/7c336cdeb1cd85e50c8c0e65e4e102fa242aa39a))
* **plugins:** survive a second plugin, and refuse a malformed manifest by name ([#977](https://github.com/fliks-app/fliks/issues/977)) ([6881acb](https://github.com/fliks-app/fliks/commit/6881acb714ba061c10f917f3fc22b7b80f5661bc))
* **requests:** announce an approved acquisition instead of deciding for its owner ([#1015](https://github.com/fliks-app/fliks/issues/1015)) ([3c9b344](https://github.com/fliks-app/fliks/commit/3c9b3446a75625e6a1d7ff7bbd0e23250c11e716))
* **scan:** keep serving requests while a scan walks the disk ([#1021](https://github.com/fliks-app/fliks/issues/1021)) ([b236283](https://github.com/fliks-app/fliks/commit/b236283170103044349f045cfd9c32cc12734967))
* **scheduler:** actually run the re-search after a block or stall cleanup ([#873](https://github.com/fliks-app/fliks/issues/873)) ([daa2202](https://github.com/fliks-app/fliks/commit/daa2202576574dfd36363f7a5b79dd867519e8ee))
* **setup:** probe https when the entered http base only redirects ([#1005](https://github.com/fliks-app/fliks/issues/1005)) ([487a3c3](https://github.com/fliks-app/fliks/commit/487a3c30a35ea6b34caef784a657de5a888b5963))
* **subtitles:** announce a list an import or an OCR run changed ([#1024](https://github.com/fliks-app/fliks/issues/1024)) ([6a01bf8](https://github.com/fliks-app/fliks/commit/6a01bf8ef56c5736c2555c5de04b3a7048df8f1a))
* **subtitles:** mute toasts for auto-triggered background events ([#864](https://github.com/fliks-app/fliks/issues/864)) ([c0498fa](https://github.com/fliks-app/fliks/commit/c0498fad3df3982afc1a180e52c96bfe723dca35))
* **subtitles:** prevent duplicate downloads and add episode context to logs ([#865](https://github.com/fliks-app/fliks/issues/865)) ([146f494](https://github.com/fliks-app/fliks/commit/146f494dadaf6ecfd7d37c1560712cc38412e581))
* **subtitles:** raise the OCR subprocess timeout to 30 minutes ([#867](https://github.com/fliks-app/fliks/issues/867)) ([b32f178](https://github.com/fliks-app/fliks/commit/b32f178bdee21d2c800d650fb9d0b90857514dd7))
* **subtitles:** retire the tracks a remux dropped, without trusting a failed probe ([#1026](https://github.com/fliks-app/fliks/issues/1026)) ([37dd890](https://github.com/fliks-app/fliks/commit/37dd8906977a0921bb22f6d9b1dc953fade88ebc))
* **subtitles:** surface OCR timeouts explicitly, fix stuck-processing crash ([#868](https://github.com/fliks-app/fliks/issues/868)) ([14fedcf](https://github.com/fliks-app/fliks/commit/14fedcfc682c20a7fead8dbd259f94eb15f0147b))
* **ui:** heading overflow, and a trending card that ignored the library ([#1020](https://github.com/fliks-app/fliks/issues/1020)) ([23c1ccc](https://github.com/fliks-app/fliks/commit/23c1ccc434b445e07d2815f59a9bc169d63bb34e))


### Performance Improvements

* **client,plugins:** destroy cached routes and stop re-joining the library per match ([#998](https://github.com/fliks-app/fliks/issues/998)) ([510b0fc](https://github.com/fliks-app/fliks/commit/510b0fc18f3c519a11bd61ce6c551f609e4fd6c0))
* **plugins:** tokenise the library once per release-match call, not once per pair ([#983](https://github.com/fliks-app/fliks/issues/983)) ([e4c674e](https://github.com/fliks-app/fliks/commit/e4c674e55530009816d39f7a2190a7faa09b5f0a))


### Miscellaneous Chores

* cut the next release as 3.0.0 ([#1027](https://github.com/fliks-app/fliks/issues/1027)) ([2f17707](https://github.com/fliks-app/fliks/commit/2f177073946c7fd80ceb49529401fdb07c28f5e7))

## [2.0.1](https://github.com/fliks-app/fliks/compare/v2.0.0...v2.0.1) (2026-08-04)


### Bug Fixes

* **appletv:** stop importing the development certificate in the tvOS workflow ([#848](https://github.com/fliks-app/fliks/issues/848)) ([d644612](https://github.com/fliks-app/fliks/commit/d644612abb2d8bea7c976bd931b7b98efba0c01b))
* **ci:** attach release assets without updating the release ([#850](https://github.com/fliks-app/fliks/issues/850)) ([5d52dd6](https://github.com/fliks-app/fliks/commit/5d52dd6e5bf83e401a4bd2a93502a37150ab551c))
* **tv:** exit on the first return-key press from the entry screen ([#859](https://github.com/fliks-app/fliks/issues/859)) ([d46970a](https://github.com/fliks-app/fliks/commit/d46970a52698e6a5bcccfc62856f72d6718c0cfd))

## [2.0.0](https://github.com/fliks-app/fliks/compare/v1.15.2...v2.0.0) (2026-08-02)


### Features

* **appletv:** multi-session sign-in, episode pages, watched state and home cache ([#840](https://github.com/fliks-app/fliks/issues/840)) ([0535f46](https://github.com/fliks-app/fliks/commit/0535f466885599a8bc6208822fe85e1246c83bde))
* **appletv:** native tvOS viewer app ([#799](https://github.com/fliks-app/fliks/issues/799)) ([df9abc6](https://github.com/fliks-app/fliks/commit/df9abc64b07f62194211eb18239a7602bf2a8313))
* **auth:** keep a session per account and per server on this device ([#814](https://github.com/fliks-app/fliks/issues/814)) ([73debbf](https://github.com/fliks-app/fliks/commit/73debbf45181811cdd0899ed5cfa3c0ac6fc228d))
* **dashboard:** link the media title in the recent-subtitles table ([#836](https://github.com/fliks-app/fliks/issues/836)) ([00f06a7](https://github.com/fliks-app/fliks/commit/00f06a73ee717e222234b01bafa6b8b1679d8a92))
* **desktop:** offline downloads played back via mpv ([#775](https://github.com/fliks-app/fliks/issues/775)) ([f4eb1b4](https://github.com/fliks-app/fliks/commit/f4eb1b4906d6c1738c773d34e99133d699d87ccd))
* **docker:** adopt jellyfin-ffmpeg on Linux with AV1 vaapi-decode fallback ([#739](https://github.com/fliks-app/fliks/issues/739)) ([af362d7](https://github.com/fliks-app/fliks/commit/af362d729f85a98163151797da1d1d74a985a439))
* **home:** add a customize-home shortcut card ([#670](https://github.com/fliks-app/fliks/issues/670)) ([3bb1094](https://github.com/fliks-app/fliks/commit/3bb1094e29fc6ab35c3e763c2c0a6702ed53dd13))
* **home:** add a recently-modified playlists zone ([#671](https://github.com/fliks-app/fliks/issues/671)) ([d849379](https://github.com/fliks-app/fliks/commit/d849379a548718655bb2ceab14b7fc05e8563ac5))
* **home:** format coming-soon dates in the active language ([#725](https://github.com/fliks-app/fliks/issues/725)) ([066efd4](https://github.com/fliks-app/fliks/commit/066efd4d543d3a624f612bc1ba2ce3af583e9ac2))
* **home:** reorderable member-recommendations zone with keyboard nav ([#721](https://github.com/fliks-app/fliks/issues/721)) ([5771953](https://github.com/fliks-app/fliks/commit/5771953e5de39bbac03c8667e532e9f0229c6cff))
* **i18n:** format all dates in the active language ([#726](https://github.com/fliks-app/fliks/issues/726)) ([d6f9902](https://github.com/fliks-app/fliks/commit/d6f990286246e7e7572f56303619d76ff28057f6))
* **i18n:** multilingual UI (en/fr/es/de/it/pt) with browser/OS detection ([#705](https://github.com/fliks-app/fliks/issues/705)) ([d319f36](https://github.com/fliks-app/fliks/commit/d319f368aec1031e062cd556660c08f798170410))
* **indexers:** log every torrent search, its indexers and its result count ([#822](https://github.com/fliks-app/fliks/issues/822)) ([8252a27](https://github.com/fliks-app/fliks/commit/8252a27d212baebafddf8934c4950ec3ebd9418e))
* **indexers:** surface indexer cooldowns and let admins lift them ([#823](https://github.com/fliks-app/fliks/issues/823)) ([47d1795](https://github.com/fliks-app/fliks/commit/47d179549f0b4895677f628428b14035fc41ff69))
* **layout:** add a My profile entry under Search in the sidebar ([16f3c94](https://github.com/fliks-app/fliks/commit/16f3c9474a58bf436a0f8387c4eea6d9c05254c6))
* **media-detail:** add an episode list view with synopsis and runtime ([#826](https://github.com/fliks-app/fliks/issues/826)) ([e31c306](https://github.com/fliks-app/fliks/commit/e31c30665a292328c61172042e767c8ce5b0691e))
* **media-detail:** add collection and similar-movies sections to the movie page ([#833](https://github.com/fliks-app/fliks/issues/833)) ([412c823](https://github.com/fliks-app/fliks/commit/412c82303638c2698725a8f33ad2fa17bc703d03))
* **media-detail:** group the season block and stop repeating the poster in the episode row ([#825](https://github.com/fliks-app/fliks/issues/825)) ([0785c62](https://github.com/fliks-app/fliks/commit/0785c62fa5f272008409604b9406a4f813b5e46c))
* **media-detail:** make the cast, file info and season sections collapsible ([#832](https://github.com/fliks-app/fliks/issues/832)) ([bee9962](https://github.com/fliks-app/fliks/commit/bee9962db86c13671accdcf39d56ec25b49603b9))
* **media-detail:** move the episode count under the season in its picker ([#810](https://github.com/fliks-app/fliks/issues/810)) ([85e474e](https://github.com/fliks-app/fliks/commit/85e474efc11b8081ae8f53bf9ecbbf9c00232d93))
* **media-detail:** punctuate the stream info labels ([#809](https://github.com/fliks-app/fliks/issues/809)) ([8fc8d1d](https://github.com/fliks-app/fliks/commit/8fc8d1dcabf770749f45aada8e05f47f1ba18d25))
* **media-detail:** rework the episode list and the header metadata ([#829](https://github.com/fliks-app/fliks/issues/829)) ([d1a9761](https://github.com/fliks-app/fliks/commit/d1a9761965d6b92f928ee12b0479fb9d8e6be0a6))
* **media-detail:** show season artwork in the picker and season info above the episodes ([#824](https://github.com/fliks-app/fliks/issues/824)) ([aa2e421](https://github.com/fliks-app/fliks/commit/aa2e421f2300fe2f4cd04c65b28129b95fa8c777))
* **media-detail:** surface series status and genres, fold the rest of the details ([#827](https://github.com/fliks-app/fliks/issues/827)) ([d56061a](https://github.com/fliks-app/fliks/commit/d56061a35001a0951b915a1d1428dbaaf49b7705))
* **metadata:** global + per-library metadata language & region for TMDB/TVDB ([#704](https://github.com/fliks-app/fliks/issues/704)) ([2e27f72](https://github.com/fliks-app/fliks/commit/2e27f72667c1f4b1de759625541da43a73b71b68))
* **metadata:** make the TMDB client resilient to upstream outages ([#716](https://github.com/fliks-app/fliks/issues/716)) ([741870b](https://github.com/fliks-app/fliks/commit/741870b682ff58c40308c9ced5f324df73c6143c))
* **player:** add in-app orientation lock button on iOS ([c3c4bca](https://github.com/fliks-app/fliks/commit/c3c4bcab77f87c471dbf448856f64082925e2e7e))
* **player:** auto-play the next episode and playlist queue ([#672](https://github.com/fliks-app/fliks/issues/672)) ([5582b7e](https://github.com/fliks-app/fliks/commit/5582b7ef0abb89d4e538a850ebb7ecf26641a582))
* **player:** enable Dolby Vision passthrough per platform ([#661](https://github.com/fliks-app/fliks/issues/661)) ([5f8a386](https://github.com/fliks-app/fliks/commit/5f8a386d0d58ae15cd5b795cc73b3c69e3bc0d3c)), closes [#368](https://github.com/fliks-app/fliks/issues/368)
* **player:** enrich the playback error dialog and fix desktop autoplay ([f55cd5d](https://github.com/fliks-app/fliks/commit/f55cd5d4e927888b8c605175bcab2c87720a4f02))
* **player:** rework volume control and add chromecast volume ([#788](https://github.com/fliks-app/fliks/issues/788)) ([95eecc1](https://github.com/fliks-app/fliks/commit/95eecc1689f6790d179a0fe8857c4c481fa45643))
* **player:** show the output codec and HDR format in transcode stats ([#667](https://github.com/fliks-app/fliks/issues/667)) ([b977a13](https://github.com/fliks-app/fliks/commit/b977a13e0f4077edd32e617ec2a91d1c286d6de5)), closes [#464](https://github.com/fliks-app/fliks/issues/464)
* **player:** tune subtitle appearance from the subtitle menu ([#816](https://github.com/fliks-app/fliks/issues/816)) ([d4dec2b](https://github.com/fliks-app/fliks/commit/d4dec2b9fa9c97dda742f8cf71251442a0f4f384))
* **player:** two-line subtitle and audio labels ([#782](https://github.com/fliks-app/fliks/issues/782)) ([7041fe9](https://github.com/fliks-app/fliks/commit/7041fe962dfd81f80d601b41a1dc16c2fe127e34))
* **playlists:** add backend playlists module (crud, items, roles) ([#615](https://github.com/fliks-app/fliks/issues/615)) ([2beb085](https://github.com/fliks-app/fliks/commit/2beb0858511264660695b6e42e9b13e2d92561cf))
* **playlists:** add playlists frontend (index, detail, add-to-playlist) ([#617](https://github.com/fliks-app/fliks/issues/617)) ([f35284f](https://github.com/fliks-app/fliks/commit/f35284f32b4c0ed5567710dbe0445aa8f8bc55d1))
* **playlists:** auto-download, auto-delete-after-watched, and grouped-view polish ([#621](https://github.com/fliks-app/fliks/issues/621)) ([c231f80](https://github.com/fliks-app/fliks/commit/c231f80d265f4e4e95a9b64dfa74866d1e26d24d))
* **playlists:** auto-remove watched items from auto-remove playlists ([#620](https://github.com/fliks-app/fliks/issues/620)) ([306dbed](https://github.com/fliks-app/fliks/commit/306dbed5bbc4cbbdae3dc8193162322d14fa912b))
* **playlists:** episode add buttons, grouped/flat list views, watched toggle ([#619](https://github.com/fliks-app/fliks/issues/619)) ([2d78a4a](https://github.com/fliks-app/fliks/commit/2d78a4ab3c3a1b60a11cd4b5aa5911f60285f37c))
* **playlists:** support movie + episode items with season/series bulk add ([#618](https://github.com/fliks-app/fliks/issues/618)) ([0f73fc8](https://github.com/fliks-app/fliks/commit/0f73fc8439dee8c55dd3a09ff00a5d774cdd7f51))
* **profile:** add an opt-in statistics tab ([aaa5533](https://github.com/fliks-app/fliks/commit/aaa553356c73be21be54e88126f7b04dffffb1bb))
* **profile:** route taste chips to search and polish the profile UI ([2c4c90e](https://github.com/fliks-app/fliks/commit/2c4c90e349a7b6bf6564d642c8ee7c85383bf0c2))
* **profile:** upload and crop a profile avatar ([efd1c1a](https://github.com/fliks-app/fliks/commit/efd1c1aa50cfa6e170b213e600e4de33b9d35e20))
* **recommendations:** group received recs by sender with quick actions ([#714](https://github.com/fliks-app/fliks/issues/714)) ([8d940b7](https://github.com/fliks-app/fliks/commit/8d940b7bed614080b327b2121deb737659c2838a))
* **requests:** media deletion requests ([#698](https://github.com/fliks-app/fliks/issues/698)) ([875269d](https://github.com/fliks-app/fliks/commit/875269d3769ed674e4d5d7cf6b0eab5c26a4db47))
* **search:** auto-apply filters, library browse without external search, consistent cards ([#703](https://github.com/fliks-app/fliks/issues/703)) ([d5bbed9](https://github.com/fliks-app/fliks/commit/d5bbed927c69cc59501d8b7086eb56d81bb8cff5))
* **search:** discovery page with TMDB browse, filters and richer add-previews ([58b013c](https://github.com/fliks-app/fliks/commit/58b013caab6dc68634ec3bf27d09e44b4561e7da))
* **search:** keep filters functional while typing a query ([#701](https://github.com/fliks-app/fliks/issues/701)) ([339f8f3](https://github.com/fliks-app/fliks/commit/339f8f352a41eb0e0a1b17bb72c35300ac73cd91))
* **settings:** split subtitle-providers into translation and download sections ([#781](https://github.com/fliks-app/fliks/issues/781)) ([34b5335](https://github.com/fliks-app/fliks/commit/34b533512d28e8db73649c0aae38a2dba10d1e9d))
* **social:** collaborative playlists via shared member roles ([#675](https://github.com/fliks-app/fliks/issues/675)) ([66c69fb](https://github.com/fliks-app/fliks/commit/66c69fbc0795df7558bdec33c6a5bc01c7d5a9b5))
* **social:** discoverable profiles, following and public playlists ([#673](https://github.com/fliks-app/fliks/issues/673)) ([ec4f847](https://github.com/fliks-app/fliks/commit/ec4f847754e39e069e5f99d184ee55c148f67bee))
* **social:** likes, recommend-to-member, and profile recommendations tab ([36dba26](https://github.com/fliks-app/fliks/commit/36dba26ee78af2f009abd9db04762994711eb7b0))
* **social:** opt-out of sharing functions + default member roster in search ([04a3991](https://github.com/fliks-app/fliks/commit/04a3991594602910c87a9f64734b525e8a0cd75b))
* **social:** profile connections pages and responsive header ([#674](https://github.com/fliks-app/fliks/issues/674)) ([570c432](https://github.com/fliks-app/fliks/commit/570c432730d57b009e740518e9ea5533d4a84643))
* **social:** profile recommendations tab + recommend from card menus ([8633036](https://github.com/fliks-app/fliks/commit/8633036c37bc3fc2bb2f0f760cddd6b186be215f))
* **social:** recommend media popular among people you follow ([#677](https://github.com/fliks-app/fliks/issues/677)) ([a499669](https://github.com/fliks-app/fliks/commit/a49966929e73027705e2ad1fd77cf6906475000b))
* **social:** save other members' public playlists ([#676](https://github.com/fliks-app/fliks/issues/676)) ([ac8a418](https://github.com/fliks-app/fliks/commit/ac8a4182d163d9f016befe6101818436375b01c2))
* **streaming:** admin GPU device selection for multi-GPU hosts ([#745](https://github.com/fliks-app/fliks/issues/745)) ([2c8236a](https://github.com/fliks-app/fliks/commit/2c8236aef52bedc8acca9abc56d877984bcee7fb))
* **streaming:** direct-play single-layer Dolby Vision untouched ([#660](https://github.com/fliks-app/fliks/issues/660)) ([2856745](https://github.com/fliks-app/fliks/commit/2856745433162e767f112832b05213a1adecda87)), closes [#368](https://github.com/fliks-app/fliks/issues/368)
* **streaming:** tone-map Dolby Vision P5 via tonemap_opencl apply_dovi ([#763](https://github.com/fliks-app/fliks/issues/763)) ([4849646](https://github.com/fliks-app/fliks/commit/48496469cbc88a9de76048c79f37a755b17d1f6e))
* **streaming:** tonemap Dolby Vision Profile 5 correctly ([#658](https://github.com/fliks-app/fliks/issues/658)) ([1433d65](https://github.com/fliks-app/fliks/commit/1433d65613a1d9919d3c445f982cab3cd236387c)), closes [#636](https://github.com/fliks-app/fliks/issues/636)
* **streaming:** windows server with QSV/AMF/NVENC hardware transcoding ([bc44534](https://github.com/fliks-app/fliks/commit/bc445341b7616a43e9d47529ff76747079781110)), closes [#720](https://github.com/fliks-app/fliks/issues/720)
* **streams:** show client build version for non-web devices ([#669](https://github.com/fliks-app/fliks/issues/669)) ([b77e270](https://github.com/fliks-app/fliks/commit/b77e2708d5f0bcb11451bfa218d8b34c2d0a7f60))
* **subtitles:** link the episode label to the episode page ([#807](https://github.com/fliks-app/fliks/issues/807)) ([7b83afd](https://github.com/fliks-app/fliks/commit/7b83afd262880125b340bea9adce50f8919572fd))
* **subtitles:** multi-engine subtitle translation (Gemini/OpenAI/LibreTranslate) ([866c307](https://github.com/fliks-app/fliks/commit/866c307517180251196f9514f8162c91f8a145e7))
* **subtitles:** multiple selectable translation providers ([#779](https://github.com/fliks-app/fliks/issues/779)) ([bfc5c9f](https://github.com/fliks-app/fliks/commit/bfc5c9ff12430fade37585e0a2ca87d7e7ca9a61))
* **subtitles:** put the file format in the pickers behind a preference ([#808](https://github.com/fliks-app/fliks/issues/808)) ([6fd67b9](https://github.com/fliks-app/fliks/commit/6fd67b9b590f55f1e33c850d66de896cb2bbcb48))
* **subtitles:** show the episode on the subtitle history rows ([#806](https://github.com/fliks-app/fliks/issues/806)) ([b4a8a34](https://github.com/fliks-app/fliks/commit/b4a8a34b0c535c2a228e7943bd65a1cc3ae60d80))
* **subtitles:** strip HI cues properly and drop the tag afterwards ([#819](https://github.com/fliks-app/fliks/issues/819)) ([05c118f](https://github.com/fliks-app/fliks/commit/05c118fe1eefb45f209c174079a0e233c311b245))
* **subtitles:** subtitle UX improvements — quick wins ([#780](https://github.com/fliks-app/fliks/issues/780)) ([bfbaee7](https://github.com/fliks-app/fliks/commit/bfbaee78f738d1a2baeec0a4772bb0602fc93f26))
* **subtitles:** upload a subtitle file from the device ([#821](https://github.com/fliks-app/fliks/issues/821)) ([91a2d6f](https://github.com/fliks-app/fliks/commit/91a2d6f687d80373cfcfd88b4fc514a815d04a17))
* **subtitles:** view and download a subtitle from its actions menu ([#812](https://github.com/fliks-app/fliks/issues/812)) ([9b485f5](https://github.com/fliks-app/fliks/commit/9b485f502eed1945436b2324438ee71ac0f44a52))
* **system:** add a restart button to the admin system page ([#813](https://github.com/fliks-app/fliks/issues/813)) ([37d3a55](https://github.com/fliks-app/fliks/commit/37d3a55728b6feac22b39d57c44e58b36e5c4fc7))
* **tmdb-preview:** add show-more toggle on the mobile synopsis ([#831](https://github.com/fliks-app/fliks/issues/831)) ([2f3fda0](https://github.com/fliks-app/fliks/commit/2f3fda0c6e70f7dcb74671a74e318784b676f038))
* **tmdb-preview:** show a type badge and a season browser for series ([#838](https://github.com/fliks-app/fliks/issues/838)) ([60bd0d8](https://github.com/fliks-app/fliks/commit/60bd0d8213564af472bf0b255d5784dd36a27453))
* **ui:** animate desktop dropdown and card-action menus on close ([956712b](https://github.com/fliks-app/fliks/commit/956712b0d04cd96f5ff3b5942797074d2843d7da))
* **user-menu:** show the user's avatar as the header menu trigger ([#708](https://github.com/fliks-app/fliks/issues/708)) ([208f39e](https://github.com/fliks-app/fliks/commit/208f39e1122518d318c70ffacb5b5febd5dbae35))
* **windows:** QSV HDR tonemap via OpenCL zero-copy (jellyfin-ffmpeg) ([8a1c007](https://github.com/fliks-app/fliks/commit/8a1c007e03ced9becb7d2d225b171312a293ae5a)), closes [#720](https://github.com/fliks-app/fliks/issues/720)


### Bug Fixes

* **appletv:** archive with the distribution identity to reach App Store Connect ([#844](https://github.com/fliks-app/fliks/issues/844)) ([2b0f253](https://github.com/fliks-app/fliks/commit/2b0f2534e5d3a564a197bd6b4cabc028eb1db68b))
* **appletv:** keep requests intact across an http to https redirect ([#843](https://github.com/fliks-app/fliks/issues/843)) ([5044b7b](https://github.com/fliks-app/fliks/commit/5044b7be6f2d27062cc68269b6938ba953f71e26))
* **cast:** coalesce rapid seek bursts into one settled dispatch ([#790](https://github.com/fliks-app/fliks/issues/790)) ([0fe18fb](https://github.com/fliks-app/fliks/commit/0fe18fbd5caaa167d4dbb7cbad9ee33ba9fae842)), closes [#789](https://github.com/fliks-app/fliks/issues/789)
* **cast:** coalesce rapid seeks to prevent A/V desync on chromecast ([ff57901](https://github.com/fliks-app/fliks/commit/ff57901535d077513d4e500befed6f1a399b19a4))
* **cast:** don't tear down a playing receiver on a transient sender drop ([#655](https://github.com/fliks-app/fliks/issues/655)) ([c60411c](https://github.com/fliks-app/fliks/commit/c60411c17f6995abc3af338eadb22ee02ada6064)), closes [#624](https://github.com/fliks-app/fliks/issues/624)
* **cast:** preserve pause state across an auto-recovery reload ([#652](https://github.com/fliks-app/fliks/issues/652)) ([8de571d](https://github.com/fliks-app/fliks/commit/8de571d9aeb86da7667d9587a0f52bc8caedaedd)), closes [#633](https://github.com/fliks-app/fliks/issues/633)
* **desktop:** distinguish mpv transport failures from decode failures ([2fc22ac](https://github.com/fliks-app/fliks/commit/2fc22ac34524d33dab60a4fdaef895134148ffa1))
* **desktop:** keep the forced HLS demuxer off sidecar subtitle loads ([#776](https://github.com/fliks-app/fliks/issues/776)) ([e964f90](https://github.com/fliks-app/fliks/commit/e964f90b141994ba970d658f31012d4e3fd1e25f))
* **desktop:** overhaul macOS player latency, seeking, and audio ([d8251f5](https://github.com/fliks-app/fliks/commit/d8251f59dfc0f3d5354ad5a9e596d5955488bfa1))
* **desktop:** player robustness (teardown, seek, buffering, IPC) ([#773](https://github.com/fliks-app/fliks/issues/773)) ([b97d0e1](https://github.com/fliks-app/fliks/commit/b97d0e18f6ee5188160147145dcaf093094369c6))
* **desktop:** resolve macOS player latency, seek UX and audio issues ([566fe83](https://github.com/fliks-app/fliks/commit/566fe83941dea00c931e68cfcd469dc0e1a0c6bd))
* **desktop:** round the player window bottom corners on macOS and windows ([34efc5d](https://github.com/fliks-app/fliks/commit/34efc5dde7b9cb71132c53a6f79011570cb9314b))
* **desktop:** stop auto-skip on playback error, rework the mpv backend ([11fbbe4](https://github.com/fliks-app/fliks/commit/11fbbe495f1bf25e294db4eed9d0f91245596224))
* **device-profile:** gate Android Direct Play by the decoder's max resolution ([#649](https://github.com/fliks-app/fliks/issues/649)) ([7a8e7fe](https://github.com/fliks-app/fliks/commit/7a8e7feca372dcac653394b91af71139a1248e69)), closes [#626](https://github.com/fliks-app/fliks/issues/626)
* **dropdown-menu:** cap desktop menu height and scroll overflow ([#796](https://github.com/fliks-app/fliks/issues/796)) ([c6f55be](https://github.com/fliks-app/fliks/commit/c6f55becf80a8c18b32260851a71b56f43ac48f4))
* **home:** expose recommend/add-to-playlist on the likes row cards ([ad15f32](https://github.com/fliks-app/fliks/commit/ad15f32da1764eb9bd4603f3c8211a9d8bae3fca))
* **home:** key continue-watching rows by media, not the null-join id ([#797](https://github.com/fliks-app/fliks/issues/797)) ([4134381](https://github.com/fliks-app/fliks/commit/4134381686811f45f06da82e88a3090f93a0041f))
* **i18n:** add missing media-status labels on the add page ([#700](https://github.com/fliks-app/fliks/issues/700)) ([5a51e40](https://github.com/fliks-app/fliks/commit/5a51e4031103c0f91fbea85fec99274d86e0e08f))
* **i18n:** rename the auto language option to System ([#706](https://github.com/fliks-app/fliks/issues/706)) ([489e075](https://github.com/fliks-app/fliks/commit/489e07520562df0d36ef5e17cf16ceff0b900419))
* **images:** generate every size locally for all providers ([#702](https://github.com/fliks-app/fliks/issues/702)) ([2101de8](https://github.com/fliks-app/fliks/commit/2101de8353458015eb1d311632f706980faf29ed))
* **indexers:** escalate the failure backoff once per elapsed window ([#802](https://github.com/fliks-app/fliks/issues/802)) ([7a6e628](https://github.com/fliks-app/fliks/commit/7a6e628d98804b0f64abc381920f020779679816))
* **layout:** stop the add-to-playlist/recommend modal reopening after the player ([176e870](https://github.com/fliks-app/fliks/commit/176e870aa1ac3d51be66f00515920f6b39ef65fd))
* **macos:** sign server node with JIT entitlements and rename bundle to Fliks Server ([1636219](https://github.com/fliks-app/fliks/commit/1636219653351fe16c196bbdf35f0dc023bdf7ce))
* **macos:** use vendored jellyfin-ffmpeg + HW tone-map for cropped HDR ([#768](https://github.com/fliks-app/fliks/issues/768)) ([aebd18a](https://github.com/fliks-app/fliks/commit/aebd18a1a6224ba65f65b8511f7d55f9867b994c))
* **media-card:** scope the actions dropdown to the spatial-nav modal layer ([#722](https://github.com/fliks-app/fliks/issues/722)) ([8ccfd33](https://github.com/fliks-app/fliks/commit/8ccfd33a5d7d4afb75d9a4b82128c955b0d90f34))
* **media-detail:** allow liking a series at the series level ([#718](https://github.com/fliks-app/fliks/issues/718)) ([fd95815](https://github.com/fliks-app/fliks/commit/fd958157459be335fde33a5c405bfac4f91c4023))
* **media-detail:** allow liking a title without a local file ([#717](https://github.com/fliks-app/fliks/issues/717)) ([af682bc](https://github.com/fliks-app/fliks/commit/af682bc95c3d00f774415f6daa5c6c370ce6bd53))
* **media-detail:** keep a card rail scrolling inside a collapsible section ([#839](https://github.com/fliks-app/fliks/issues/839)) ([b7a3b80](https://github.com/fliks-app/fliks/commit/b7a3b80bd86f0794f6a5aa8dee79dd98b3a53991))
* **media-detail:** localize season episode air dates ([#777](https://github.com/fliks-app/fliks/issues/777)) ([2b5acb5](https://github.com/fliks-app/fliks/commit/2b5acb59a3b1fc599c17e3be83969227db92b752))
* **media-detail:** restore the memorized scroll only on a back navigation ([#834](https://github.com/fliks-app/fliks/issues/834)) ([6606daf](https://github.com/fliks-app/fliks/commit/6606dafb635aeef87b4592f3ab8d3a46b1912e04))
* **modals:** fix clipped close ring and phantom keyboard focus stop ([#715](https://github.com/fliks-app/fliks/issues/715)) ([d69b43a](https://github.com/fliks-app/fliks/commit/d69b43afe517d5e24d9058c07293b1a595717a75))
* **nav:** back button after opening the keyboard from the search dock ([2dd2f45](https://github.com/fliks-app/fliks/commit/2dd2f456f3fd9c24082ef7789449b493cbaa193a))
* **nav:** stray popstate no longer kills the back button after keyboard close ([65b220a](https://github.com/fliks-app/fliks/commit/65b220afc39bf5f37b23a09eadfb3a758161e476))
* **player-stats:** render 0 dropped frames instead of NaN ([#770](https://github.com/fliks-app/fliks/issues/770)) ([37a6263](https://github.com/fliks-app/fliks/commit/37a6263ee3a04cee5114fd3c061bad74ffabf8ce))
* **player-stats:** show source resolution in the video header ([#769](https://github.com/fliks-app/fliks/issues/769)) ([22d49a7](https://github.com/fliks-app/fliks/commit/22d49a7e29bc36d797533bf9d7f78cdb10aa3c6e))
* **player:** apply fill screen on every native renderer ([#817](https://github.com/fliks-app/fliks/issues/817)) ([efda944](https://github.com/fliks-app/fliks/commit/efda944af0533855c39f3e21ed8134e238092ecb))
* **player:** back button needs two presses after the first play ([5796682](https://github.com/fliks-app/fliks/commit/5796682188cd9c81b7407eacbf863a4b4abe6ab3))
* **player:** cap Auto-ABR rungs to the player element size ([#657](https://github.com/fliks-app/fliks/issues/657)) ([bf22a02](https://github.com/fliks-app/fliks/commit/bf22a0208060de7e0fc734d6dcf74ed6fffc0f76)), closes [#635](https://github.com/fliks-app/fliks/issues/635)
* **player:** classify failed session requests instead of blaming the engine ([b707532](https://github.com/fliks-app/fliks/commit/b707532376fa31513dfab0bb44d2f0a1e23255e6))
* **player:** don't let lost-session recovery race a user reload ([#651](https://github.com/fliks-app/fliks/issues/651)) ([22c997e](https://github.com/fliks-app/fliks/commit/22c997e07e77ee73d88f57d9002be66c23ba0c35)), closes [#632](https://github.com/fliks-app/fliks/issues/632)
* **player:** don't let the stall watchdog kill a legit post-seek respawn ([#656](https://github.com/fliks-app/fliks/issues/656)) ([fa16b07](https://github.com/fliks-app/fliks/commit/fa16b0797ac63831716ac72b8fddf84020c78f9a)), closes [#634](https://github.com/fliks-app/fliks/issues/634)
* **player:** guard Tizen AVPlay teardown by singleton ownership ([#646](https://github.com/fliks-app/fliks/issues/646)) ([167673f](https://github.com/fliks-app/fliks/commit/167673f302d7f7412ffffc8020a89d78dd1becb6)), closes [#625](https://github.com/fliks-app/fliks/issues/625)
* **player:** hold the buffering spinner until playback resumes ([#778](https://github.com/fliks-app/fliks/issues/778)) ([8f4baeb](https://github.com/fliks-app/fliks/commit/8f4baeb376d423378a1a09e416be7001c8bca8f3))
* **player:** keep playback alive when a subtitle track fails ([#644](https://github.com/fliks-app/fliks/issues/644)) ([ced6b9d](https://github.com/fliks-app/fliks/commit/ced6b9d334f801e237f842024239c243184229a4)), closes [#628](https://github.com/fliks-app/fliks/issues/628)
* **player:** localise the forced and hearing-impaired subtitle tags ([#795](https://github.com/fliks-app/fliks/issues/795)) ([15ef6d2](https://github.com/fliks-app/fliks/commit/15ef6d20f087db13e86c6878f548f72841fd903b))
* **player:** make controls auto-hide reactive so a transient pin can't wedge them open ([#757](https://github.com/fliks-app/fliks/issues/757)) ([71a5f08](https://github.com/fliks-app/fliks/commit/71a5f085d8840a3f867a8e500dcdee5c9ee9b248))
* **player:** number the subtitle tracks a file left untagged ([#811](https://github.com/fliks-app/fliks/issues/811)) ([f820187](https://github.com/fliks-app/fliks/commit/f820187791eaf2efd0995588600febd2c2e77b88))
* **player:** pin the HLS rung for clients that cannot switch variants ([e12ad67](https://github.com/fliks-app/fliks/commit/e12ad674e5a4cea06034ebdeeb7816e9d316eee4))
* **player:** probe webOS Dolby Vision instead of assuming it from HDR ([#662](https://github.com/fliks-app/fliks/issues/662)) ([8b77565](https://github.com/fliks-app/fliks/commit/8b775654dda2d39b9e2a25bf9b5e142415db1a49)), closes [#368](https://github.com/fliks-app/fliks/issues/368)
* **player:** re-mint the stream token on recovery and quality-switch reload ([#645](https://github.com/fliks-app/fliks/issues/645)) ([dbcdbb1](https://github.com/fliks-app/fliks/commit/dbcdbb193c649deee90b596725ed64ac61bfba61)), closes [#629](https://github.com/fliks-app/fliks/issues/629)
* **player:** reload desktop far seeks at offset, not in-place seek ([#774](https://github.com/fliks-app/fliks/issues/774)) ([acd862b](https://github.com/fliks-app/fliks/commit/acd862b7deae2e0ef20d54806517a14d31ad0384))
* **player:** show an error card when a switch kills the mobile player ([#648](https://github.com/fliks-app/fliks/issues/648)) ([241e2c2](https://github.com/fliks-app/fliks/commit/241e2c29e560518566e68aaff38afa4f28bc58a7)), closes [#623](https://github.com/fliks-app/fliks/issues/623)
* **player:** skip reload when re-selecting the active quality rung ([#665](https://github.com/fliks-app/fliks/issues/665)) ([a976696](https://github.com/fliks-app/fliks/commit/a97669664d430eb791127f8c01636f76edd8172b)), closes [#641](https://github.com/fliks-app/fliks/issues/641)
* **profile:** keep back navigation from the recommendations tab ([#711](https://github.com/fliks-app/fliks/issues/711)) ([da2e8a2](https://github.com/fliks-app/fliks/commit/da2e8a2a421e9fba48c88cbd0b3a83a193c7a754))
* **profile:** set the browser tab title to the profile name ([#710](https://github.com/fliks-app/fliks/issues/710)) ([739383e](https://github.com/fliks-app/fliks/commit/739383e1a40b11fe4a3b687c680e6089f999ab09))
* **recommendations:** resolve card image URLs through the pipe ([#723](https://github.com/fliks-app/fliks/issues/723)) ([a66b557](https://github.com/fliks-app/fliks/commit/a66b5572f1c704f91395dc3eaae3b02e3ede46eb))
* **scheduler:** rank history rows per torrent and recover stranded imports ([#805](https://github.com/fliks-app/fliks/issues/805)) ([175a702](https://github.com/fliks-app/fliks/commit/175a702622803ead10af0c33b4aa05e90b1b9469))
* **scheduler:** resolve auto-match against the linked history row ([#804](https://github.com/fliks-app/fliks/issues/804)) ([245a106](https://github.com/fliks-app/fliks/commit/245a106207a92ca1c6ad9bd7467feae876165adb))
* **scheduler:** run the seeded-torrent cleanup on a cron ([#803](https://github.com/fliks-app/fliks/issues/803)) ([b9fb56b](https://github.com/fliks-app/fliks/commit/b9fb56b8f08af7a5c5072e53682912fcf807d52a))
* **search:** stop the genre hand-off from locking the discover panel ([8de2370](https://github.com/fliks-app/fliks/commit/8de237030150a93a2a396ffd5c6402ade022771e))
* **spatial-nav:** unify the focus rules and annotate the rows that skipped them ([#835](https://github.com/fliks-app/fliks/issues/835)) ([9ba91f4](https://github.com/fliks-app/fliks/commit/9ba91f45892b7f63ff2bb5064f17783327f8d472))
* **streaming:** anchor forced-IDR cadence in frames to fix seek freeze ([#771](https://github.com/fliks-app/fliks/issues/771)) ([bf907ea](https://github.com/fliks-app/fliks/commit/bf907eaf800daf509eb5bdd9cd568f030ab13317))
* **streaming:** anchor forced-IDR cadence run-relative to fix seeked-run desync ([#756](https://github.com/fliks-app/fliks/issues/756)) ([dc7ca92](https://github.com/fliks-app/fliks/commit/dc7ca9265765de72164f594e92af1af5cea634ff))
* **streaming:** cut audio renditions on the fps-aware segment grid ([#642](https://github.com/fliks-app/fliks/issues/642)) ([b2af0ea](https://github.com/fliks-app/fliks/commit/b2af0ea36d4e6215ff91730ff49e5d06b9f4ca2a)), closes [#631](https://github.com/fliks-app/fliks/issues/631)
* **streaming:** don't copy non-fMP4 audio codecs on the transcode path ([#650](https://github.com/fliks-app/fliks/issues/650)) ([0d45499](https://github.com/fliks-app/fliks/commit/0d45499cf5ca88452e39610a96e2082939569b5a)), closes [#640](https://github.com/fliks-app/fliks/issues/640)
* **streaming:** fall back to avg_frame_rate when r_frame_rate is unusable ([#760](https://github.com/fliks-app/fliks/issues/760)) ([e73a7f7](https://github.com/fliks-app/fliks/commit/e73a7f7b5cc82eb5d2953742dd46a3b672e19bb6))
* **streaming:** give concurrent playbacks of one file separate transcode jobs ([#654](https://github.com/fliks-app/fliks/issues/654)) ([a9a728e](https://github.com/fliks-app/fliks/commit/a9a728e9c6d6cc82ddced784befba666df747461)), closes [#638](https://github.com/fliks-app/fliks/issues/638)
* **streaming:** keep sprite extraction off the GPU during live transcodes ([#664](https://github.com/fliks-app/fliks/issues/664)) ([46f968b](https://github.com/fliks-app/fliks/commit/46f968b9d3afee22178b359a0fb005d4a45ea102)), closes [#639](https://github.com/fliks-app/fliks/issues/639)
* **streaming:** keep Windows QSV HDR tonemap on the vpp_qsv LUT ([#733](https://github.com/fliks-app/fliks/issues/733)) ([f0b622e](https://github.com/fliks-app/fliks/commit/f0b622e277703edf1b41e44f8fc908c3f00bc251))
* **streaming:** never remux Dolby Vision Profile 5 (drops DV signaling) ([#663](https://github.com/fliks-app/fliks/issues/663)) ([bda9dc5](https://github.com/fliks-app/fliks/commit/bda9dc570976ef96c54e06406a64755271ed4c39)), closes [#368](https://github.com/fliks-app/fliks/issues/368)
* **streaming:** pin forced IDR on av1_amf explicitly ([#818](https://github.com/fliks-app/fliks/issues/818)) ([c18b2d4](https://github.com/fliks-app/fliks/commit/c18b2d4f6ba44b27e1934d6f17ef20634f62bf69))
* **streaming:** pin libx264 GOP to the segment grid on seek-resume ([#741](https://github.com/fliks-app/fliks/issues/741)) ([0ff33c2](https://github.com/fliks-app/fliks/commit/0ff33c245aa38cffb8f3c397ca198fed74cca0d2))
* **streaming:** report macOS scale_vt tone-map as hardware, not CPU ([#766](https://github.com/fliks-app/fliks/issues/766)) ([8475123](https://github.com/fliks-app/fliks/commit/847512337c788812048b44d068f28d4bec1cb0b7))
* **streaming:** run the HW-crash CPU fallback for non-blocking spawns too ([#653](https://github.com/fliks-app/fliks/issues/653)) ([a06fbaf](https://github.com/fliks-app/fliks/commit/a06fbaf7db4f6e08637aa82574df34b047100f69)), closes [#637](https://github.com/fliks-app/fliks/issues/637)
* **streaming:** SDR color preservation + transcode-pipeline review fixes ([#746](https://github.com/fliks-app/fliks/issues/746)) ([07c88ba](https://github.com/fliks-app/fliks/commit/07c88ba814d8177fc61f946eb0b33dabe38b3e2b))
* **streaming:** size the encode to the crop, not the uncropped frame ([#647](https://github.com/fliks-app/fliks/issues/647)) ([d6609de](https://github.com/fliks-app/fliks/commit/d6609de6457b962ac499f4bc3ad8f44b023ee857)), closes [#630](https://github.com/fliks-app/fliks/issues/630)
* **streaming:** skip the tfdt anchor for remux on the cached fast path ([#742](https://github.com/fliks-app/fliks/issues/742)) ([8bb0d42](https://github.com/fliks-app/fliks/commit/8bb0d42f36d19379773e4db771d03830c29103be))
* **streaming:** snap segment length to the true GOP length ([#791](https://github.com/fliks-app/fliks/issues/791)) ([84e870e](https://github.com/fliks-app/fliks/commit/84e870e46d28b063c5442c43bca6330cfaf4bef8))
* **streaming:** survive a direct-play read error instead of crashing ([#643](https://github.com/fliks-app/fliks/issues/643)) ([8f22480](https://github.com/fliks-app/fliks/commit/8f22480c4fb235675a5ad40c4474cbcb606c8d44)), closes [#627](https://github.com/fliks-app/fliks/issues/627)
* **subtitles:** keep automatic subtitle work inside the language profile ([#800](https://github.com/fliks-app/fliks/issues/800)) ([0920c76](https://github.com/fliks-app/fliks/commit/0920c76bda421773d57f0ba581061b8460c10fae))
* **subtitles:** rename to .srt after converting an ASS sidecar ([#820](https://github.com/fliks-app/fliks/issues/820)) ([cc57d41](https://github.com/fliks-app/fliks/commit/cc57d4185a16f03e32622b4766066e57280fdbdc))
* **subtitles:** tag track format from extension, hide if unknown ([#785](https://github.com/fliks-app/fliks/issues/785)) ([01fbcc5](https://github.com/fliks-app/fliks/commit/01fbcc5a462323cfdf7e10b3cb0c9f2c0f0b5547))
* **tmdb-preview:** translate the original language and match the desktop date format ([#837](https://github.com/fliks-app/fliks/issues/837)) ([4b237c0](https://github.com/fliks-app/fliks/commit/4b237c018a8c59292efdc4a67181f2f9fc5ebe82))
* **tv-select:** add pointer/hover affordance and ignore right-click ([#772](https://github.com/fliks-app/fliks/issues/772)) ([e8eab34](https://github.com/fliks-app/fliks/commit/e8eab344dbfbddd490f7b041c901214d97358960))
* **windows:** add extra_hw_frames to the AMD full-GPU d3d11 decode ([#736](https://github.com/fliks-app/fliks/issues/736)) ([b605b58](https://github.com/fliks-app/fliks/commit/b605b5854a438abac61548ae521325e497a3b4c0)), closes [#720](https://github.com/fliks-app/fliks/issues/720)
* **windows:** bundle the VC++ runtime beside postgres and node ([9750b9c](https://github.com/fliks-app/fliks/commit/9750b9c75947df64ee70557d5a22da060802991d)), closes [#720](https://github.com/fliks-app/fliks/issues/720)
* **windows:** correct the QSV detection and encoder probes on D3D11 ([#732](https://github.com/fliks-app/fliks/issues/732)) ([f389a50](https://github.com/fliks-app/fliks/commit/f389a50ea0180b40780d989bec1c5793cde45bcf))
* **windows:** decode QSV sessions on D3D11VA and map into QSV ([#735](https://github.com/fliks-app/fliks/issues/735)) ([177c777](https://github.com/fliks-app/fliks/commit/177c77762ca6e0ac7d1e47078056b722f32aef9c)), closes [#720](https://github.com/fliks-app/fliks/issues/720)


### Performance Improvements

* **streaming:** hw-decode the OpenCL tone-map path ([#729](https://github.com/fliks-app/fliks/issues/729) proposal 1) ([d412ea0](https://github.com/fliks-app/fliks/commit/d412ea058e7e13ec3c490a3ec309448dc9eab88c))


### Miscellaneous Chores

* release 2.0.0 ([f2a4e77](https://github.com/fliks-app/fliks/commit/f2a4e77420e9f20bef06d0a422ce735902f198fc))

## [1.15.2](https://github.com/fliks-app/fliks/compare/v1.15.1...v1.15.2) (2026-07-08)


### Bug Fixes

* **media:** stop non-Latin alt titles from bypassing title match ([#614](https://github.com/fliks-app/fliks/issues/614)) ([a9d4b4f](https://github.com/fliks-app/fliks/commit/a9d4b4f9c4e80b192fb929a1e095c4343a2911a5))
* **subtitles:** make vobsub ocr work and hide in-progress extractions ([#612](https://github.com/fliks-app/fliks/issues/612)) ([a196afe](https://github.com/fliks-app/fliks/commit/a196afecd576f22db248d04ac6f53461a38ff7f0))

## [1.15.1](https://github.com/fliks-app/fliks/compare/v1.15.0...v1.15.1) (2026-07-08)


### Bug Fixes

* **scheduler:** skip cooldown indexers in auto-grab search fan-outs ([#609](https://github.com/fliks-app/fliks/issues/609)) ([48f988f](https://github.com/fliks-app/fliks/commit/48f988f07cd24a18ddf720eaab31a102ec06509d))
* **update:** add desktop-only update settings page and updater file log ([#611](https://github.com/fliks-app/fliks/issues/611)) ([434d709](https://github.com/fliks-app/fliks/commit/434d709480d967399423b86fc2349d53161e4c2b))

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
