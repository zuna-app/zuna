import SwiftUI
import ZunaModels

/// The share sheet, laid out as the app's chat list: the server's picture at
/// the top left and its name in the middle, both of which choose the server,
/// its chats on black, any number of which can be picked, and below them
/// what's being sent, a comment and Send, as the message box has them.
struct ShareView: View {
    @Environment(ShareModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.bg0)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(Theme.bg0, for: .navigationBar)
                .toolbar { toolbar }
        }
        .tint(model.settings.accent.color)
        .preferredColorScheme(.dark)
        .environment(model.images)
        .sheet(isPresented: $model.choosingServer) {
            NavigationStack { ServerChoice() }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Theme.bg1)
                .environment(model)
                .environment(model.images)
        }
        .alert("Not sent", isPresented: Binding(get: { model.failure != nil }, set: { if !$0 { model.failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.failure ?? "")
        }
        .accessibilityIdentifier(A11y.Share.sheet)
        #if DEBUG
        .accessibilityValue(model.route)
        #endif
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if let server = model.server {
            // With one server there's nothing to choose, so they're only what they show.
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    model.choosingServer = true
                } label: {
                    AvatarView(name: server.name, seed: server.url, source: .serverAt(url: server.url, hasIcon: server.hasIcon), size: 36, rounded: true)
                }
                .buttonStyle(.plain)
                .allowsHitTesting(manyServers)
                .accessibilityLabel("Servers, \(server.name)")
                .accessibilityIdentifier(A11y.Share.servers)
            }
            .withoutSharedBackground()
            ToolbarItem(placement: .principal) {
                Button {
                    model.choosingServer = true
                } label: {
                    HStack(spacing: 4) {
                        Text(server.name)
                            .font(.headline)
                            .foregroundStyle(Theme.text1)
                            .lineLimit(1)
                        if manyServers {
                            Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(Theme.text3)
                        }
                    }
                }
                .buttonStyle(.plain)
                .allowsHitTesting(manyServers)
            }
        } else {
            ToolbarItem(placement: .principal) {
                Text("Zuna").font(.headline).foregroundStyle(Theme.text1)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Cancel") { model.cancel() }
                .disabled(model.phase == .sending || model.phase == .sent)
        }
    }

    private var manyServers: Bool {
        model.servers.count(where: { !$0.targets.isEmpty }) > 1
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .starting:
            ProgressView().tint(Theme.text2)
        case let .unavailable(reason):
            notice(reason)
        case .appLocked:
            VStack(spacing: 18) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Theme.text2)
                Button {
                    Task { await model.unlock() }
                } label: {
                    Label("Unlock with \(AppLock.methodName)", systemImage: "lock.open.fill")
                        .padding(.horizontal, 18)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .foregroundStyle(model.settings.accent.onAccent)
            }
        case .picking, .sending, .sent:
            picker
        }
    }

    private func notice(_ text: String) -> some View {
        VStack(spacing: 16) {
            Text(text)
                .font(.body)
                .foregroundStyle(Theme.text2)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier(A11y.Share.notice)
            Button("Close") { model.cancel() }
                .buttonStyle(.bordered)
                .foregroundStyle(Theme.text1)
        }
        .padding(32)
    }

    // MARK: Chats

    private var picker: some View {
        @Bindable var model = model
        let targets = model.targets
        let chats = targets.filter { $0.kind != .textChannel && $0.kind != .voiceChannel }
        let channels = targets.filter { $0.kind == .textChannel || $0.kind == .voiceChannel }
        return PullSearchList(query: $model.query, prompt: "Search", resetKey: model.serverId) {
            Section {
                ForEach(chats) { row($0) }
            }
            .listSectionSeparator(.hidden, edges: .top)
            if !channels.isEmpty {
                Section {
                    ForEach(channels) { row($0) }
                } header: {
                    Text("Channels")
                        .font(.footnote.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                }
            }
            if targets.isEmpty {
                Text(model.query.isEmpty ? "No chats on this server yet." : "No chats match \u{201C}\(model.query)\u{201D}.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                    .listRowBackground(Theme.bg0)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { composer }
        .overlay {
            if model.phase == .sending || model.phase == .sent { sending }
        }
    }

    private func row(_ target: ShareTarget) -> some View {
        let selected = model.isSelected(target)
        return Button {
            model.toggle(target)
        } label: {
            HStack(spacing: 12) {
                icon(target)
                    .overlay(alignment: .bottomTrailing) {
                        if selected {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(model.settings.accent.onAccent)
                                .frame(width: 22, height: 22)
                                .background(model.settings.accent.color, in: .circle)
                                .overlay(Circle().stroke(Theme.bg0, lineWidth: 2))
                                .offset(x: 2, y: 2)
                        }
                    }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        if target.kind == .group {
                            Image(systemName: "person.2.fill")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                        Text(target.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Theme.text1)
                            .lineLimit(1)
                    }
                    if !target.subtitle.isEmpty {
                        Text(target.subtitle)
                            .font(.subheadline)
                            .foregroundStyle(Theme.text2)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 8)
            .frame(minHeight: 68)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 14))
        .listRowBackground(selected ? Theme.bg2 : Theme.bg0)
        .listRowSeparatorTint(Theme.line)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 74 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(A11y.Share.row(target.title))
    }

    @ViewBuilder
    private func icon(_ target: ShareTarget) -> some View {
        switch target.kind {
        case .saved:
            symbol("bookmark.fill", size: 22)
        case .textChannel:
            symbol("number", size: 20)
        case .voiceChannel:
            symbol("speaker.wave.2.fill", size: 20)
        case .person, .group:
            AvatarView(name: target.title, seed: target.seed, source: target.avatar.map { .avatar($0, serverId: target.serverId) } ?? .none, size: 52)
        }
    }

    private func symbol(_ name: String, size: CGFloat) -> some View {
        Image(systemName: name)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(Theme.text1)
            .frame(width: 52, height: 52)
            .background(Theme.bg4, in: .circle)
    }

    // MARK: Sending

    /// What's being sent, then once a chat is picked, who to and a comment, as the message box.
    private var composer: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 8) {
            if !model.items.previews.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.items.previews) { thumbnail($0) }
                    }
                    .padding(.horizontal, 12)
                }
            } else if !model.itemsLoaded {
                ProgressView().tint(Theme.text2).padding(.horizontal, 12)
            }
            if !model.selected.isEmpty {
                Text(model.selected.map(\.title).joined(separator: ", "))
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                    .padding(.horizontal, 14)
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Add a comment…", text: $model.text, axis: .vertical)
                        .lineLimit(1...5)
                        .font(.body)
                        .foregroundStyle(Theme.text1)
                        .padding(.vertical, 8)
                        .padding(.horizontal, 14)
                        .background(Theme.bg2, in: .rect(cornerRadius: 19, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(Theme.line))
                        .accessibilityIdentifier(A11y.Share.comment)
                    Button {
                        Task { await model.send() }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(model.canSend ? model.settings.accent.onAccent : Theme.text3)
                            .frame(width: 36, height: 36)
                            .background(model.canSend ? model.settings.accent.color : Theme.bg3, in: .circle)
                    }
                    .buttonStyle(.plain)
                    .disabled(!model.canSend)
                    .padding(.bottom, 1)
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier(A11y.Share.send)
                }
                .padding(.horizontal, 8)
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg0)
        .overlay(alignment: .top) { Divider().overlay(Theme.line) }
    }

    private func thumbnail(_ preview: SharedItems.Preview) -> some View {
        ZStack {
            Theme.bg3
            if let image = preview.image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "doc.fill").foregroundStyle(Theme.text2)
            }
            if preview.isVideo {
                Image(systemName: "play.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(.white)
                    .shadow(radius: 2)
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(.rect(cornerRadius: 10))
    }

    private var sending: some View {
        ZStack {
            Theme.bg0.opacity(0.6).ignoresSafeArea()
            VStack(spacing: 14) {
                if model.phase == .sent {
                    Image(systemName: "checkmark")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(model.settings.accent.onAccent)
                        .frame(width: 48, height: 48)
                        .background(model.settings.accent.color, in: .circle)
                    Text("Sent").foregroundStyle(Theme.text1)
                } else {
                    if let progress = model.progress {
                        ProgressView(value: progress).frame(width: 160).tint(model.settings.accent.color)
                    } else {
                        ProgressView().tint(Theme.text1)
                    }
                    Text("Sending…").foregroundStyle(Theme.text1)
                }
            }
            .padding(24)
            .background(Theme.bg2, in: .rect(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.line))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(A11y.Share.sending)
        }
    }
}

/// The servers to share to, as the app's list of servers: the picture and the
/// name, the one showing marked.
private struct ServerChoice: View {
    @Environment(ShareModel.self) private var model

    var body: some View {
        List {
            ForEach(model.servers.filter { !$0.targets.isEmpty }) { server in
                let open = server.id == model.serverId
                Button {
                    model.choose(server.id)
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(name: server.name, seed: server.url, source: .serverAt(url: server.url, hasIcon: server.hasIcon), size: 44, rounded: true)
                        Text(server.name)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Theme.text1)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        let picked = model.selected.count { $0.serverId == server.id }
                        if picked > 0 {
                            Text("\(picked)")
                                .font(.footnote.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(model.settings.accent.onAccent)
                                .padding(.horizontal, 7)
                                .frame(minWidth: 22, minHeight: 22)
                                .background(model.settings.accent.color, in: .capsule)
                        }
                    }
                    .frame(minHeight: 60)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 14))
                .listRowBackground(open ? Theme.bg3 : Theme.bg1)
                .listRowSeparatorTint(Theme.line)
                .alignmentGuide(.listRowSeparatorLeading) { _ in 68 }
                .accessibilityAddTraits(open ? .isSelected : [])
                .accessibilityIdentifier(A11y.Share.server(server.name))
            }
            .listSectionSeparator(.hidden, edges: .top)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bg1)
        .navigationTitle("Servers")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg1, for: .navigationBar)
    }
}
