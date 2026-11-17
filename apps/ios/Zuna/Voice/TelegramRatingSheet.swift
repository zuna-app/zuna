import SwiftUI
import ZunaModels

/// How a Telegram call was, when Telegram asks once it's over: one to five, and under five which of
/// Telegram's problems it had. Telegram is told nothing else, and it can be closed unanswered
/// (docs/TELEGRAM_CALLS_PLAN.md, What the screens show). The desktop's rating card.
struct TelegramRatingSheet: View {
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let rating = voice.telegramRating
        NavigationStack {
            VStack(spacing: 18) {
                Text(t("telegram.call.rateTitle", ["name": rating?.name ?? ""]))
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.text1)
                HStack(spacing: 10) {
                    ForEach(1...5, id: \.self) { stars in
                        Button {
                            voice.rateStars(stars)
                        } label: {
                            Image(systemName: (rating?.stars ?? 0) >= stars ? "star.fill" : "star")
                                .font(.system(size: 30))
                                .foregroundStyle((rating?.stars ?? 0) >= stars ? Theme.amber : Theme.text3)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(stars)")
                        .accessibilityIdentifier(A11y.Voice.ratingStar(stars))
                    }
                }
                if let stars = rating?.stars, stars < 5 {
                    Text(t("telegram.call.rateWhatWasWrong"))
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .multilineTextAlignment(.center)
                    VStack(spacing: 0) {
                        ForEach(TelegramRating.problemKeys, id: \.0) { problem, key in
                            Button {
                                voice.toggleProblem(problem)
                            } label: {
                                HStack {
                                    Text(t(key)).foregroundStyle(Theme.text1)
                                    Spacer()
                                    if rating?.problems.contains(problem) == true {
                                        Image(systemName: "checkmark").foregroundStyle(Theme.link)
                                    }
                                }
                                .padding(.vertical, 9)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 14)
                    .background(Theme.bg2, in: .rect(cornerRadius: 12))
                    Button(t("telegram.call.rateSend")) { voice.sendRating() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier(A11y.Voice.ratingSend)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(t("common.close")) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier(A11y.Voice.rating)
    }
}
