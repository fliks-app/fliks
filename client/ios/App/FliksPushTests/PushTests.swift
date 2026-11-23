import CryptoKit
import UIKit
import UserNotifications
import XCTest

/// RFC 8291 encryption, only here: the app never encrypts.
private func encrypt(_ plain: Data, to publicKey: Data, auth: Data, ephemeral: P256.KeyAgreement.PrivateKey = .init(), salt: Data = Data((0..<16).map { _ in UInt8.random(in: 0...255) })) -> Data {
    let receiver = try! P256.KeyAgreement.PublicKey(x963Representation: publicKey)
    let secret = try! ephemeral.sharedSecretFromKeyAgreement(with: receiver)
    let senderKey = ephemeral.publicKey.x963Representation
    let info = Data("WebPush: info".utf8) + [0] + publicKey + senderKey
    let ikm = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: auth, sharedInfo: info, outputByteCount: 32)
    let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: aes128gcm".utf8) + [0], outputByteCount: 16)
    let nonce = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: nonce".utf8) + [0], outputByteCount: 12)
    let box = try! AES.GCM.seal(plain + [2], using: key, nonce: AES.GCM.Nonce(data: nonce.withUnsafeBytes { Data($0) }))
    return salt + Data([0, 0, 0x10, 0, 65]) + senderKey + box.ciphertext + box.tag
}

final class PushCryptoTests: XCTestCase {
    // RFC 8291 Appendix A.
    private let uaPrivate = Data(base64URL: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")!
    private let uaPublic = Data(base64URL: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")!
    private let auth = Data(base64URL: "BTBZMqHH6r4Tts7J_aSIgg")!
    private let message = Data(base64URL: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")!

    func testDecryptsTheRFCExample() throws {
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: uaPrivate)
        XCTAssertEqual(key.publicKey.x963Representation, uaPublic)
        let plain = PushCrypto.decrypt(message, privateKey: key, auth: auth)
        XCTAssertEqual(plain.flatMap { String(data: $0, encoding: .utf8) }, "When I grow up, I want to be a watermelon")
    }

    func testEncryptHelperReproducesTheRFCExample() throws {
        let sender = try P256.KeyAgreement.PrivateKey(rawRepresentation: Data(base64URL: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")!)
        let out = encrypt(Data("When I grow up, I want to be a watermelon".utf8), to: uaPublic, auth: auth, ephemeral: sender, salt: Data(base64URL: "DGv6ra1nlYgDCS1FRnbzlw")!)
        XCTAssertEqual(out, message)
    }

    func testRefusesATamperedOrWrongKeyMessage() throws {
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: uaPrivate)
        var bad = message
        bad[bad.count - 1] ^= 1
        XCTAssertNil(PushCrypto.decrypt(bad, privateKey: key, auth: auth))
        XCTAssertNil(PushCrypto.decrypt(message, privateKey: P256.KeyAgreement.PrivateKey(), auth: auth))
        XCTAssertNil(PushCrypto.decrypt(Data(count: 10), privateKey: key, auth: auth))
    }
}

final class PushPipelineTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let relayKey = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
    private let sub = "EBESExQVFhcYGRobHB0eHw"
    private let privateKey = P256.KeyAgreement.PrivateKey()

    private var record: PushSubscription {
        PushSubscription(session: "https://s.test|1", serverUrl: "https://s.test", userId: 1, privateKey: privateKey.rawRepresentation, auth: Data(repeating: 7, count: 16), sub: sub, relayKey: relayKey)
    }

    private func push(v: Int = PushMessage.version, id: String = "id-1", ts: Double? = nil, ttl: Double = 600, key: String? = nil, sub: String? = nil) -> [AnyHashable: Any] {
        let json = #"{"v":\#(v),"id":"\#(id)","ts":\#(ts ?? now.timeIntervalSince1970),"ttl":\#(ttl),"cat":"requests","title":"T","body":"B","url":"/r","badge":3,"user":1,"tag":"x","actions":[{"id":"approve","title":"Approve","kind":"call","token":"fka_1"}]}"#
        let message = encrypt(Data(json.utf8), to: privateKey.publicKey.x963Representation, auth: record.auth)
        return ["k": key ?? relayKey, "s": sub ?? self.sub, "p": message.base64URL]
    }

    func testShowsAKnownPush() {
        guard case .show(let message, let found) = PushPipeline.evaluate(push(), subscriptions: [record], seen: [], now: now) else { return XCTFail() }
        XCTAssertEqual(message.title, "T")
        XCTAssertEqual(message.badge, 3)
        XCTAssertEqual(message.actions?.first?.token, "fka_1")
        XCTAssertEqual(found.session, "https://s.test|1")
    }

    func testAHigherPlaintextVersionFallsBack() {
        XCTAssertEqual(PushPipeline.evaluate(push(v: PushMessage.version + 1), subscriptions: [record], seen: [], now: now), .fallback)
    }

    func testAKeyThatIsNotTheStoredOneFallsBack() {
        XCTAssertEqual(PushPipeline.evaluate(push(key: "other"), subscriptions: [record], seen: [], now: now), .fallback)
    }

    func testAnUnknownSubscriptionIsReported() {
        XCTAssertEqual(PushPipeline.evaluate(push(sub: "AAAAAAAAAAAAAAAAAAAAAA"), subscriptions: [record], seen: [], now: now), .unknown(sub: "AAAAAAAAAAAAAAAAAAAAAA"))
    }

    func testAnUnreadableKeychainDeletesNothing() {
        XCTAssertEqual(PushPipeline.evaluate(push(), subscriptions: nil, seen: [], now: now), .fallback)
    }

    func testAKnownSubscriptionThatDoesNotDecryptFallsBack() {
        var other = record
        other.auth = Data(repeating: 9, count: 16)
        XCTAssertEqual(PushPipeline.evaluate(push(), subscriptions: [other], seen: [], now: now), .fallback)
    }

    func testAnExpiredPushFallsBack() {
        XCTAssertEqual(PushPipeline.evaluate(push(ts: now.timeIntervalSince1970 - 601), subscriptions: [record], seen: [], now: now), .fallback)
        guard case .show = PushPipeline.evaluate(push(ts: now.timeIntervalSince1970 - 600), subscriptions: [record], seen: [], now: now) else { return XCTFail() }
    }

    func testAReplayedIdFallsBack() {
        XCTAssertEqual(PushPipeline.evaluate(push(), subscriptions: [record], seen: ["id-1"], now: now), .fallback)
    }

    func testAMissingFieldFallsBack() {
        XCTAssertEqual(PushPipeline.evaluate(["k": relayKey], subscriptions: [record], seen: [], now: now), .fallback)
    }
}

final class PushRelayTests: XCTestCase {
    // `relay/vectors.json`, audience relay.example.test: a valid ticket, then a sub of 15 bytes and a key of 31.
    private func ticket(_ json: String) -> String { Data(json.utf8).base64URL + ".sig" }
    private let key = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
    private let sub = "EBESExQVFhcYGRobHB0eHw"

    func testAcceptsATicketForTheOfficialRelay() {
        let t = PushRelay.ticket(ticket(#"{"key":"\#(key)","sub":"\#(sub)","aud":"\#(PushRelay.officialHost)","exp":1800000300}"#))
        XCTAssertEqual(t, PushRelay.Ticket(key: key, sub: sub, audience: PushRelay.officialHost))
        XCTAssertEqual(PushRelay.baseURL(audience: PushRelay.officialHost)?.absoluteString, "https://\(PushRelay.officialHost)")
    }

    func testRefusesAnotherAudience() {
        XCTAssertNil(PushRelay.ticket(ticket(#"{"key":"\#(key)","sub":"\#(sub)","aud":"relay.example.test","exp":1800000300}"#)))
        XCTAssertNil(PushRelay.ticket(ticket(#"{"key":"\#(key)","sub":"\#(sub)","aud":"evil.test:443","exp":1800000300}"#)))
    }

    func testRefusesAMalformedKeyOrSub() {
        let short = Data(count: 15).base64URL
        XCTAssertNil(PushRelay.ticket(ticket(#"{"key":"\#(key)","sub":"\#(short)","aud":"\#(PushRelay.officialHost)","exp":1}"#)))
        XCTAssertNil(PushRelay.ticket(ticket(#"{"key":"\#(Data(count: 31).base64URL)","sub":"\#(sub)","aud":"\#(PushRelay.officialHost)","exp":1}"#)))
        XCTAssertNil(PushRelay.ticket("not a ticket"))
    }

    func testTheDebugBuildAddsLocalhost() {
        #if DEBUG
        XCTAssertEqual(PushRelay.baseURL(audience: "localhost:8080")?.absoluteString, "http://localhost:8080")
        #else
        XCTAssertNil(PushRelay.baseURL(audience: "localhost:8080"))
        #endif
    }
}

final class PushStoreTests: XCTestCase {
    override func setUp() {
        PushStore.service = "media.fliks.app.push.tests"
        PushStore.wipe()
    }

    override func tearDown() { PushStore.wipe() }

    func testSavesAndFindsASubscription() {
        var record = PushSubscription(session: "https://s.test|1", serverUrl: "https://s.test", userId: 1, privateKey: Data(count: 32), auth: Data(count: 16))
        PushStore.save(record)
        record.sub = "abc"
        PushStore.save(record)
        XCTAssertEqual(PushStore.subscriptions(), [record])
        XCTAssertEqual(PushStore.subscription(session: "https://s.test|1"), record)
        PushStore.remove(session: "https://s.test|1")
        XCTAssertEqual(PushStore.subscriptions(), [])
    }

    func testKeepsTheTokenOutOfTheSubscriptions() {
        PushStore.token = "ab12"
        XCTAssertEqual(PushStore.token, "ab12")
        XCTAssertEqual(PushStore.subscriptions(), [])
        PushStore.wipe()
        XCTAssertNil(PushStore.token)
    }

    func testMarksAnIdOnlyOnce() {
        XCTAssertTrue(PushStore.markSeen("a"))
        XCTAssertFalse(PushStore.markSeen("a"))
        XCTAssertEqual(PushStore.seenIDs(), ["a"])
    }

    func testKeepsTheLast200Ids() {
        for i in 0..<250 { PushStore.markSeen("id-\(i)") }
        let ids = Set(PushStore.seenIDs())
        XCTAssertEqual(ids.count, PushStore.replayLimit)
        XCTAssertTrue(ids.contains("id-249"))
        XCTAssertFalse(ids.contains("id-0"))
        XCTAssertFalse(ids.contains("id-49"))
    }
}

final class NotificationServiceTests: XCTestCase {
    private let privateKey = P256.KeyAgreement.PrivateKey()
    private let relayKey = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
    private let sub = "EBESExQVFhcYGRobHB0eHw"
    private let auth = Data(repeating: 7, count: 16)

    override func setUp() {
        PushStore.service = "media.fliks.app.push.tests"
        PushStore.wipe()
        PushStore.save(PushSubscription(session: "https://s.test|1", serverUrl: "https://s.test", userId: 1, privateKey: privateKey.rawRepresentation, auth: auth, sub: sub, relayKey: relayKey))
    }

    override func tearDown() { PushStore.wipe() }

    private func push(id: String) -> [AnyHashable: Any] {
        let json = #"{"v":1,"id":"\#(id)","ts":\#(Date().timeIntervalSince1970),"ttl":600,"cat":"requests","title":"T","body":"B","url":"/r/5","badge":3,"user":1,"tag":"x","actions":[{"id":"approve","title":"Approve","kind":"call","token":"fka_1"},{"id":"decline","title":"Decline","kind":"call","token":"fka_2"}]}"#
        return ["k": relayKey, "s": sub, "p": encrypt(Data(json.utf8), to: privateKey.publicKey.x963Representation, auth: auth).base64URL]
    }

    private func deliver(_ userInfo: [AnyHashable: Any]) async -> UNNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "relay fallback text"
        content.userInfo = userInfo
        let service = NotificationService()
        return await withCheckedContinuation { done in
            service.didReceive(UNNotificationRequest(identifier: "t", content: content, trigger: nil)) { done.resume(returning: $0) }
        }
    }

    func testDecryptsIntoTheContent() async {
        let out = await deliver(push(id: "id-1"))
        XCTAssertEqual(out.title, "T")
        XCTAssertEqual(out.body, "B")
        XCTAssertEqual(out.badge, 3)
        XCTAssertEqual(out.categoryIdentifier, "fliks.approve.decline")
        XCTAssertTrue(PushCategories.sets.map(PushCategories.identifier).contains(out.categoryIdentifier))
        let info = out.userInfo["fliks"] as? [String: Any]
        XCTAssertEqual(info?["serverUrl"] as? String, "https://s.test")
        XCTAssertEqual(info?["url"] as? String, "/r/5")
        XCTAssertEqual((info?["actions"] as? [[String: String]])?.first?["token"], "fka_1")
    }

    func testAReplayKeepsTheFallbackText() async {
        _ = await deliver(push(id: "id-2"))
        let again = await deliver(push(id: "id-2"))
        XCTAssertEqual(again.title, "relay fallback text")
    }

    func testAnUndecryptablePushKeepsTheFallbackText() async {
        let out = await deliver(["k": relayKey, "s": sub, "p": Data(count: 120).base64URL])
        XCTAssertEqual(out.title, "relay fallback text")
        XCTAssertNil(out.badge)
    }
}

final class PushCategoriesTests: XCTestCase {
    // Order of the server catalogue (`push/catalogue.rs`): approve, decline | accept, decline | join.
    func testIdentifiersFollowTheCatalogueOrder() {
        XCTAssertEqual(PushCategories.sets.map(PushCategories.identifier), ["fliks.approve.decline", "fliks.accept.decline", "fliks.join"])
    }
}

final class StoredSessionsTests: XCTestCase {
    private let legacyKey = "CapacitorStorage.fliks_sessions"
    private var saved: [String: Any?] = [:]

    override func setUp() {
        StoredSessions.service = "media.fliks.app.sessions.tests"
        PushStore.service = "media.fliks.app.push.tests"
        for key in [legacyKey, StoredSessions.installedKey] { saved[key] = UserDefaults.standard.object(forKey: key) }
        UserDefaults.standard.removeObject(forKey: legacyKey)
        UserDefaults.standard.set(true, forKey: StoredSessions.installedKey)
        UserDefaults.standard.set("https://s.test::1", forKey: "CapacitorStorage.fliks_active_session")
        StoredSessions.clear()
        PushStore.wipe()
        try? StoredSessions.store(sessions(access: "old", refresh: "r1"))
        StubRefresh.reset()
        URLProtocol.registerClass(StubRefresh.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(StubRefresh.self)
        StoredSessions.clear()
        PushStore.wipe()
        for (key, value) in saved { UserDefaults.standard.set(value, forKey: key) }
        UserDefaults.standard.removeObject(forKey: "CapacitorStorage.fliks_active_session")
    }

    private func sessions(access: String, refresh: String) -> String {
        #"[{"serverUrl":"https://s.test","accessToken":"\#(access)","refreshToken":"\#(refresh)","tokenVersion":2,"user":{"id":1}}]"#
    }

    private func stored() throws -> [[String: Any]] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(StoredSessions.blob()).utf8)) as? [[String: Any]])
    }

    func testNormalisesTheServerOnce() {
        XCTAssertEqual(StoredSessions.key("HTTPS://S.Test/", 1), "https://s.test::1")
        XCTAssertTrue(StoredSessions.isActive("https://S.test/", 1))
        XCTAssertFalse(StoredSessions.isActive("https://s.test", 2))
        XCTAssertEqual(StoredSessions.find("https://s.test/::1")?.token, "old")
    }

    func testRotatesTheStoredPairAndBumpsTheVersion() async throws {
        StubRefresh.status = 200
        let renewed = await StoredSessions.refresh("https://s.test::1", rejected: "old")
        XCTAssertEqual(renewed, true)
        XCTAssertEqual(StubRefresh.bodies, [#"{"refreshToken":"r1"}"#])
        let row = try XCTUnwrap(stored().first)
        XCTAssertEqual(row["accessToken"] as? String, "new")
        XCTAssertEqual(row["refreshToken"] as? String, "r2")
        XCTAssertEqual(row["refreshExpiresAt"] as? Int, 2_000_000)
        XCTAssertEqual(row["tokenVersion"] as? Int, 3)
        XCTAssertNil(UserDefaults.standard.string(forKey: legacyKey))
    }

    func testAdoptsAPairAnotherContextAlreadyStored() async {
        let renewed = await StoredSessions.refresh("https://s.test::1", rejected: "stale")
        XCTAssertEqual(renewed, true)
        XCTAssertTrue(StubRefresh.bodies.isEmpty)
    }

    func testReportsARefusedAndAnUnreachableRefresh() async {
        StubRefresh.status = 401
        let refused = await StoredSessions.refresh("https://s.test::1", rejected: "old")
        XCTAssertEqual(refused, false)
        StubRefresh.status = 503
        let unreachable = await StoredSessions.refresh("https://s.test::1", rejected: "old")
        XCTAssertNil(unreachable)
        XCTAssertEqual(StoredSessions.find("https://s.test::1")?.token, "old")
    }

    func testAFailedWriteAfterTheRotationIsUnreachableNotRefused() async {
        StubRefresh.status = 200
        let write = StoredSessions.writeItem
        defer { StoredSessions.writeItem = write }
        StoredSessions.writeItem = { _ in errSecInteractionNotAllowed }
        let result = await StoredSessions.refresh("https://s.test::1", rejected: "old")
        XCTAssertNil(result)
        XCTAssertEqual(StoredSessions.find("https://s.test::1")?.token, "old")
    }

    func testAFailedReadIsAnErrorNeverAnEmptyStore() throws {
        XCTAssertEqual(try StoredSessions.blob(), sessions(access: "old", refresh: "r1"))
        StoredSessions.clear()
        XCTAssertNil(try StoredSessions.blob())
        let read = StoredSessions.readItem
        defer { StoredSessions.readItem = read }
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecDecode] {
            StoredSessions.readItem = { (status, nil) }
            XCTAssertThrowsError(try StoredSessions.blob())
        }
        XCTAssertNil(StoredSessions.find("https://s.test::1"))
    }

    func testAFailedStoreThrows() {
        let write = StoredSessions.writeItem
        defer { StoredSessions.writeItem = write }
        StoredSessions.writeItem = { _ in errSecInteractionNotAllowed }
        XCTAssertThrowsError(try StoredSessions.store("[]"))
    }

    @MainActor
    func testAReadBeforeTheFirstUnlockWaitsThenRetries() async throws {
        let read = StoredSessions.readItem
        defer { StoredSessions.readItem = read }
        nonisolated(unsafe) var unlocked = false
        StoredSessions.readItem = { unlocked ? read() : (errSecInteractionNotAllowed, nil) }
        let pending = Task { @MainActor in try await StoredSessions.blobWhenUnlocked() }
        try await Task.sleep(nanoseconds: 200_000_000)
        unlocked = true
        NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        let value = try await pending.value
        XCTAssertEqual(value, sessions(access: "old", refresh: "r1"))
    }

    func testMigratesTheLegacyBlobThenDeletesTheKey() throws {
        StoredSessions.clear()
        UserDefaults.standard.set(sessions(access: "legacy", refresh: "r0"), forKey: legacyKey)
        StoredSessions.migrate()
        XCTAssertEqual(try stored().first?["accessToken"] as? String, "legacy")
        XCTAssertNil(UserDefaults.standard.string(forKey: legacyKey))
    }

    func testAnExistingItemWinsAndTheKeyIsJustDeleted() throws {
        UserDefaults.standard.set(sessions(access: "legacy", refresh: "r0"), forKey: legacyKey)
        StoredSessions.migrate()
        XCTAssertEqual(try stored().first?["accessToken"] as? String, "old")
        XCTAssertNil(UserDefaults.standard.string(forKey: legacyKey))
    }

    func testAFailedWriteLeavesTheLegacyBlobForTheNextLaunch() {
        StoredSessions.clear()
        UserDefaults.standard.set(sessions(access: "legacy", refresh: "r0"), forKey: legacyKey)
        let write = StoredSessions.writeItem
        StoredSessions.writeItem = { _ in errSecInteractionNotAllowed }
        StoredSessions.migrate()
        StoredSessions.writeItem = write
        XCTAssertNotNil(UserDefaults.standard.string(forKey: legacyKey))
        StoredSessions.migrate()
        XCTAssertNil(UserDefaults.standard.string(forKey: legacyKey))
        XCTAssertNotNil(try? StoredSessions.blob())
    }

    func testAnUnreadableItemLeavesTheLegacyBlob() {
        UserDefaults.standard.set(sessions(access: "legacy", refresh: "r0"), forKey: legacyKey)
        let read = StoredSessions.readItem
        defer { StoredSessions.readItem = read }
        StoredSessions.readItem = { (errSecInteractionNotAllowed, nil) }
        StoredSessions.migrate()
        XCTAssertNotNil(UserDefaults.standard.string(forKey: legacyKey))
    }

    func testAnUpgradeFromBeforeThePushFlagKeepsTheSessions() throws {
        UserDefaults.standard.removeObject(forKey: StoredSessions.installedKey)
        StoredSessions.clear()
        UserDefaults.standard.set(sessions(access: "legacy", refresh: "r0"), forKey: legacyKey)
        StoredSessions.launch()
        XCTAssertEqual(try stored().first?["accessToken"] as? String, "legacy")
        XCTAssertTrue(UserDefaults.standard.bool(forKey: StoredSessions.installedKey))
    }

    func testAReinstallStartsSignedOut() throws {
        UserDefaults.standard.removeObject(forKey: StoredSessions.installedKey)
        StoredSessions.launch()
        XCTAssertNil(try StoredSessions.blob())
        XCTAssertTrue(UserDefaults.standard.bool(forKey: StoredSessions.installedKey))
    }

    func testNoResetBeforeTheFirstUnlock() throws {
        UserDefaults.standard.removeObject(forKey: StoredSessions.installedKey)
        let read = StoredSessions.readItem
        StoredSessions.readItem = { (errSecInteractionNotAllowed, nil) }
        StoredSessions.launch()
        StoredSessions.readItem = read
        XCTAssertFalse(UserDefaults.standard.bool(forKey: StoredSessions.installedKey))
        XCTAssertNotNil(try StoredSessions.blob())
    }
}

private final class StubRefresh: URLProtocol {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var bodies: [String] = []
    static func reset() { status = 200; bodies = [] }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == "/api/auth/refresh" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let body = request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            return data
        } ?? Data()
        Self.bodies.append(String(decoding: body, as: UTF8.self))
        let reply = Self.status == 200 ? #"{"accessToken":"new","refreshToken":"r2","refreshTokenExpiresAt":2000}"# : "{}"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
