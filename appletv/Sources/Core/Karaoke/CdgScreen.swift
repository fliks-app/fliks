import Foundation

/// A CD+G screen: 300x216 pixels of 16-colour indices drawn by 24-byte packets (300 per second of audio).
/// Mirrors `client/src/app/core/services/karaoke/cdg.ts`.
struct CdgScreen {
    static let width = 300, height = 216, packetsPerSecond = 300
    private static let packet = 24, tileW = 6, tileH = 12

    private let data: [UInt8]
    private var pixels = [UInt8](repeating: 0, count: width * height)
    private var palette = [UInt32](repeating: 0, count: 16)
    private var cursor = 0

    init(_ data: Data) { self.data = [UInt8](data) }

    /// The packets up to `ms` of audio applied; going back replays from the start.
    mutating func seek(ms: Double) {
        let end = min(Int(max(0, ms) * Double(Self.packetsPerSecond) / 1000), data.count / Self.packet)
        if end < cursor {
            cursor = 0
            pixels = [UInt8](repeating: 0, count: pixels.count)
            palette = [UInt32](repeating: 0, count: 16)
        }
        while cursor < end {
            apply(at: cursor * Self.packet)
            cursor += 1
        }
    }

    /// RGBA bytes of the screen; the border preset is ignored.
    func rgba() -> [UInt8] {
        var out = [UInt8](repeating: 255, count: pixels.count * 4)
        for (i, p) in pixels.enumerated() {
            let c = palette[Int(p)]
            out[i * 4] = UInt8((c >> 16) & 255)
            out[i * 4 + 1] = UInt8((c >> 8) & 255)
            out[i * 4 + 2] = UInt8(c & 255)
        }
        return out
    }

    private mutating func apply(at: Int) {
        guard data[at] & 0x3f == 9 else { return }
        let p = at + 4
        switch data[at + 1] & 0x3f {
        case 1: pixels = [UInt8](repeating: data[p] & 0xf, count: pixels.count)
        case 6: tile(p, xor: false)
        case 38: tile(p, xor: true)
        case 20: scroll(p, copy: false)
        case 24: scroll(p, copy: true)
        case 30: colours(p, from: 0)
        case 31: colours(p, from: 8)
        default: break
        }
    }

    /// Eight colours as two bytes each: 4 bits per channel, scaled to 8.
    private mutating func colours(_ p: Int, from: Int) {
        for i in 0..<8 {
            let hi = UInt32(data[p + i * 2] & 0x3f), lo = UInt32(data[p + i * 2 + 1] & 0x3f)
            let r = (hi >> 2) & 0xf, g = ((hi & 3) << 2) | ((lo >> 4) & 3), b = lo & 0xf
            palette[from + i] = ((r * 17) << 16) | ((g * 17) << 8) | (b * 17)
        }
    }

    private mutating func tile(_ p: Int, xor: Bool) {
        let c0 = data[p] & 0xf, c1 = data[p + 1] & 0xf
        let y0 = Int(data[p + 2] & 0x1f) * Self.tileH, x0 = Int(data[p + 3] & 0x3f) * Self.tileW
        guard x0 + Self.tileW <= Self.width, y0 + Self.tileH <= Self.height else { return }
        for y in 0..<Self.tileH {
            let bits = data[p + 4 + y] & 0x3f
            for x in 0..<Self.tileW {
                let c = (bits >> UInt8(5 - x)) & 1 == 1 ? c1 : c0
                let i = (y0 + y) * Self.width + x0 + x
                pixels[i] = xor ? pixels[i] ^ c : c
            }
        }
    }

    /// Whole-cell scrolls (6 px across, 12 down); the fine offsets are not drawn.
    private mutating func scroll(_ p: Int, copy: Bool) {
        let fill = data[p] & 0xf
        let h = (data[p + 1] >> 4) & 3, v = (data[p + 2] >> 4) & 3
        let dx = h == 1 ? Self.tileW : h == 2 ? -Self.tileW : 0
        let dy = v == 1 ? Self.tileH : v == 2 ? -Self.tileH : 0
        guard dx != 0 || dy != 0 else { return }
        let src = pixels
        for y in 0..<Self.height {
            for x in 0..<Self.width {
                var sx = x - dx, sy = y - dy
                let inside = sx >= 0 && sx < Self.width && sy >= 0 && sy < Self.height
                sx = (sx + Self.width) % Self.width
                sy = (sy + Self.height) % Self.height
                pixels[y * Self.width + x] = copy || inside ? src[sy * Self.width + sx] : fill
            }
        }
    }
}
