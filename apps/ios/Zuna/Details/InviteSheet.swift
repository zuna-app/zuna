import SwiftUI
import ZunaModels

/// Invite links, as the desktop's invite panel: how long a link lasts and how
/// often it can be used, the new link to copy or share, and the active ones.
struct InviteSheet: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var expiry = 604_800
    @State private var uses = 0
    @State private var link: String?
    @State private var invites: [Invite]?
    @State private var busy = false

    private static let expiries = [("1 day", 86_400), ("7 days", 604_800), ("30 days", 2_592_000), ("Never", 0)]
    private static let useLimits = [("1 use", 1), ("5 uses", 5), ("25 uses", 25), ("No limit", 0)]

    var body: some View {
        let server = model.servers[serverId]
        let canManage = server?.me?.role != .member || server?.info?.allowMemberInvites == true
        NavigationStack {
            List {
                Section {
                    Text("Anyone with a link can create an account here. It also holds the key that protects member profiles, so only share it with people you trust.")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
                .listRowBackground(Color.clear)
                if !canManage {
                    Section {
                        Label("On this server, only admins can create invite links. Ask one of them for a link.", systemImage: "link")
                            .foregroundStyle(Theme.text1)
                    }
                    .listRowBackground(Theme.bg2)
                } else {
                    Section {
                        Picker("Expires after", selection: $expiry) {
                            ForEach(Self.expiries, id: \.1) { Text($0.0).tag($0.1) }
                        }
                        Picker("Can be used", selection: $uses) {
                            ForEach(Self.useLimits, id: \.1) { Text($0.0).tag($0.1) }
                        }
                        Button {
                            create()
                        } label: {
                            Label("Create invite link", systemImage: "link.badge.plus")
                        }
                        .disabled(busy)
                        .accessibilityIdentifier(A11y.Invites.create)
                    }
                    .listRowBackground(Theme.bg2)
                    if let link {
                        Section("New link") {
                            Text(link)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                                .accessibilityIdentifier(A11y.Invites.link)
                            HStack {
                                Button("Copy", systemImage: "doc.on.doc") { copy(link) }
                                Spacer()
                                ShareLink(item: link) { Label("Share", systemImage: "square.and.arrow.up") }
                            }
                            .buttonStyle(.borderless)
                        }
                        .listRowBackground(Theme.bg2)
                    }
                    if let invites, !invites.isEmpty {
                        Section("Active links") {
                            ForEach(invites, id: \.code) { invite in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(invite.code).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.text1)
                                        Text(details(invite)).font(.caption).foregroundStyle(Theme.text3)
                                    }
                                    Spacer()
                                    Button {
                                        Task {
                                            if let shared = try? await model.core.session(serverId).linkForInvite(invite.code) { copy(shared) }
                                        }
                                    } label: {
                                        Image(systemName: "doc.on.doc")
                                    }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel("Copy link")
                                    Button(role: .destructive) {
                                        revoke(invite.code)
                                    } label: {
                                        Image(systemName: "trash")
                                    }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel("Revoke link")
                                }
                                .accessibilityElement(children: .contain)
                                .accessibilityIdentifier(A11y.Invites.row(invite.code))
                            }
                        }
                        .listRowBackground(Theme.bg2)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle("Invite people")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { await refresh(canManage) }
        }
        .accessibilityIdentifier(A11y.Invites.screen)
    }

    private func details(_ invite: Invite) -> String {
        var text = "\(invite.uses) used"
        if invite.maxUses > 0 { text += " of \(invite.maxUses)" }
        if let expires = invite.expiresAt {
            let date = Date(milliseconds: expires)
            let when = Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
            text += " · expires \(when)"
        }
        return text
    }

    private func refresh(_ canManage: Bool) async {
        guard canManage else { return }
        invites = (try? await model.core.session(serverId).invites()) ?? []
    }

    private func create() {
        busy = true
        Task {
            do {
                let created = try await model.core.session(serverId).createInvite(maxUses: uses, expiresInSeconds: expiry)
                link = created
                copy(created)
                await refresh(true)
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
            busy = false
        }
    }

    private func revoke(_ code: String) {
        Task {
            do {
                try await model.core.session(serverId).revokeInvite(code)
                await refresh(true)
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
        }
    }

    private func copy(_ value: String) {
        UIPasteboard.general.string = value
        model.toast("Invite link copied")
    }
}
