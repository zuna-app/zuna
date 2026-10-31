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

/// What was picked: an emoji, or one of the server's emotes.
enum EmojiPick {
    case emoji(String)
    case emote(Emote)
}

/// The server's emotes and the emoji, with search, as on the desktop. Opens as a sheet.
struct EmojiPicker: View {
    let server: AppModel.ServerState
    let onPick: (EmojiPick) -> Void

    enum Tab: Hashable { case emotes, emoji }

    @Environment(\.dismiss) private var dismiss
    @State private var tab: Tab
    @State private var query = ""

    init(server: AppModel.ServerState, onPick: @escaping (EmojiPick) -> Void) {
        self.server = server
        self.onPick = onPick
        _tab = State(initialValue: server.emotes.emotes.isEmpty ? .emoji : .emotes)
    }

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        NavigationStack {
            VStack(spacing: 10) {
                Picker("Show", selection: $tab) {
                    Text(server.emotes.setName.isEmpty ? "Server emotes" : server.emotes.setName).tag(Tab.emotes)
                    Text("Emoji").tag(Tab.emoji)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                ScrollView {
                    if tab == .emotes {
                        emotes(needle)
                    } else {
                        emoji(needle)
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
            .navigationTitle("Emoji and emotes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .background(Theme.bg1)
        }
        .accessibilityIdentifier(A11y.Composer.picker)
    }

    @ViewBuilder
    private func emotes(_ needle: String) -> some View {
        let shown = needle.isEmpty ? server.emotes.emotes : server.emotes.emotes.filter { $0.name.lowercased().contains(needle) }
        if shown.isEmpty {
            ContentUnavailableView(needle.isEmpty ? "This server has no emotes yet." : "No emotes match that search.", systemImage: "face.smiling")
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
                    .accessibilityLabel(emote.owner.isEmpty ? emote.name : "\(emote.name) by \(emote.owner)")
                    .accessibilityIdentifier(A11y.Composer.pickerEmote(emote.name))
                }
            }
            .padding(.horizontal)
        }
    }

    private func emoji(_ needle: String) -> some View {
        LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(EmojiCategory.all) { category in
                let shown = needle.isEmpty ? category.emoji : category.emoji.filter { $0.count > 1 && $0[1].contains(needle) }
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
