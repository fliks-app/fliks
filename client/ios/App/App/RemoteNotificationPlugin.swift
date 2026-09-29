import ActivityKit
import Capacitor
import UIKit

/**
 * iOS counterpart of the Android `RemoteNotificationPlugin`: while this phone
 * controls another Fliks device, a Live Activity mirrors what that device
 * plays. iOS can't post a Now Playing entry without playing audio locally, so
 * the lock screen card and Dynamic Island stand in for the media notification.
 *
 *   methods  update / clear
 *   events   remoteNotificationCommand { action, value, sent: true }
 *
 * A button tap reaches `handleCommand` through `RemoteActivityCommands` and is
 * sent to the server here, natively: the WebView is most likely suspended.
 * `sent` tells the WebView the command already went out.
 *
 * The access token lives in memory only. ActivityKit persists everything in
 * the attributes and state, and a token on disk is not worth the risk for a
 * card that is useless without the WebView refreshing it anyway.
 */
@objc(RemoteNotification)
public class RemoteNotificationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RemoteNotification"
    public let jsName = "RemoteNotification"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private typealias State = RemoteActivityAttributes.ContentState

    private struct Connection {
        var serverUrl: String
        var accessToken: String
        var targetId: String
        var byTargetId: String?
        var mediaId: Int?
        var episodeId: Int?
    }

    private struct MediaKey: Equatable {
        var mediaId: Int?
        var episodeId: Int?
    }

    /// Without push, nothing refreshes the card once the app is suspended, so
    /// it turns stale unless a real update lands first.
    private static let staleAfter: TimeInterval = 300
    /// A steady heartbeat changes nothing on screen, but the stale date still
    /// has to move forward now and then.
    private static let refreshEvery: TimeInterval = 120
    private static let positionTolerance: TimeInterval = 2
    private static let requestTimeout: TimeInterval = 8
    /// ActivityKit's cap is 4 KB for attributes plus state; this leaves room
    /// for the encoder's own overhead.
    private static let stateBudget = 3500
    private static let artworkBudget = 1800
    private static let seekStep: Double = 10

    private var connection: Connection?
    private var activity: Activity<RemoteActivityAttributes>?
    private var lastState: State?
    private var lastPushAt = Date.distantPast
    /// Bumped by every update and clear, so a slow artwork download or a failed
    /// command doesn't act on what has since been superseded.
    private var generation = 0
    /// What the user closed or stopped: not recreated by the next heartbeat.
    /// Cleared with the activity, or by another media.
    private var suppressed: MediaKey?

    private var artworkUrl: String?
    private var artworkTask: Task<Data?, Never>?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = Self.requestTimeout
        config.timeoutIntervalForResource = Self.requestTimeout
        return URLSession(configuration: config)
    }()

    override public func load() {
        for leftover in Activity<RemoteActivityAttributes>.activities {
            Task { await leftover.end(nil, dismissalPolicy: .immediate) }
        }
        RemoteActivityCommands.handler = { [weak self] action in
            guard let self else {
                await RemoteActivityCommands.endAll()
                return
            }
            await self.handleCommand(action)
        }
    }

    // MARK: - Plugin methods

    @objc func update(_ call: CAPPluginCall) {
        guard let title = call.getString("title") else {
            call.resolve()
            return
        }
        let input = Input(
            title: title,
            artist: call.getString("artist"),
            artworkUrl: call.getString("thumbnailUrl") ?? call.getString("artworkUrl"),
            playing: call.getBool("playing") ?? false,
            buffering: call.getBool("buffering") ?? false,
            position: call.getDouble("position") ?? 0,
            duration: call.getDouble("duration") ?? 0,
            hasNext: call.getBool("hasNext") ?? false,
            liked: call.getBool("liked"),
            seekButtons: call.getBool("seekButtons") ?? false,
            deviceName: call.getString("deviceName") ?? "",
            staleLabel: call.getString("staleLabel") ?? "",
            connection: parseConnection(call)
        )
        call.resolve()
        Task { @MainActor [weak self] in await self?.apply(input) }
    }

    @objc func clear(_ call: CAPPluginCall) {
        call.resolve()
        Task { @MainActor [weak self] in self?.reset() }
    }

    private struct Input {
        var title: String
        var artist: String?
        var artworkUrl: String?
        var playing: Bool
        var buffering: Bool
        var position: Double
        var duration: Double
        var hasNext: Bool
        var liked: Bool?
        var seekButtons: Bool
        var deviceName: String
        var staleLabel: String
        var connection: Connection?
    }

    private func parseConnection(_ call: CAPPluginCall) -> Connection? {
        guard let serverUrl = call.getString("serverUrl"), !serverUrl.isEmpty,
              let token = call.getString("accessToken"), !token.isEmpty,
              let targetId = call.getString("targetId"), !targetId.isEmpty else { return nil }
        return Connection(
            serverUrl: serverUrl.hasSuffix("/") ? String(serverUrl.dropLast()) : serverUrl,
            accessToken: token,
            targetId: targetId,
            byTargetId: call.getString("byTargetId"),
            mediaId: call.getInt("mediaId"),
            episodeId: call.getInt("episodeId")
        )
    }

    // MARK: - Activity

    @MainActor
    private func apply(_ input: Input) async {
        generation += 1
        let mine = generation
        connection = input.connection

        let key = MediaKey(mediaId: input.connection?.mediaId, episodeId: input.connection?.episodeId)
        if let suppressed {
            if suppressed == key { return }
            self.suppressed = nil
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        if let current = activity, current.activityState == .ended || current.activityState == .dismissed {
            // Closed from the lock screen: respect it until the media changes.
            activity = nil
            lastState = nil
            suppressed = key
            return
        }

        let artwork = await artworkData(for: input.artworkUrl)
        guard mine == generation else { return }

        let now = Date()
        let state = makeState(input, artwork: artwork, now: now)
        if let last = lastState, isRedundant(state, against: last, now: now) { return }
        await push(state, now: now)
    }

    @MainActor
    private func push(_ state: State, now: Date = Date()) async {
        lastState = state
        lastPushAt = now
        let content = ActivityContent(state: state, staleDate: now.addingTimeInterval(Self.staleAfter))
        if let activity {
            await activity.update(content)
            return
        }
        for stray in Activity<RemoteActivityAttributes>.activities {
            Task { await stray.end(nil, dismissalPolicy: .immediate) }
        }
        do {
            activity = try Activity.request(
                attributes: RemoteActivityAttributes(),
                content: content,
                pushType: nil
            )
        } catch {
            lastState = nil
            NSLog("[RemoteNotification] Live Activity refused: \(error.localizedDescription)")
        }
    }

    @MainActor
    private func reset() {
        generation += 1
        suppressed = nil
        connection = nil
        lastState = nil
        lastPushAt = .distantPast
        activity = nil
        let ending = Activity<RemoteActivityAttributes>.activities
        Task { await RemoteActivityCommands.end(ending) }
    }

    private func isRedundant(_ state: State, against last: State, now: Date) -> Bool {
        var probe = state
        probe.position = last.position
        probe.positionDate = last.positionDate
        return probe == last
            && abs(state.position - last.position(at: now)) < Self.positionTolerance
            && now.timeIntervalSince(lastPushAt) < Self.refreshEvery
    }

    private func makeState(_ input: Input, artwork: Data?, now: Date) -> State {
        func build(clip limit: Int, artwork: Data?) -> State {
            State(
                title: Self.clip(input.title, limit),
                subtitle: input.artist.map { Self.clip($0, limit) },
                deviceName: Self.clip(input.deviceName, limit),
                playing: input.playing,
                buffering: input.buffering,
                position: max(0, input.position),
                positionDate: now,
                duration: max(0, input.duration),
                hasNext: input.hasNext,
                seekButtons: input.seekButtons,
                liked: input.liked,
                stale: Self.clip(input.staleLabel, limit),
                artwork: artwork
            )
        }
        var state = build(clip: 100, artwork: artwork)
        if Self.encodedSize(state) > Self.stateBudget { state = build(clip: 100, artwork: nil) }
        if Self.encodedSize(state) > Self.stateBudget { state = build(clip: 40, artwork: nil) }
        return state
    }

    private static func clip(_ text: String, _ limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
    }

    private static func encodedSize(_ state: State) -> Int {
        (try? JSONEncoder().encode(state).count) ?? Int.max
    }

    // MARK: - Artwork

    @MainActor
    private func artworkData(for urlString: String?) async -> Data? {
        guard let urlString, let url = URL(string: urlString) else {
            artworkUrl = nil
            artworkTask = nil
            return nil
        }
        if artworkUrl != urlString {
            artworkUrl = urlString
            let session = session
            artworkTask = Task.detached(priority: .utility) {
                await Self.downloadArtwork(url, session: session)
            }
        }
        return await artworkTask?.value
    }

    /// Fetched without credentials: the poster may live on a third-party host,
    /// and the token has no business going there.
    private static func downloadArtwork(_ url: URL, session: URLSession) async -> Data? {
        guard let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false,
              let image = UIImage(data: data) else { return nil }
        return tinyJPEG(image)
    }

    /// The smallest step that fits: size first, then quality.
    private static func tinyJPEG(_ image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        for side: CGFloat in [112, 96, 80, 64, 48] {
            let scale = min(1, side / longest)
            let size = CGSize(
                width: max(1, (image.size.width * scale).rounded()),
                height: max(1, (image.size.height * scale).rounded())
            )
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            for quality: CGFloat in [0.5, 0.35, 0.2] {
                if let jpeg = small.jpegData(compressionQuality: quality), jpeg.count <= artworkBudget {
                    return jpeg
                }
            }
        }
        return nil
    }

    // MARK: - Commands

    private enum Outcome {
        case sent(action: String, value: Double)
        case ignored
    }

    @MainActor
    private func handleCommand(_ name: String) async {
        guard let current = activity, let conn = connection else {
            await RemoteActivityCommands.end(Activity<RemoteActivityAttributes>.activities)
            return
        }
        let before = current.content.state
        let now = Date()
        let position = before.position(at: now)
        var after = before
        after.position = position
        after.positionDate = now

        let action: String
        var value: Double = 0
        let request: (method: String, path: String, body: [String: Any])
        let commandPath = "/api/remote/\(Self.encodePath(conn.targetId))/command"
        var command: [String: Any] = [:]
        if let by = conn.byTargetId { command["byTargetId"] = by }

        switch name {
        case "playPause":
            action = before.playing ? "pause" : "play"
            after.playing.toggle()
            after.buffering = false
            request = ("POST", commandPath, command.merging(["action": action]) { $1 })
        case "back10", "forward10":
            action = "seek"
            let step = name == "back10" ? -Self.seekStep : Self.seekStep
            let ceiling = before.duration > 0 ? before.duration : .greatestFiniteMagnitude
            value = max(0, min(position + step, ceiling))
            after.position = value
            request = ("POST", commandPath, command.merging(["action": action, "positionSeconds": value]) { $1 })
        case "next":
            guard before.hasNext else { return }
            action = "next"
            after.buffering = true
            after.position = 0
            request = ("POST", commandPath, command.merging(["action": action]) { $1 })
        case "stop":
            action = "stop"
            request = ("POST", commandPath, command.merging(["action": action]) { $1 })
        case "like":
            guard let liked = before.liked, let mediaId = conn.mediaId else { return }
            action = "like"
            after.liked = !liked
            var body: [String: Any] = ["mediaId": mediaId]
            if let episodeId = conn.episodeId { body["episodeId"] = episodeId }
            request = (liked ? "DELETE" : "POST", "/api/likes", body)
        default:
            return
        }

        generation += 1
        let mine = generation

        // A stop can't be taken back once the card is gone, so it waits for the
        // server; every other command shows its effect straight away.
        if name != "stop" { await push(after) }
        let ok = await send(conn, request)
        if ok {
            if name == "stop" {
                suppressed = MediaKey(mediaId: conn.mediaId, episodeId: conn.episodeId)
                let ending = Activity<RemoteActivityAttributes>.activities
                activity = nil
                lastState = nil
                await RemoteActivityCommands.end(ending)
            }
            emit(action: action, value: value)
        } else if mine == generation {
            // The optimistic change didn't land. Back to what was on screen,
            // re-anchored so a playing card keeps counting, and flagged stale
            // since the state can't be trusted any more.
            var reverted = before
            reverted.position = before.position(at: Date())
            reverted.positionDate = Date()
            lastState = reverted
            // The next report has to go through, if only to lift the stale flag.
            lastPushAt = .distantPast
            await current.update(ActivityContent(state: reverted, staleDate: Date()))
        }
    }

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~"
    )

    private static func encodePath(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: unreserved) ?? segment
    }

    @MainActor
    private func send(_ conn: Connection, _ request: (method: String, path: String, body: [String: Any])) async -> Bool {
        guard let url = URL(string: conn.serverUrl + request.path),
              let body = try? JSONSerialization.data(withJSONObject: request.body) else { return false }
        var urlRequest = URLRequest(url: url, timeoutInterval: Self.requestTimeout)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = body
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("Bearer \(conn.accessToken)", forHTTPHeaderField: "Authorization")
        guard let (_, response) = try? await session.data(for: urlRequest, delegate: RefuseRedirect()),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }

    /// URLSession carries the Authorization header across a redirect, even to
    /// another host: the token is for the server alone.
    private final class RefuseRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    private func emit(action: String, value: Double) {
        let js = "window.dispatchEvent(new CustomEvent('remoteNotificationCommand', "
            + "{ detail: { action: '\(action)', value: \(value.isFinite ? value : 0), sent: true } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }
}
