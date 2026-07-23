import SwiftUI

/// Player behavior: audio language preference, HDR override, eco qualities,
/// auto-skip-intro, auto-play-next. Binds directly to `AppSettingsStore` —
/// `DeviceProfileBuilder` reads the same properties for the next request.
struct PlayerSettingsView: View {
    @Environment(AppSettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        VStack(alignment: .leading, spacing: 0) {
            Text(tr("playback_settings.tab_player"))
                .font(.title.bold())
                .padding(.horizontal, 60)
                .padding(.top, 48)
                .padding(.bottom, 24)
            Form {
                Section {
                    Picker(tr("playback_settings.player_preferred_lang"), selection: $settings.preferredAudioLanguage) {
                        ForEach(PreferredLanguageOptions.all) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                } footer: {
                    Text(tr("playback_settings.player_preferred_lang_hint"))
                }

                Section {
                    Toggle(tr("playback_settings.player_use_default"), isOn: $settings.useDefaultAudioStream)
                } footer: {
                    Text(tr("playback_settings.player_use_default_hint"))
                }

                Section {
                    Toggle(tr("playback_settings.player_disable_hdr"), isOn: $settings.forceDisableHdr)
                } footer: {
                    Text(tr("playback_settings.player_disable_hdr_hint"))
                }

                Section {
                    Toggle(tr("playback_settings.player_show_eco"), isOn: $settings.showEcoQualities)
                    Toggle(tr("playback_settings.player_eco_default"), isOn: $settings.ecoByDefault)
                } footer: {
                    Text(tr("playback_settings.player_eco_default_hint"))
                }

                Section {
                    Toggle(tr("playback_settings.player_auto_skip_intro"), isOn: $settings.autoSkipIntro)
                    Toggle(tr("playback_settings.player_auto_play_next"), isOn: $settings.autoPlayNext)
                }
            }
        }
    }
}
