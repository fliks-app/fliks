import Foundation
import AVFoundation
import MediaPlayer
import Capacitor

/// The native audio player (music queue, audiobook parts): an AVQueuePlayer holding the playing and the next
/// item for a gapless hand-over. The web layer owns the queue and beats; this side resolves music streams.
@objc(AudioPlayerPlugin)
public class AudioPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioPlayerPlugin"
    public let jsName = "AudioPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadParts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStems", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStemMix", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearStems", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRepeat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRouted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    struct Entry {
        var itemId: Int?
        var mediaId: Int?
        var title = ""
        var artist: String?
        var album: String?
        var artwork: String?
        var gain: Double?
        var peak: Double?
        var albumGain: Double?
        var albumPeak: Double?
        var url: URL?
    }

    private struct Resolved {
        let path: String
        let sessionId: String
        let mediaFileId: Int
    }

    private enum StreamFailure: Error {
        /// The server would transcode: not served natively, never retried.
        case notPlayable
        case unavailable
    }

    private static let capacitorFile = "capacitor://localhost/_capacitor_file_/"

    private let player = AVQueuePlayer()
    private var entries: [Entry] = []
    private var index = 0
    private var indexOfItem: [ObjectIdentifier: Int] = [:]
    private var resolved: [Int: Resolved] = [:]
    private var streamTokens: [Int: (token: String, expiresAt: Double)] = [:]
    /// Server and user the queue started under; a different signed-in session never reaches it.
    private var boundKey: String?
    private var recoveredAt: Int?
    private var generation = 0
    private var repeatMode = "off"
    private var rate: Float = 1
    private var gainMode = "track"
    private var preamp = 0
    private var duck = 1.0
    private var routed = false
    private var isMusic = true
    private var deviceProfile: String?
    private var ended = false
    private var loading = false
    private var lastItem: ObjectIdentifier?

    private var stemPlayers: [AVPlayer] = []
    private var stemKey: String?
    private var stemMix = (main: 1.0, instrumental: 0.0, vocals: 0.0)
    private var stemTimer: Timer?
    private var stemObservers: [NSKeyValueObservation] = []

    private var timeObserver: Any?
    private var itemObserver: NSKeyValueObservation?
    private var statusObserver: NSKeyValueObservation?
    private var failureObserver: NSKeyValueObservation?
    private var readyObserver: NSKeyValueObservation?

    private lazy var nowPlaying: NowPlayingController = {
        let controller = NowPlayingController(
            emitEvent: { [weak self] name in
                self?.notifyListeners("command", data: ["command": name == "nativePlayerNext" ? "next" : "previous", "value": 0])
            },
            didSeek: { [weak self] in self?.emitPosition() },
            mediaType: .audio
        )
        controller.intercept = { [weak self] command, value in
            guard let self = self, self.routed else { return false }
            self.notifyListeners("command", data: ["command": command, "value": value])
            return true
        }
        return controller
    }()

    public override func load() {
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            guard let self = self, self.player.timeControlStatus == .playing else { return }
            self.emitPosition()
        }
        itemObserver = player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.currentItemChanged() }
        }
        statusObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                if self?.player.timeControlStatus == .playing { self?.recoveredAt = nil }
                self?.emitState()
                self?.nowPlaying.refresh()
            }
        }
    }

    // MARK: - Plugin methods

    @objc func configure(_ call: CAPPluginCall) {
        deviceProfile = call.getString("deviceProfile")
        call.resolve()
    }

    @objc func attach(_ call: CAPPluginCall) {
        call.resolve()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.entries.isEmpty else { return }
            if self.isMusic { self.emitQueue() }
            self.emitTrack()
            self.emitState()
        }
    }

    @objc func detach(_ call: CAPPluginCall) { call.resolve() }

    @objc func setQueue(_ call: CAPPluginCall) {
        let tracks = (call.getArray("tracks") as? [[String: Any]] ?? []).map(Self.entry)
        let index = call.getInt("index") ?? 0
        let startAt = call.getDouble("startAt") ?? 0
        let autoplay = call.getBool("autoplay") ?? true
        DispatchQueue.main.async {
            self.isMusic = true
            self.boundKey = self.session()?.key
            self.entries = tracks
            self.begin(at: index, startAt: startAt, autoplay: autoplay)
            call.resolve()
        }
    }

    @objc func updateQueue(_ call: CAPPluginCall) {
        let tracks = (call.getArray("tracks") as? [[String: Any]] ?? []).map(Self.entry)
        let index = call.getInt("index") ?? 0
        DispatchQueue.main.async {
            let current = self.entries.indices.contains(self.index) ? self.entries[self.index].itemId : nil
            guard current != nil, tracks.indices.contains(index), tracks[index].itemId == current else {
                self.entries = tracks
                self.begin(at: index, startAt: 0, autoplay: self.player.timeControlStatus != .paused)
                return call.resolve()
            }
            self.entries = tracks
            self.index = index
            for item in self.player.items().dropFirst() { self.player.remove(item) }
            self.applyGain()
            self.prefetchNext()
            call.resolve()
        }
    }

    @objc func loadParts(_ call: CAPPluginCall) {
        let parts = call.getArray("parts") as? [[String: Any]] ?? []
        var base = Entry()
        base.title = call.getString("title") ?? ""
        base.artist = call.getString("artist")
        base.album = call.getString("album")
        base.artwork = call.getString("artworkUrl")
        let index = call.getInt("index") ?? 0
        let startAt = call.getDouble("startAt") ?? 0
        let autoplay = call.getBool("autoplay") ?? true
        let rate = Float(call.getDouble("rate") ?? 1)
        DispatchQueue.main.async {
            self.isMusic = false
            self.rate = rate
            self.entries = parts.map { part in
                var e = base
                e.url = Self.fileUrl(part["url"] as? String ?? "")
                return e
            }
            self.begin(at: index, startAt: startAt, autoplay: autoplay)
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.activateSession()
            self.player.playImmediately(atRate: self.rate)
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.pause()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let position = call.getDouble("position") ?? 0
        let target = call.getInt("index")
        DispatchQueue.main.async {
            if let target = target, target != self.index {
                self.begin(at: target, startAt: position, autoplay: self.player.timeControlStatus != .paused)
            } else {
                self.player.seek(to: CMTime(seconds: position, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
                self.ended = false
            }
            call.resolve()
        }
    }

    @objc func skipTo(_ call: CAPPluginCall) {
        let index = call.getInt("index") ?? 0
        DispatchQueue.main.async {
            self.begin(at: index, startAt: 0, autoplay: self.player.timeControlStatus != .paused)
            call.resolve()
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let rate = Float(call.getDouble("rate") ?? 1)
        DispatchQueue.main.async {
            self.rate = rate
            self.player.defaultRate = rate
            if self.player.timeControlStatus != .paused { self.player.rate = rate }
            call.resolve()
        }
    }

    @objc func setGain(_ call: CAPPluginCall) {
        gainMode = call.getString("mode") ?? "track"
        preamp = call.getInt("preamp") ?? 0
        duck = call.getDouble("duck") ?? 1
        DispatchQueue.main.async {
            self.applyGain()
            call.resolve()
        }
    }

    @objc func setRepeat(_ call: CAPPluginCall) {
        repeatMode = call.getString("mode") ?? "off"
        DispatchQueue.main.async {
            for item in self.player.items().dropFirst() { self.player.remove(item) }
            self.prefetchNext()
            call.resolve()
        }
    }

    @objc func setRouted(_ call: CAPPluginCall) {
        routed = call.getBool("routed") ?? false
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopAll()
            call.resolve()
        }
    }

    private func stopAll() {
        generation += 1
        clearStems()
        loading = false
        player.pause()
        player.removeAllItems()
        entries = []
        indexOfItem = [:]
        endSessions(keeping: [])
        boundKey = nil
        streamTokens = [:]
        nowPlaying.deactivate(releaseSession: true)
    }

    // MARK: - Queue

    /// Replaces the player's items with the entry at `index`, then lines up the next one.
    private func begin(at index: Int, startAt: Double, autoplay: Bool) {
        guard entries.indices.contains(index) else { return }
        generation += 1
        let mine = generation
        self.index = index
        ended = false
        loading = true
        lastItem = nil
        player.pause()
        player.removeAllItems()
        indexOfItem = [:]
        activateSession()
        player.defaultRate = rate
        Task { @MainActor in
            guard let (item, found) = await self.makeItem(from: index), mine == self.generation else { return }
            self.index = found
            self.indexOfItem[ObjectIdentifier(item)] = found
            self.player.insert(item, after: nil)
            self.loading = false
            if startAt > 0 {
                await self.player.seek(to: CMTime(seconds: startAt, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
            }
            if autoplay { self.player.playImmediately(atRate: self.rate) }
        }
    }

    private func nextIndex() -> Int? {
        if repeatMode == "one" { return index }
        if index + 1 < entries.count { return index + 1 }
        return repeatMode == "all" && !entries.isEmpty ? 0 : nil
    }

    private func prefetchNext() {
        guard player.items().count < 2, let next = nextIndex() else { return }
        let mine = generation
        let current = index
        Task { @MainActor in
            guard let (item, found) = await self.makeItem(from: next), mine == self.generation, current == self.index, self.player.items().count < 2 else { return }
            self.indexOfItem[ObjectIdentifier(item)] = found
            self.player.insert(item, after: self.player.items().last)
        }
    }

    /// The first playable entry from `start` on: an entry the server would transcode is skipped.
    private func makeItem(from start: Int) async -> (AVPlayerItem, Int)? {
        var i = start
        while entries.indices.contains(i) {
            switch await makeItem(i) {
            case .success(let item): return (item, i)
            case .failure(.notPlayable): i += 1
            case .failure(.unavailable): return nil
            }
        }
        return nil
    }

    private func makeItem(_ i: Int) async -> Result<AVPlayerItem, StreamFailure> {
        let entry = entries[i]
        var url = entry.url
        if url == nil, let id = entry.itemId {
            switch await resolve(itemId: id) {
            case .success(let r): url = await streamUrl(r)
            case .failure(let failure):
                notifyListeners("error", data: ["message": "no stream for track \(i)"])
                return .failure(failure)
            }
        }
        guard let url = url else {
            notifyListeners("error", data: ["message": "no stream for track \(i)"])
            return .failure(.unavailable)
        }
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .timeDomain
        return .success(item)
    }

    /// The item the player moved on to: its entry becomes the current one and the next is lined up.
    private func currentItemChanged() {
        guard let item = player.currentItem else {
            if !entries.isEmpty, !loading, !ended {
                ended = true
                emitState()
            }
            return
        }
        let id = ObjectIdentifier(item)
        guard id != lastItem, let i = indexOfItem[id] else { return }
        lastItem = id
        failureObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            DispatchQueue.main.async { self?.recover(item) }
        }
        index = i
        if stemKey != nil {
            clearStems()
            notifyListeners("stems", data: ["state": "cleared"])
        }
        let live = Set(player.items().map(ObjectIdentifier.init))
        indexOfItem = indexOfItem.filter { live.contains($0.key) }
        applyGain()
        prefetchNext()
        trackStarted()
    }

    private func trackStarted() {
        guard entries.indices.contains(index) else { return }
        let keep = [entries[index].itemId, nextIndex().flatMap { entries[$0].itemId }].compactMap { $0 }
        endSessions(keeping: keep)
        emitTrack()
        let e = entries[index]
        nowPlaying.activate(player: player, title: e.title, artist: e.artist, artworkUrl: artworkUrl(e.artwork), headers: [:], streamHost: nil)
        nowPlaying.setQueueNav(hasPrevious: true, hasNext: isMusic ? (nextIndex() != nil) : false, seekButtons: !isMusic)
    }

    // MARK: - Streams

    private func session() -> (key: String, server: String, token: String)? {
        let defaults = UserDefaults.standard
        guard let key = defaults.string(forKey: "CapacitorStorage.fliks_active_session"),
              let raw = defaults.string(forKey: "CapacitorStorage.fliks_sessions"),
              let list = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [[String: Any]] else { return nil }
        for s in list {
            let server = s["serverUrl"] as? String ?? ""
            let user = ((s["user"] as? [String: Any])?["id"] as? NSNumber)?.intValue ?? 0
            if "\(server)::\(user)" == key, let token = s["accessToken"] as? String, !token.isEmpty { return (key, server, token) }
        }
        return nil
    }

    /// A call under session `key`; a 401 has the web layer refresh the session, then runs once more.
    /// Under another signed-in session nothing is sent and the queue ends.
    @MainActor
    private func apiCall(_ key: String, _ method: String, _ path: String, body: Data? = nil) async -> (data: Data, status: Int)? {
        for attempt in 0..<2 {
            guard let s = session(), s.key == key, let url = URL(string: s.server + path) else {
                if key == boundKey { stopAll() }
                return nil
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.httpBody = body
            if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            request.setValue("Bearer \(s.token)", forHTTPHeaderField: "Authorization")
            // The kinds of the bundled web registry (`KIND_REGISTRY`).
            request.setValue("movie,series,book,comic,album", forHTTPHeaderField: "X-Fliks-Kinds")
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  let status = (response as? HTTPURLResponse)?.statusCode else { return nil }
            if status == 401, attempt == 0, await refreshed(key, rejected: s.token) { continue }
            return (data, status)
        }
        return nil
    }

    /// True once session `key` stores a token other than the rejected one: the web layer, asked to
    /// refresh, persists it. Waits at most 10 s.
    @MainActor
    private func refreshed(_ key: String, rejected: String) async -> Bool {
        if let s = session(), s.key == key, s.token != rejected { return true }
        notifyListeners("refresh", data: [:])
        for _ in 0..<50 {
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let s = session(), s.key == key else { return false }
            if s.token != rejected { return true }
        }
        return false
    }

    @MainActor
    private func resolve(itemId: Int) async -> Result<Resolved, StreamFailure> {
        if let known = resolved[itemId] { return .success(known) }
        guard let key = boundKey, let profile = deviceProfile,
              let (data, status) = await apiCall(key, "POST", "/api/items/\(itemId)/playback-info?startAt=0", body: Data(profile.utf8)),
              (200..<300).contains(status),
              let info = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return .failure(.unavailable) }
        let sid = info["sessionId"] as? String ?? ""
        let mediaFileId = (info["mediaFileId"] as? NSNumber)?.intValue ?? 0
        guard info["playMethod"] as? String == "DirectPlay" else {
            endSession(Resolved(path: "", sessionId: sid, mediaFileId: mediaFileId))
            return .failure(.notPlayable)
        }
        let parts = info["parts"] as? [[String: Any]]
        guard var path = (parts?.first?["playUrl"] as? String) ?? (info["playUrl"] as? String) else { return .failure(.unavailable) }
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        let r = Resolved(path: path, sessionId: sid, mediaFileId: mediaFileId)
        resolved[itemId] = r
        return .success(r)
    }

    /// The stream URL, bound to its file by a stream token reused while it has 30 min of life left.
    @MainActor
    private func streamUrl(_ r: Resolved) async -> URL? {
        guard let key = boundKey else { return nil }
        var token = streamTokens[r.mediaFileId].flatMap { $0.expiresAt - Date().timeIntervalSince1970 * 1000 > 30 * 60 * 1000 ? $0.token : nil }
        if token == nil {
            let body = try? JSONSerialization.data(withJSONObject: ["mediaFileId": r.mediaFileId])
            guard let (data, status) = await apiCall(key, "POST", "/api/auth/stream-token", body: body), (200..<300).contains(status),
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let minted = json["streamToken"] as? String,
                  let expiresAt = (json["expiresAt"] as? NSNumber)?.doubleValue else { return nil }
            streamTokens[r.mediaFileId] = (minted, expiresAt)
            token = minted
        }
        guard let server = session()?.server else { return nil }
        var comps = URLComponents(string: server + r.path)
        comps?.queryItems = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "sid", value: r.sessionId)]
        return comps?.url
    }

    /// Ends the sessions of tracks that are no longer playing or lined up.
    private func endSessions(keeping keep: [Int]) {
        for (id, r) in resolved where !keep.contains(id) {
            resolved[id] = nil
            endSession(r)
        }
    }

    private func endSession(_ r: Resolved) {
        guard let key = boundKey, !r.sessionId.isEmpty,
              let sid = r.sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return }
        Task { @MainActor in _ = await self.apiCall(key, "DELETE", "/api/stream/sessions/\(sid)") }
    }

    /// The current item failed to load (a stream URL outlived its token while paused): it is rebuilt at the
    /// same position once, with the stream session and token minted again.
    private func recover(_ item: AVPlayerItem) {
        guard item === player.currentItem, recoveredAt != index, entries.indices.contains(index) else {
            notifyListeners("error", data: ["message": "playback failed"])
            return
        }
        recoveredAt = index
        if let id = entries[index].itemId, let r = resolved.removeValue(forKey: id) {
            endSession(r)
            streamTokens[r.mediaFileId] = nil
        }
        let wasPlaying = player.timeControlStatus != .paused
        begin(at: index, startAt: max(player.currentTime().seconds, 0), autoplay: wasPlaying)
    }

    /// Images are public: no token rides along.
    private func artworkUrl(_ path: String?) -> String? {
        guard let path = path, !path.isEmpty else { return nil }
        guard path.hasPrefix("/"), let server = session()?.server else { return path }
        return server + path
    }

    private static func fileUrl(_ url: String) -> URL? {
        if url.hasPrefix(capacitorFile) { return URL(string: "file:///" + url.dropFirst(capacitorFile.count)) }
        return URL(string: url)
    }

    private static func num(_ v: Any?) -> Double? {
        (v as? NSNumber)?.doubleValue
    }

    private static func entry(_ t: [String: Any]) -> Entry {
        var e = Entry()
        e.itemId = (t["itemId"] as? NSNumber)?.intValue
        e.mediaId = (t["mediaId"] as? NSNumber)?.intValue
        e.title = t["title"] as? String ?? ""
        e.artist = t["artists"] as? String
        e.album = t["albumTitle"] as? String
        e.artwork = t["coverUrl"] as? String
        e.gain = num(t["gain"])
        e.peak = num(t["peak"])
        e.albumGain = num(t["albumGain"])
        e.albumPeak = num(t["albumPeak"])
        return e
    }

    // MARK: - Gain and session

    /// A ReplayGain boost has no AVPlayer path: the volume only attenuates, as in the browser.
    private func applyGain() {
        var scale = min(1, duck)
        if isMusic, entries.indices.contains(index), gainMode != "off" {
            let e = entries[index]
            let oneAlbum = Set(entries.compactMap { $0.mediaId }).count == 1
            let album = gainMode == "album" && oneAlbum && e.albumGain != nil
            var factor = 1.0
            if let g = album ? e.albumGain : e.gain {
                factor = pow(10, (g + Double(preamp)) / 20)
                if let peak = album ? e.albumPeak : e.peak, peak > 0, factor * peak > 1 { factor = 1 / peak }
            }
            scale = min(1, factor * duck)
        }
        let ready = stemsReady
        player.volume = Float(scale * (ready ? stemMix.main : 1))
        stemPlayers.first?.volume = Float(ready ? min(1, stemMix.instrumental * scale) : 0)
        stemPlayers.last?.volume = Float(ready ? min(1, stemMix.vocals * scale) : 0)
    }

    // MARK: - Stems (karaoke spec rule 30)

    /// True once both stems can play: the queue's player stays audible until then.
    private var stemsReady: Bool {
        stemPlayers.count == 2 && stemPlayers.allSatisfy { $0.currentItem?.status == .readyToPlay }
    }

    @objc func setStems(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let i = call.getString("instrumentalUrl").flatMap(URL.init(string:)),
              let v = call.getString("vocalsUrl").flatMap(URL.init(string:)) else { return call.reject("bad stems") }
        DispatchQueue.main.async {
            if self.stemKey != key { self.loadStems(key, i, v) }
            call.resolve()
        }
    }

    @objc func setStemMix(_ call: CAPPluginCall) {
        let mix = (main: call.getDouble("main") ?? 1, instrumental: call.getDouble("instrumental") ?? 0, vocals: call.getDouble("vocals") ?? 0)
        DispatchQueue.main.async {
            self.stemMix = mix
            self.applyGain()
            call.resolve()
        }
    }

    @objc func clearStems(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.clearStems()
            call.resolve()
        }
    }

    private func loadStems(_ key: String, _ instrumental: URL, _ vocals: URL) {
        clearStems()
        stemKey = key
        stemPlayers = [instrumental, vocals].map { url in
            let item = AVPlayerItem(url: url)
            item.audioTimePitchAlgorithm = .spectral
            let p = AVPlayer(playerItem: item)
            p.volume = 0
            p.automaticallyWaitsToMinimizeStalling = false
            stemObservers.append(item.observe(\.status, options: [.new]) { [weak self] item, _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if item.status == .failed {
                        self.clearStems()
                        self.notifyListeners("stems", data: ["state": "failed"])
                    } else {
                        self.applyGain()
                        self.syncStems()
                    }
                }
            })
            return p
        }
        stemTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.syncStems() }
    }

    private func clearStems() {
        stemTimer?.invalidate()
        stemTimer = nil
        stemObservers = []
        let had = !stemPlayers.isEmpty
        stemPlayers.forEach { $0.pause(); $0.replaceCurrentItem(with: nil) }
        stemPlayers = []
        stemKey = nil
        if had { applyGain() }
    }

    /// Follows the queue's player: play or pause, rate, and a seek past 150 ms of drift.
    private func syncStems() {
        let run = player.timeControlStatus == .playing
        let at = player.currentTime()
        for p in stemPlayers where p.currentItem?.status == .readyToPlay {
            if abs(p.currentTime().seconds - at.seconds) > 0.15 { p.seek(to: at, toleranceBefore: .zero, toleranceAfter: .zero) }
            if run { if p.rate != rate { p.rate = rate } } else if p.rate != 0 { p.pause() }
        }
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        let voice = (bridge?.plugin(withName: "NativePlayer") as? NativePlayerPlugin)?.voiceActive ?? false
        let options: AVAudioSession.CategoryOptions = voice ? [.mixWithOthers, .allowAirPlay, .allowBluetoothA2DP] : [.allowAirPlay, .allowBluetoothA2DP]
        try? session.setCategory(.playback, mode: .default, options: options)
        try? session.setActive(true)
    }

    // MARK: - Events

    private func emitState() {
        let status = player.timeControlStatus
        notifyListeners("state", data: [
            "playing": status == .playing,
            "playWhenReady": status != .paused,
            "buffering": status == .waitingToPlayAtSpecifiedRate && player.reasonForWaitingToPlay == .toMinimizeStalls,
            "ready": player.currentItem?.status == .readyToPlay,
            "ended": ended,
        ])
    }

    private func emitPosition() {
        guard let item = player.currentItem else { return }
        let duration = item.duration.seconds
        notifyListeners("position", data: [
            "index": index,
            "position": max(player.currentTime().seconds, 0),
            "duration": duration.isFinite ? duration : 0,
        ])
    }

    private func emitTrack() {
        var data: [String: Any] = ["index": index]
        if entries.indices.contains(index), let id = entries[index].itemId {
            data["itemId"] = id
            if let r = resolved[id] {
                data["mediaFileId"] = r.mediaFileId
                data["sessionId"] = r.sessionId
            }
        }
        notifyListeners("track", data: data)
    }

    private func emitQueue() {
        let tracks: [[String: Any]] = entries.map { e in
            [
                "itemId": e.itemId as Any, "mediaId": e.mediaId as Any, "title": e.title,
                "artists": e.artist ?? "", "albumTitle": e.album ?? "", "coverUrl": e.artwork as Any,
                "durationSeconds": NSNull(), "gain": e.gain as Any, "peak": e.peak as Any,
                "albumGain": e.albumGain as Any, "albumPeak": e.albumPeak as Any,
            ]
        }
        notifyListeners("queue", data: ["tracks": tracks, "index": index])
    }
}
