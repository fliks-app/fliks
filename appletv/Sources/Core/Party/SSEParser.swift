import Foundation

struct SSEMessage: Equatable {
    var event: String?
    var data: String
}

/// Incremental `text/event-stream` parser, fed one byte at a time because `URLSession.AsyncBytes.lines`
/// drops the blank lines that end a message.
struct SSEParser {
    private var line = Data()
    private var event: String?
    private var data: [String] = []

    /// A message once its terminating blank line arrives; comments, `id:` and `retry:` are ignored.
    mutating func feed(_ byte: UInt8) -> SSEMessage? {
        guard byte == 0x0A else {
            line.append(byte)
            return nil
        }
        defer { line.removeAll(keepingCapacity: true) }
        if line.last == 0x0D { line.removeLast() }
        guard !line.isEmpty else {
            defer { event = nil; data = [] }
            return data.isEmpty ? nil : SSEMessage(event: event, data: data.joined(separator: "\n"))
        }
        guard let text = String(data: line, encoding: .utf8), !text.hasPrefix(":") else { return nil }
        let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        var value = parts.count > 1 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch parts[0] {
        case "event": event = value
        case "data": data.append(value)
        default: break
        }
        return nil
    }

    mutating func feed(_ chunk: Data) -> [SSEMessage] {
        chunk.compactMap { feed($0) }
    }
}
