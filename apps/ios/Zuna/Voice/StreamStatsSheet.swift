import SwiftUI
import UIKit

/// Everything there is to know about what's going out and coming in, over the call, from
/// tapping its connection. A sheet the call goes on behind at half height, rather than the
/// desktop's window that moves (StreamStatsPanel).
struct StreamStatsSheet: View {
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss
    @State private var sections: [StatSection] = []
    /// Sound is what there's least to wonder about, so it starts folded.
    @State private var folded: Set<String> = []
    @State private var seen: Set<String> = []
    @State private var copied = false

    /// More often than LiveKit reads, so a reading shows soon after it comes.
    private static let readEvery: Duration = .milliseconds(500)

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections) { section in
                    Section(isExpanded: Binding(get: { !folded.contains(section.id) }, set: { open in
                        if open { folded.remove(section.id) } else { folded.insert(section.id) }
                    })) {
                        if let headline = section.headline {
                            HeadlineRow(title: section.title, headline: headline)
                        }
                        ForEach(section.rows) { row in
                            StatRowView(row: row)
                        }
                    } header: {
                        Text(section.title)
                    }
                }
            }
            .listStyle(.sidebar)
            .environment(\.defaultMinListRowHeight, 34)
            .navigationTitle("Stream stats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(copied ? "Copied" : "Copy all of it", systemImage: copied ? "checkmark" : "doc.on.doc") { copy() }
                        .disabled(sections.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        // Solid, as the call's video moving behind glass would make the numbers hard to read.
        .presentationBackground(Theme.bg1)
        .task {
            let reader = StreamStats()
            defer { reader.close() }
            while !Task.isCancelled {
                let next = voice.readStats(reader)
                for section in next where !seen.contains(section.id) {
                    seen.insert(section.id)
                    if section.kind == .audio { folded.insert(section.id) }
                }
                sections = next
                try? await Task.sleep(for: Self.readEvery)
            }
        }
        // Nothing to read once the call's over.
        .onChange(of: voice.inCall) { _, inCall in if !inCall { dismiss() } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Voice.statsSheet)
    }

    private func copy() {
        UIPasteboard.general.string = StreamStats.asText(sections)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// The frame rate to look at first, and how it's gone lately, against what was wanted if that's known.
private struct HeadlineRow: View {
    let title: String
    let headline: StatSection.Headline

    var body: some View {
        let rate = headline.fps.map { String(format: "%.1f", $0) } ?? "…"
        let wanted = headline.wanted.map { " of \($0)" } ?? ""
        HStack(alignment: .center, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(rate).font(.title2.weight(.semibold)).monospacedDigit()
                Text("fps \(headline.label)\(wanted)").font(.footnote).foregroundStyle(Theme.text2)
            }
            Spacer(minLength: 8)
            FpsGraph(history: headline.history, wanted: headline.wanted)
                .frame(width: 120, height: 28)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title): \(rate) fps \(headline.label)\(wanted)")
        .accessibilityIdentifier(A11y.Voice.statsHeadline)
    }
}

private struct FpsGraph: View {
    let history: [Double]
    let wanted: Int?

    var body: some View {
        Canvas { context, size in
            let top = max(Double(wanted ?? 0), history.max() ?? 0, 1) * 1.1
            let y = { (value: Double) in size.height - value / top * size.height }
            let step = size.width / 59
            if let wanted {
                var line = Path()
                line.move(to: CGPoint(x: 0, y: y(Double(wanted))))
                line.addLine(to: CGPoint(x: size.width, y: y(Double(wanted))))
                context.stroke(line, with: .color(Theme.text3), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
            guard history.count > 1 else { return }
            var graph = Path()
            for (index, value) in history.enumerated() {
                let point = CGPoint(x: size.width - CGFloat(history.count - 1 - index) * step, y: y(value))
                if index == 0 { graph.move(to: point) } else { graph.addLine(to: point) }
            }
            context.stroke(graph, with: .color(Theme.green), lineWidth: 1.5)
        }
        .accessibilityHidden(true)
    }
}

private struct StatRowView: View {
    let row: StatRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(row.label)
                .foregroundStyle(Theme.text2)
                .fixedSize()
            Spacer(minLength: 8)
            // Codecs' parameters and paths run long, and wrap rather than lose their end.
            Text(row.value)
                .foregroundStyle(row.warn ? Theme.amber : Theme.text1)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
                .textSelection(.enabled)
        }
        .font(.footnote)
        .accessibilityElement(children: .combine)
    }
}
