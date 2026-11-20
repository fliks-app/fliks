import CarPlay
import Capacitor
import UIKit

/// The player lives in a Capacitor plugin. A CarPlay launch with no phone window has no bridge, so one is
/// created without a window; the phone scene adopts it when it connects.
@MainActor
enum CarPlayHost {
    static var headless: FlksViewController?

    static func plugin() -> AudioPlayerPlugin? {
        if AudioPlayerPlugin.shared == nil {
            let vc = FlksViewController()
            vc.loadViewIfNeeded()
            headless = vc
        }
        return AudioPlayerPlugin.shared
    }
}

/// CarPlay's copy from the app's translations (`carplay` branch of `public/i18n`).
private enum CarText {
    static subscript(_ key: String) -> String { BundledText["carplay.\(key)"] ?? key }
}

/// Audio-only CarPlay: browse tabs and the Now Playing template, over the account's music.
@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var controller: CPInterfaceController?
    private let images = NSCache<NSString, UIImage>()
    private var signInWatch: NSObjectProtocol?

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        controller = interfaceController
        interfaceController.setRootTemplate(root(), animated: false, completion: nil)
        watchSignIn()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        controller = nil
        stopWatching()
    }

    private func stopWatching() {
        if let watch = signInWatch { NotificationCenter.default.removeObserver(watch) }
        signInWatch = nil
    }

    /// A phone sign-in after the car connected replaces the signed-out root once the session is stored.
    private func watchSignIn() {
        guard catalog == nil, signInWatch == nil else { return }
        signInWatch = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.catalog != nil else { return }
                self.stopWatching()
                self.controller?.setRootTemplate(self.root(), animated: false, completion: nil)
            }
        }
    }

    private var catalog: CarPlayCatalog? {
        guard let plugin = CarPlayHost.plugin(), plugin.hasProfile, let key = plugin.session()?.key else { return nil }
        return CarPlayCatalog(plugin: plugin, key: key)
    }

    // MARK: - Templates

    private func root() -> CPTemplate {
        guard catalog != nil else {
            return CPListTemplate(title: "Fliks", sections: [CPListSection(items: [message(CarText["signed_out"])])])
        }
        let tabs: [(String, String, String)] = [
            ("recent", CarText["recent"], "clock"),
            ("playlists", CarText["playlists"], "music.note.list"),
            ("albums", CarText["albums"], "square.stack"),
            ("artists", CarText["artists"], "music.mic"),
        ]
        let templates = tabs.map { id, title, symbol -> CPListTemplate in
            let template = list(id, title: title)
            template.tabImage = UIImage(systemName: symbol) ?? UIImage()
            return template
        }
        return CPTabBarTemplate(templates: templates)
    }

    private func list(_ id: String, title: String) -> CPListTemplate {
        let template = CPListTemplate(title: title, sections: [])
        template.emptyViewSubtitleVariants = [CarText["loading"]]
        Task {
            guard let catalog = self.catalog else { return }
            let listing = await catalog.listing(id)
            var rows = listing?.rows ?? []
            if id == "playlists" {
                rows.insert(CarRow(folder: "favourites", title: CarText["favourites"]), at: 0)
            }
            let items = listing == nil
                ? [self.message(CarText["failed"])]
                : rows.map { self.item($0, listing ?? CarListing()) }
            template.updateSections([CPListSection(items: items)])
            template.emptyViewSubtitleVariants = [CarText["empty"]]
        }
        return template
    }

    private func message(_ text: String) -> CPListItem {
        let item = CPListItem(text: text, detailText: nil)
        item.isEnabled = false
        return item
    }

    private func item(_ row: CarRow, _ listing: CarListing) -> CPListItem {
        let item = CPListItem(text: row.title, detailText: row.subtitle)
        item.accessoryType = row.folder != nil ? .disclosureIndicator : .none
        item.handler = { [weak self] _, done in
            self?.open(row, listing)
            done()
        }
        if let path = row.artwork { loadImage(path, into: item) }
        return item
    }

    private func open(_ row: CarRow, _ listing: CarListing) {
        if let folder = row.folder {
            controller?.pushTemplate(list(folder, title: row.title), animated: true, completion: nil)
        } else if let track = row.track, let plugin = CarPlayHost.plugin() {
            plugin.playFromCar(listing.queue, index: track)
            if !(controller?.topTemplate is CPNowPlayingTemplate) {
                controller?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
            }
        }
    }

    // MARK: - Artwork

    private func loadImage(_ path: String, into item: CPListItem) {
        guard let server = AudioPlayerPlugin.shared?.session()?.server,
              let url = URL(string: path.hasPrefix("/") ? server + path + (path.hasPrefix("/api/images/") ? (path.contains("?") ? "&" : "?") + "size=thumb" : "") : path) else { return }
        let key = url.absoluteString as NSString
        if let cached = images.object(forKey: key) { return item.setImage(cached) }
        Task {
            guard let (data, _) = try? await URLSession.shared.data(from: url), let full = UIImage(data: data) else { return }
            let image = await full.byPreparingThumbnail(ofSize: CPListItem.maximumImageSize) ?? full
            self.images.setObject(image, forKey: key)
            item.setImage(image)
        }
    }
}
