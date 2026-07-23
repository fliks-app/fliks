import SwiftUI

/// Settings shell: one row per section. Viewer-facing subset only — no
/// admin, account, storage, update, or cast (out of scope on tvOS).
struct SettingsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(tr("common.settings"))
                .font(.title.bold())
                .padding(.horizontal, 60)
                .padding(.top, 48)
                .padding(.bottom, 24)
            List {
                NavigationLink(tr("app_settings.nav.display")) { DisplaySettingsView() }
                NavigationLink(tr("app_settings.nav.player")) { PlayerSettingsView() }
                NavigationLink(tr("app_settings.nav.subtitles")) { SubtitleSettingsView() }
                NavigationLink(tr("app_settings.nav.home")) { HomeLayoutView() }
            }
        }
    }
}

/// value/label pair for pickers backed by a raw string preference.
struct LabeledOption: Identifiable {
    let value: String
    let label: String
    var id: String { value }
}

/// Preferred audio/subtitle language options — ISO 639-2/B codes, mirroring
/// the client's `LANGUAGE_OPTIONS` (`playback-options.ts`). Computed (not
/// cached) so labels stay correct across a live language switch.
enum PreferredLanguageOptions {
    static var all: [LabeledOption] {
        [
            LabeledOption(value: "", label: tr("settings.lang.none")),
            LabeledOption(value: "fra", label: tr("settings.lang.fra")),
            LabeledOption(value: "eng", label: tr("settings.lang.eng")),
            LabeledOption(value: "jpn", label: tr("settings.lang.jpn")),
            LabeledOption(value: "deu", label: tr("settings.lang.deu")),
            LabeledOption(value: "spa", label: tr("settings.lang.spa")),
            LabeledOption(value: "ita", label: tr("settings.lang.ita")),
            LabeledOption(value: "por", label: tr("settings.lang.por")),
            LabeledOption(value: "kor", label: tr("settings.lang.kor")),
            LabeledOption(value: "zho", label: tr("settings.lang.zho")),
            LabeledOption(value: "rus", label: tr("settings.lang.rus")),
            LabeledOption(value: "ara", label: tr("settings.lang.ara")),
        ]
    }
}
