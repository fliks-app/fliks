import SwiftUI

/// Preferred subtitle language and selection mode. Appearance and position
/// belong to tvOS: AVKit draws HLS subtitles under the viewer's system caption
/// style, which app-level rules don't override.
struct SubtitleSettingsView: View {
    @Environment(AppSettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        VStack(alignment: .leading, spacing: 0) {
            Text(tr("app_settings.nav.subtitles"))
                .font(.title.bold())
                .padding(.horizontal, 60)
                .padding(.top, 48)
                .padding(.bottom, 24)
            Form {
                Section {
                    Picker(tr("playback_settings.sub_preferred_lang"), selection: $settings.preferredSubtitleLanguage) {
                        ForEach(PreferredLanguageOptions.all) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                }

                Section {
                    Picker(tr("playback_settings.sub_mode"), selection: $settings.subtitleMode) {
                        Text(tr("playback_settings.sub_mode_off")).tag("off")
                        Text(tr("playback_settings.sub_mode_intelligent")).tag("intelligent")
                        Text(tr("playback_settings.sub_mode_always")).tag("always")
                    }
                } footer: {
                    Text(tr("playback_settings.sub_mode_hint"))
                }
            }
            .contentMargins(.vertical, 28, for: .scrollContent)
            .scrollClipDisabled()
        }
    }
}
