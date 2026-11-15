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

    /// How long a link lasts, in seconds, 0 being for good.
    private static let expiries = [86_400, 604_800, 2_592_000, 0]
    /// How often a link can be used, 0 being without a limit.
    private static let useLimits = [1, 5, 25, 0]

    private static func expiryName(_ seconds: Int) -> String {
        seconds == 0 ? t("invites.expiry.never") : t("invites.days", ["count": seconds / 86_400])
    }

    private static func usesName(_ uses: Int) -> String {
        uses == 0 ? t("common.noLimit") : t("invites.uses", ["count": uses])
    }

    var body: some View {
        let server = model.servers[serverId]
        let canManage = server?.me?.role != .member || server?.info?.allowMemberInvites == true
        NavigationStack {
            List {
                Section {
                    Text(t("invites.warning"))
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
                .listRowBackground(Color.clear)
                if !canManage {
                    Section {
                        Label(t("invites.adminsOnly"), systemImage: "link")
                            .foregroundStyle(Theme.text1)
                    }
                    .listRowBackground(Theme.bg2)
                } else {
                    Section {
                        Picker(t("invites.expiresAfter"), selection: $expiry) {
                            ForEach(Self.expiries, id: \.self) { Text(Self.expiryName($0)).tag($0) }
                        }
                        Picker(t("invites.canBeUsed"), selection: $uses) {
                            ForEach(Self.useLimits, id: \.self) { Text(Self.usesName($0)).tag($0) }
                        }
                        Button {
                            create()
                        } label: {
                            Label(t("invites.create"), systemImage: "link.badge.plus")
                        }
                        .disabled(busy)
                        .accessibilityIdentifier(A11y.Invites.create)
                    }
                    .listRowBackground(Theme.bg2)
                    if let link {
                        Section(t("invites.newLink")) {
                            Text(link)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                                .accessibilityIdentifier(A11y.Invites.link)
                            HStack {
                                Button(t("common.copy"), systemImage: "doc.on.doc") { copy(link) }
                                Spacer()
                                ShareLink(item: link) { Label(t("common.share"), systemImage: "square.and.arrow.up") }
                            }
                            .buttonStyle(.borderless)
                        }
                        .listRowBackground(Theme.bg2)
                    }
                    if let invites, !invites.isEmpty {
                        Section(t("invites.active")) {
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
                                    .accessibilityLabel(t("invites.copyLink"))
                                    Button(role: .destructive) {
                                        revoke(invite.code)
                                    } label: {
                                        Image(systemName: "trash")
                                    }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel(t("invites.revoke"))
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
            .navigationTitle(t("invites.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(t("common.close")) { dismiss() } } }
            .task { await refresh(canManage) }
        }
        .accessibilityIdentifier(A11y.Invites.screen)
    }

    private func details(_ invite: Invite) -> String {
        let limited = invite.maxUses > 0
        guard let expires = invite.expiresAt else {
            return limited ? t("invites.row.usedOf", ["used": invite.uses, "max": invite.maxUses]) : t("invites.row.used", ["used": invite.uses])
        }
        let date = Date(milliseconds: expires)
        let when = Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return limited
            ? t("invites.row.usedOfExpires", ["used": invite.uses, "max": invite.maxUses, "when": when])
            : t("invites.row.usedExpires", ["used": invite.uses, "when": when])
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
        model.toast(t("invites.copied"))
    }
}
