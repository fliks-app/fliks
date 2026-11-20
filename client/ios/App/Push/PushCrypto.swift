import CryptoKit
import Foundation

extension Data {
    init?(base64URL text: String) {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        self.init(base64Encoded: s)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// RFC 8291 `aes128gcm` decryption of a single-record message, CryptoKit only (the extension has 24 MB).
enum PushCrypto {
    static func decrypt(_ message: Data, privateKey: P256.KeyAgreement.PrivateKey, auth: Data) -> Data? {
        let m = Data(message)
        guard m.count > 21, m[20] == 65, m.count >= 21 + 65 + 17 else { return nil }
        let salt = m.subdata(in: 0..<16)
        let recordSize = m.subdata(in: 16..<20).reduce(0) { $0 << 8 | Int($1) }
        let senderKey = m.subdata(in: 21..<86)
        let record = m.subdata(in: 86..<m.count)
        guard record.count <= recordSize,
              let sender = try? P256.KeyAgreement.PublicKey(x963Representation: senderKey),
              let secret = try? privateKey.sharedSecretFromKeyAgreement(with: sender) else { return nil }
        var info = Data("WebPush: info".utf8) + [0]
        info += privateKey.publicKey.x963Representation + senderKey
        let ikm = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: auth, sharedInfo: info, outputByteCount: 32)
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: aes128gcm".utf8) + [0], outputByteCount: 16)
        let nonce = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: nonce".utf8) + [0], outputByteCount: 12)
        guard let nonceValue = try? AES.GCM.Nonce(data: nonce.withUnsafeBytes { Data($0) }),
              let box = try? AES.GCM.SealedBox(nonce: nonceValue, ciphertext: record.dropLast(16), tag: record.suffix(16)),
              let padded = try? AES.GCM.open(box, using: key),
              let end = padded.lastIndex(where: { $0 != 0 }), padded[end] == 2 else { return nil }
        return padded.prefix(upTo: end)
    }
}
