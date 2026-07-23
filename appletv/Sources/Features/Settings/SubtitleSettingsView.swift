import SwiftUI

/// Preferred subtitle language, mode, appearance (size/color/shadow/
/// background), position margins, and hide-image-subtitles. Binds directly
/// to `AppSettingsStore`.
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

                Section {
                    Toggle(tr("playback_settings.sub_hide_image"), isOn: $settings.hideImageSubtitles)
                } footer: {
                    Text(tr("playback_settings.sub_hide_image_hint"))
                }

                Section {
                    Picker(tr("playback_settings.sub_size"), selection: $settings.subtitleSize) {
                        ForEach(SubtitleAppearanceOptions.sizes) { opt in Text(opt.label).tag(opt.value) }
                    }
                    Picker(tr("playback_settings.sub_color"), selection: $settings.subtitleColor) {
                        ForEach(SubtitleAppearanceOptions.colors) { opt in Text(opt.label).tag(opt.value) }
                    }
                    Picker(tr("playback_settings.sub_shadow"), selection: $settings.subtitleShadow) {
                        ForEach(SubtitleAppearanceOptions.shadows) { opt in Text(opt.label).tag(opt.value) }
                    }
                    Picker(tr("playback_settings.sub_bg"), selection: $settings.subtitleBackground) {
                        ForEach(SubtitleAppearanceOptions.backgrounds) { opt in Text(opt.label).tag(opt.value) }
                    }
                } header: {
                    Text(tr("playback_settings.sub_appearance_title"))
                } footer: {
                    Text(tr("playback_settings.sub_appearance_hint"))
                }

                Section {
                    Picker(tr("playback_settings.sub_bottom_margin"), selection: $settings.subtitleBottomMargin) {
                        ForEach(SubtitleAppearanceOptions.bottomMargins, id: \.self) { v in
                            Text("\(Int(v))%").tag(v)
                        }
                    }
                } header: {
                    Text(tr("playback_settings.sub_position_title"))
                } footer: {
                    Text(tr("playback_settings.sub_bottom_margin_hint"))
                }

                Section {
                    Picker(tr("playback_settings.sub_top_margin"), selection: $settings.subtitleTopMargin) {
                        ForEach(SubtitleAppearanceOptions.topMargins, id: \.self) { v in
                            Text("\(Int(v))%").tag(v)
                        }
                    }
                } footer: {
                    Text(tr("playback_settings.sub_top_margin_hint"))
                }
            }
        }
    }
}

/// Subtitle-appearance preset option lists (value/label), mirroring the
/// client's `SIZE_OPTIONS`/`COLOR_OPTIONS`/`SHADOW_OPTIONS`/`BG_OPTIONS` and
/// `BOTTOM_MARGIN_OPTIONS`/`TOP_MARGIN_OPTIONS` (`playback-options.ts`).
/// Labels are computed (not cached) so they stay correct across a live
/// language switch.
enum SubtitleAppearanceOptions {
    static var sizes: [LabeledOption] {
        [
            LabeledOption(value: "small", label: tr("settings.size.small")),
            LabeledOption(value: "normal", label: tr("settings.size.normal")),
            LabeledOption(value: "large", label: tr("settings.size.large")),
            LabeledOption(value: "xlarge", label: tr("settings.size.xlarge")),
        ]
    }
    static var colors: [LabeledOption] {
        [
            LabeledOption(value: "white", label: tr("settings.color.white")),
            LabeledOption(value: "yellow", label: tr("settings.color.yellow")),
            LabeledOption(value: "green", label: tr("settings.color.green")),
            LabeledOption(value: "cyan", label: tr("settings.color.cyan")),
        ]
    }
    static var shadows: [LabeledOption] {
        [
            LabeledOption(value: "none", label: tr("settings.shadow.none")),
            LabeledOption(value: "drop", label: tr("settings.shadow.drop")),
            LabeledOption(value: "outline", label: tr("settings.shadow.outline")),
            LabeledOption(value: "raised", label: tr("settings.shadow.raised")),
        ]
    }
    static var backgrounds: [LabeledOption] {
        [
            LabeledOption(value: "transparent", label: tr("settings.bg.transparent")),
            LabeledOption(value: "semi", label: tr("settings.bg.semi")),
            LabeledOption(value: "black", label: tr("settings.bg.black")),
        ]
    }
    static let bottomMargins: [Double] = [0, 5, 10, 15, 20]
    static let topMargins: [Double] = [0, 5, 10, 15]
}
