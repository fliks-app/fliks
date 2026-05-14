import Foundation

/// Build-time configuration injected via Xcode build settings.
///
/// Values are set in project.yml as `GCC_PREPROCESSOR_DEFINITIONS` and
/// read from Info.plist at runtime. The CI passes them as xcodebuild
/// arguments: `TMDB_API_KEY=xxx TVDB_API_KEY=yyy`.
enum BuildConfig {
    static let tmdbApiKey: String = {
        Bundle.main.infoDictionary?["TMDB_API_KEY"] as? String ?? ""
    }()

    static let tvdbApiKey: String = {
        Bundle.main.infoDictionary?["TVDB_API_KEY"] as? String ?? ""
    }()
}
