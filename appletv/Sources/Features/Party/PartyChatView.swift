import SwiftUI

/// Chat history, a text field (on-screen keyboard, dictation or the iPhone keyboard) and the quick replies.
struct PartyChatView: View {
    @Environment(PartyService.self) private var service
    @State private var draft = ""

    private static let phrases = ["party.tv_phrase_pause", "party.tv_phrase_5min", "party.tv_phrase_wait"]

    var body: some View {
        PartySheetPage(title: tr("party.tv_chat")) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if service.messages.isEmpty { Text(tr("party.chat_empty")).foregroundStyle(.secondary) }
                        ForEach(service.messages) { message in
                            Text(message.line)
                                .font(.callout)
                                .foregroundStyle(message.system == nil ? .primary : .secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                // Focusable so the remote can scroll back through the history.
                                .focusable()
                                .id(message.id)
                        }
                    }
                    .padding(30)
                }
                .onChange(of: service.messages.last?.id) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
                .onAppear {
                    if let id = service.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            .frame(maxWidth: 1200)
        } bar: {
            VStack(spacing: 20) {
                if service.chatEnabled {
                    HStack(spacing: 24) {
                        TextField(tr("party.chat_placeholder"), text: $draft)
                            .onSubmit(send)
                        Button(tr("party.chat_send"), action: send)
                            .buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: 1200)
                    HStack(spacing: 20) {
                        ForEach(Self.phrases, id: \.self) { key in
                            Button(tr(key)) { Task { await service.sendMessage(tr(key)) } }
                                .buttonStyle(.bordered)
                        }
                    }
                } else {
                    Text(tr("party.chat_off")).foregroundStyle(.secondary)
                }
                Button(tr("party.tv_close")) { service.sheet = nil }
                    .buttonStyle(.bordered)
            }
            .focusSection()
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task { await service.sendMessage(text) }
    }
}

/// Reactions rising over the video: a rise, a fade and a slight drift, never focusable.
struct PartyReactionsOverlay: View {
    @Environment(PartyService.self) private var service

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                ForEach(service.reactions) { reaction in
                    RisingEmoji(reaction: reaction)
                        .offset(x: geo.size.width * reaction.left)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        }
        .allowsHitTesting(false)
    }
}

private struct RisingEmoji: View {
    let reaction: FloatingReaction
    @State private var risen = false

    var body: some View {
        VStack(spacing: 4) {
            Text(reaction.emoji).font(.system(size: 72))
            Text(reaction.username).font(.caption2).padding(.horizontal, 8)
                .background(.black.opacity(0.5), in: Capsule())
        }
        .padding(.bottom, 120)
        .offset(x: risen ? (reaction.left < 0.5 ? 30 : -30) : 0, y: risen ? -420 : 0)
        .opacity(risen ? 0 : 1)
        .onAppear { withAnimation(.easeOut(duration: PartyReactions.riseSeconds)) { risen = true } }
    }
}
