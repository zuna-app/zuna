import SwiftUI
import ZunaModels

/// A call ringing this person, over the app, where the system doesn't ring it: on China's App
/// Store, which leaves CallKit out, and in test builds. Elsewhere it's CallKit's screen that rings.
/// The desktop's IncomingCalls.
struct IncomingCallOverlay: View {
    @Environment(VoiceModel.self) private var voice

    var body: some View {
        if voice.systemRings == false, let call = voice.incoming.first {
            IncomingCallCard(call: call)
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .transition(.move(edge: .top).combined(with: .opacity))
                .id(call.id)
        }
    }
}

private struct IncomingCallCard: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    let call: IncomingCall
    @State private var pulsing = false

    var body: some View {
        let server = model.servers[call.serverId]
        let conversation = server?.conversation(call.key)
        let caller = server?.users[call.startedBy]?.displayName ?? "Someone"
        let what = call.kind == .dm ? "Calling you" : "\(caller) started a call"
        HStack(spacing: 10) {
            AvatarView(name: call.title, seed: conversation?.peerId ?? call.groupId, source: conversation?.avatar.map { .avatar($0, serverId: call.serverId) } ?? .none, size: 46)
                .scaleEffect(pulsing ? 0.94 : 1)
                .onAppear {
                    withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { pulsing = true }
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(call.title)
                    .font(.headline)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(1)
                Text(model.order.count > 1 ? "\(what) · \(server?.entry.name ?? "")" : what)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            button("phone.down.fill", background: Theme.red, label: "Decline", id: A11y.Voice.decline) {
                voice.decline(call)
            }
            button("video.fill", background: Theme.bg5, label: "Answer with video", id: A11y.Voice.answerWithVideo) {
                Task { await voice.answer(call, camera: true) }
            }
            button("phone.fill", background: Theme.green, label: "Answer", id: A11y.Voice.answer) {
                Task { await voice.answer(call, camera: false) }
            }
        }
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Voice.incoming)
    }

    private func button(_ symbol: String, background: Color, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(background, in: .circle)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}
