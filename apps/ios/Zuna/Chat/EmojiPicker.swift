import SwiftUI
import ZunaModels

/// The desktop's emoji (lib/emoji-data.ts), copied into Resources/emoji.json
/// and kept in step by tests/e2e/test/golden.test.ts.
struct EmojiCategory: Decodable, Identifiable {
    let id: String
    let label: String
    /// Each emoji with the words it's found by.
    let emoji: [[String]]

    static let all: [EmojiCategory] = {
        guard let url = Bundle.main.url(forResource: "emoji", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([EmojiCategory].self, from: data)) ?? []
    }()
}

/// What was picked: an emoji, one of the server's emotes, or one of a Telegram account's stickers.
enum EmojiPick {
    case emoji(String)
    case emote(Emote)
    case sticker(TelegramSticker)
}

/// The server's emotes and the emoji, with search, as on the desktop. Opens as a sheet, or as
/// the panel under a phone's message box, in the keyboard's place.
struct EmojiPicker: View {
    let server: AppModel.ServerState
    let onPick: (EmojiPick) -> Void

    enum Tab: Hashable { case emotes, emoji, stickers }

    @Environment(\.dismiss) private var dismiss
    @State private var tab: Tab
    @State private var query = ""
    @FocusState private var searching: Bool

    /// Picking a reaction, which a sticker can't be.
    private let reacting: Bool
    /// Which emoji the reaction can be.
    private let offered: OfferedReactions
    /// The panel it's in, which hears when its search is typed in, or nil in a sheet.
    private let panel: ComposerPanel?

    init(server: AppModel.ServerState, reacting: Bool = false, offered: OfferedReactions = .any, panel: ComposerPanel? = nil, onPick: @escaping (EmojiPick) -> Void) {
        self.server = server
        self.reacting = reacting
        self.offered = offered
        self.panel = panel
        self.onPick = onPick
        let stickers = server.entry.isTelegram && !reacting
        _tab = State(initialValue: stickers ? .stickers : server.emotes.emotes.isEmpty ? .emoji : .emotes)
    }

    var body: some View {
        if let panel {
            VStack(spacing: 8) {
                // Stickers aren't searched.
                if tab != .stickers { searchField }
                content
            }
            .padding(.top, 8)
            .background(Theme.bg1.ignoresSafeArea(.container, edges: .bottom))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(A11y.Composer.picker)
            .onChange(of: searching) { _, searching in
                withAnimation(Keyboard.animation) { panel.searching = searching }
            }
        } else {
            NavigationStack {
                content
                    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: t("common.search"))
                    .navigationTitle(t("composer.emoji"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(t("common.close")) { dismiss() }
                        }
                    }
                    .background(Theme.bg1)
            }
            .accessibilityIdentifier(A11y.Composer.picker)
        }
    }

    /// The panel's own search, as it has no bar for the system's.
    private var searchField: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.text3)
                TextField(t("common.search"), text: $query)
                    .focused($searching)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    // Down to the keyboard's place before the keyboard goes, which then moves nothing.
                    .onSubmit { withAnimation(Keyboard.animation) { panel?.searching = false } }
                    .foregroundStyle(Theme.text1)
                    .accessibilityIdentifier(A11y.Composer.pickerSearch)
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.text3)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(t("common.clear"))
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 36)
            .background(Theme.bg3, in: .rect(cornerRadius: 10, style: .continuous))
            if searching {
                // Back to the whole panel, where the keyboard was.
                Button(t("common.cancel")) {
                    query = ""
                    // Down to the keyboard's place first, so the keyboard going then moves nothing.
                    withAnimation(Keyboard.animation) { panel?.searching = false }
                    searching = false
                }
                .accessibilityIdentifier(A11y.Composer.pickerCancelSearch)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(.horizontal)
    }

    private var content: some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return VStack(spacing: 10) {
            Picker(t("emoji.picker.show"), selection: $tab) {
                // A Telegram account has its own sticker sets, and no server's emotes.
                if server.entry.isTelegram {
                    if !reacting { Text(t("emoji.stickers")).tag(Tab.stickers) }
                } else {
                    Text(server.emotes.setName.isEmpty ? t("emoji.serverEmotes") : server.emotes.setName).tag(Tab.emotes)
                }
                Text(t("emoji.tab")).tag(Tab.emoji)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            ScrollView {
                switch tab {
                case .emotes: emotes(needle)
                case .emoji: emoji(needle)
                case .stickers: TelegramStickers(onPick: { onPick(.sticker($0)) })
                }
            }
        }
    }

    @ViewBuilder
    private func emotes(_ needle: String) -> some View {
        let shown = needle.isEmpty ? server.emotes.emotes : server.emotes.emotes.filter { $0.name.lowercased().contains(needle) }
        if shown.isEmpty {
            ContentUnavailableView(needle.isEmpty ? t("emoji.noEmotes") : t("emoji.noMatches"), systemImage: "face.smiling")
                .padding(.top, 40)
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 56), spacing: 6)], spacing: 6) {
                ForEach(shown) { emote in
                    Button {
                        onPick(.emote(emote))
                    } label: {
                        EmoteView(name: emote.name, id: emote.id, size: .inline, serverUrl: server.entry.url)
                            .frame(width: 44, height: 44)
                            .frame(width: 56, height: 56)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(emote.owner.isEmpty ? emote.name : t("emoji.emoteBy", ["name": emote.name, "owner": emote.owner]))
                    .accessibilityIdentifier(A11y.Composer.pickerEmote(emote.name))
                }
            }
            .padding(.horizontal)
        }
    }

    @ViewBuilder
    private func emoji(_ needle: String) -> some View {
        switch offered {
        case .asking:
            ProgressView().padding(.top, 40)
        case .only([]):
            ContentUnavailableView(t("telegram.reaction.none"), systemImage: "face.smiling")
                .padding(.top, 40)
        default:
            emojiGrid(needle)
        }
    }

    private func emojiGrid(_ needle: String) -> some View {
        let allowed = offered.allowed
        return LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(EmojiCategory.all) { category in
                let shown = category.emoji.filter { entry in
                    !entry.isEmpty && (needle.isEmpty || (entry.count > 1 && entry[1].contains(needle))) && allowed.map { $0.contains(OfferedReactions.bare(entry[0])) } != false
                }
                if !shown.isEmpty {
                    Text(category.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .padding(.top, 6)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 2)], spacing: 2) {
                        ForEach(shown, id: \.self) { entry in
                            Button {
                                onPick(.emoji(entry[0]))
                            } label: {
                                Text(entry[0]).font(.system(size: 30)).frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(entry.count > 1 ? entry[1] : entry[0])
                        }
                    }
                }
            }
        }
        .padding(.horizontal)
    }
}
