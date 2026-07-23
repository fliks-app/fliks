import SwiftUI

/// UI language override + home-wallpaper toggle. Binds directly to
/// `AppSettingsStore`; the language switch is live via `RootView`'s
/// `.id(locale.lang)` remount, no restart needed.
struct DisplaySettingsView: View {
    @Environment(AppSettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        VStack(alignment: .leading, spacing: 0) {
            Text(tr("display_settings.title"))
                .font(.title.bold())
                .padding(.horizontal, 60)
                .padding(.top, 48)
                .padding(.bottom, 24)
            Form {
                Section {
                    Picker(tr("display_settings.language"), selection: $settings.displayLanguage) {
                        Text(tr("display_settings.language_auto")).tag("")
                        Text("English").tag("en")
                        Text("Français").tag("fr")
                        Text("Español").tag("es")
                        Text("Deutsch").tag("de")
                        Text("Italiano").tag("it")
                        Text("Português").tag("pt")
                    }
                } footer: {
                    Text(tr("display_settings.language_hint"))
                }

                Section {
                    Toggle(tr("display_settings.home_background"), isOn: $settings.homeBackground)
                } footer: {
                    Text(tr("display_settings.home_background_hint"))
                }
            }
        }
    }
}
