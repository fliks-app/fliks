import SwiftUI

/// Full-screen karaoke on the playing track: word-filled lyrics with a side per duet agent, the melody
/// lane, the sound mix (Original, Guide, Instrumental and a vocal level) and the singers' scores.
struct KaraokeView: View {
    let itemId: Int
    let lyrics: StructuredLyrics?
    var onClose: () -> Void

    @State private var session = KaraokeSession()
    @State private var player = MusicPlayer.shared
    @State private var party = PartyService.shared
    @FocusState private var focus: Control?

    private enum Control: Hashable { case mode(KaraokeMode), level }

    var body: some View {
        VStack(spacing: 36) {
            header
            stage
            if session.phase == .ready { controls }
        }
        .padding(.horizontal, 90)
        .padding(.vertical, 50)
        .task(id: itemId) { await session.open(itemId: itemId, lyrics: lyrics) }
        .onChange(of: session.phase) { _, p in if p == .ready { focus = .mode(session.mode) } }
        .onChange(of: player.current?.itemId) { _, id in if id != itemId { onClose() } }
        .onDisappear { session.close() }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                Text(player.current?.title ?? "").font(.title2.bold()).lineLimit(1)
                Text(player.current?.artists ?? "").font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if !session.results.isEmpty { scoreboard }
        }
    }

    @ViewBuilder private var stage: some View {
        switch session.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable:
            note(tr("karaoke.unavailable"))
        case .failed:
            note(tr("karaoke.failed"))
        case .preparing(let stage, let progress):
            VStack(spacing: 18) {
                Text(stage.map { tr("karaoke.stage_\($0)") } ?? tr("karaoke.queued")).font(.title3)
                if let progress { ProgressView(value: progress, total: 100).frame(maxWidth: 600) } else { ProgressView() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            if let lyrics {
                KaraokeLyricsLines(lyrics: lyrics)
                PitchLane(lyrics: lyrics, live: session.live)
                    .frame(height: 170)
            } else {
                note(tr("lyrics.none"))
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.title3).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var controls: some View {
        HStack(spacing: 28) {
            ForEach(KaraokeMode.allCases, id: \.self) { m in
                Button { session.setMode(m) } label: {
                    Text(tr(m.labelKey)).foregroundStyle(session.mode == m ? Color.accentColor : .primary)
                }
                .focused($focus, equals: .mode(m))
            }
            levelBar
        }
        .buttonStyle(.bordered)
        .focusSection()
    }

    /// Left and right move the vocal level in steps of 10 %.
    private var levelBar: some View {
        HStack(spacing: 14) {
            Text(tr("karaoke.vocal_level")).font(.callout)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.25))
                    Capsule().fill(.white).frame(width: geo.size.width * CGFloat(session.vocalLevel))
                }
            }
            .frame(width: 260, height: focus == .level ? 16 : 10)
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(focus == .level ? 0.12 : 0)))
        .focusable(session.mode != .original)
        .focused($focus, equals: .level)
        .onMoveCommand { d in
            switch d {
            case .left: session.setVocalLevel(session.vocalLevel - 0.1)
            case .right: session.setVocalLevel(session.vocalLevel + 0.1)
            default: break
            }
        }
        .opacity(session.mode == .original ? 0.4 : 1)
        .animation(.easeOut(duration: 0.12), value: focus)
    }

    private var scoreboard: some View {
        HStack(spacing: 36) {
            ForEach(session.results, id: \.userId) { r in
                VStack(spacing: 2) {
                    Text(party.members.first { $0.userId == r.userId }?.username ?? "").font(.callout).foregroundStyle(.secondary)
                    Text("\(r.score.score)").font(.title2.monospacedDigit().bold())
                }
            }
        }
    }
}

/// The sung line and the ones after it. A duet puts each agent on its own side.
private struct KaraokeLyricsLines: View {
    let lyrics: StructuredLyrics
    @State private var player = MusicPlayer.shared

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 15)) { ctx in
            let ms = player.livePosition(at: ctx.date) * 1000 + Double(lyrics.offset)
            let active = lyrics.activeLine(atMs: ms - Double(lyrics.offset)) ?? -1
            VStack(spacing: 30) {
                ForEach(Array((max(active, 0)..<min(active + 3, lyrics.line.count)).enumerated()), id: \.element) { n, i in
                    line(i, ms: ms, current: i == active)
                        .opacity(n == 0 ? 1 : n == 1 ? 0.6 : 0.35)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func alignment(_ i: Int) -> Alignment {
        let agent = lyrics.cueLine?.first { $0.index == i }?.agentId
        guard let side = agent.flatMap({ lyrics.sides.firstIndex(of: $0) }), lyrics.sides.count >= 2 else { return .center }
        return side == 0 ? .leading : .trailing
    }

    @ViewBuilder private func line(_ i: Int, ms: Double, current: Bool) -> some View {
        let font = Font.system(size: current ? 64 : 48, weight: .bold)
        Group {
            if current, let cues = lyrics.words[i], !cues.isEmpty {
                cues.reduce(Text("")) { acc, c in acc + Text(c.value).foregroundStyle(fill(c, ms: ms)) }
            } else {
                Text(lyrics.line[i].value.isEmpty ? " " : lyrics.line[i].value).foregroundStyle(.white)
            }
        }
        .font(font)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, alignment: alignment(i))
    }

    /// A word is bright once sung; the one in progress fills from its left edge.
    private func fill(_ c: StructuredLyrics.Cue, ms: Double) -> LinearGradient {
        let f = min(1, max(0, (ms - Double(c.start)) / Double(max(c.end - c.start, 1))))
        return LinearGradient(stops: [.init(color: .white, location: f), .init(color: .white.opacity(0.4), location: f)],
                              startPoint: .leading, endPoint: .trailing)
    }
}

/// The reference melody as bars (octave folded, golden notes tinted) with the sung pitch at "now".
private struct PitchLane: View {
    let lyrics: StructuredLyrics
    let live: [Int: Double]
    @State private var player = MusicPlayer.shared

    private static let before = 2000.0, after = 6000.0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20)) { ctx in
            let now = player.livePosition(at: ctx.date) * 1000 + Double(lyrics.offset)
            Canvas { g, size in
                let span = Self.before + Self.after
                let from = now - Self.before
                let x = { (t: Double) in (t - from) / span * size.width }
                let y = { (fold: Double) in size.height - (fold / 12) * size.height }
                g.fill(Path(CGRect(x: x(now) - 1, y: 0, width: 2, height: size.height)), with: .color(.white.opacity(0.5)))
                for n in lyrics.laneNotes(from: from, to: from + span) {
                    let rect = CGRect(x: x(n.start), y: y(n.fold) - 9, width: max(8, x(n.end) - x(n.start)), height: 18)
                    let color: Color = n.golden ? .yellow : (lyrics.sides.firstIndex(of: n.agentId ?? "") == 1 ? .pink : .teal)
                    g.fill(Path(roundedRect: rect, cornerRadius: 9), with: .color(color.opacity(n.start <= now && n.end >= now ? 1 : 0.6)))
                }
                for fold in live.values {
                    g.fill(Path(ellipseIn: CGRect(x: x(now) - 12, y: y(fold) - 12, width: 24, height: 24)), with: .color(.white))
                }
            }
        }
    }
}
