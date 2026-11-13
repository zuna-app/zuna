import SwiftUI
import UniformTypeIdentifiers
import ZunaModels

/// Your data: everything the server says it keeps about the account, in the core's
/// plain words, and shared as the server's own answer (`ServerDataSection` in
/// packages/ui/src/features/overlays/Settings.tsx, `ui/settings/server_data.rs` in the native app).
struct ServerDataView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var exported: ServerDataExport?
    @State private var busy = false

    var body: some View {
        let name = model.servers[serverId]?.entry.name ?? "The server"
        List {
            Section {
                Text("Everything \(name) says it keeps about your account. Your messages, name, picture and files are encrypted on your devices before they're sent, so only their sizes appear here.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                if busy && exported == nil {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            }
            .listRowBackground(Color.clear)
            if let exported {
                ForEach(exported.sections) { section in
                    Section {
                        ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in
                            ServerDataRowView(row: row)
                        }
                    } header: {
                        Text(section.title)
                    } footer: {
                        Text(section.about)
                    }
                    .listRowBackground(Theme.bg2)
                }
                Section {
                } footer: {
                    Text("This is what \(name) says it keeps. A modified server could keep more than it says, which is why everything that matters is encrypted on your devices before it's sent.")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Your data")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let exported {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: ServerDataFile(name: exported.fileName, json: exported.json), preview: SharePreview(exported.fileName, image: Image(systemName: "doc.text"))) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Save as file")
                }
            }
        }
        .task(id: serverId) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            exported = try await model.core.session(serverId).exportServerData()
        } catch {
            model.toast(ErrorText.describe(error), .error)
        }
    }
}

private struct ServerDataRowView: View {
    let row: ServerDataRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label).foregroundStyle(Theme.text1)
                if let note = row.note {
                    Text(note).font(.caption).foregroundStyle(Theme.text3)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                Text(row.value)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text1)
                    .multilineTextAlignment(.trailing)
                    .textSelection(.enabled)
                tag
            }
            .frame(maxWidth: 170, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }

    /// What the server can do with it: amber for what it reads, green for what it can't.
    private var tag: some View {
        Text(tagLabel)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tagColor)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(tagColor.opacity(0.14), in: Capsule())
    }

    private var tagLabel: String {
        switch row.kind {
        case .readable: return "Readable"
        case .encrypted: return "Encrypted"
        case .publicKey: return "Public"
        case .withheld: return "Left out"
        case .notKept: return "Not kept"
        }
    }

    private var tagColor: Color {
        switch row.kind {
        case .readable: return Theme.amber
        case .encrypted, .notKept: return Theme.green
        case .publicKey, .withheld: return Theme.text2
        }
    }
}

/// The server's answer, as a JSON file to share or save.
struct ServerDataFile: Transferable {
    let name: String
    let json: String

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .json) { file in
            Data(file.json.utf8)
        }
        .suggestedFileName { $0.name }
    }
}
