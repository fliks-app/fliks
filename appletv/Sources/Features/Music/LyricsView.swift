import SwiftUI

/// Synced lyrics: the sung line is centred and bright, words fill as they are sung.
struct LyricsView: View {
    let lyrics: StructuredLyrics
    @State private var player = MusicPlayer.shared

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { ctx in
            let ms = player.livePosition(at: ctx.date) * 1000
            let active = lyrics.activeLine(atMs: ms)
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 26) {
                        ForEach(Array(lyrics.line.enumerated()), id: \.offset) { i, l in
                            lineView(i, l, ms: ms, active: active)
                                .id(i)
                        }
                    }
                    .padding(.vertical, 300)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: active) { _, i in
                    guard let i else { return }
                    withAnimation(.easeInOut(duration: 0.4)) { proxy.scrollTo(i, anchor: .center) }
                }
            }
        }
    }

    @ViewBuilder private func lineView(_ i: Int, _ l: StructuredLyrics.Line, ms: Double, active: Int?) -> some View {
        let isActive = i == active || !lyrics.synced
        let size: CGFloat = 44
        if isActive, let cues = lyrics.words[i], !cues.isEmpty {
            // Words already sung are bright; the one in progress and the rest stay dim.
            let t = ms + Double(lyrics.offset)
            cues.reduce(Text("")) { acc, c in
                acc + Text(c.value).foregroundColor(Double(c.start) <= t ? .white : .white.opacity(0.4))
            }
            .font(.system(size: size, weight: .bold))
        } else {
            Text(l.value.isEmpty ? " " : l.value)
                .font(.system(size: size, weight: .bold))
                .foregroundStyle(isActive ? Color.white : Color.white.opacity(0.35))
        }
    }
}
