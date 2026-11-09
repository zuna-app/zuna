import AVFoundation
import UIKit

/// One video in the viewer, fitted to the screen. It plays while it's on screen, as it comes,
/// showing its placeholder until its first frame, and stops at its end, back at the start. Its
/// file, for Share, comes once all of it has.
@MainActor
final class VideoPage: UIViewController, ViewerPage {
    let index: Int
    private let item: PhotoViewer.Item
    private let video: PhotoViewer.Video
    /// The decrypted file, once all of it has come, for Share.
    private(set) var file: URL?
    var onTap: () -> Void = {}
    var onOpened: (URL) -> Void = { _ in }
    let player = AVPlayer()
    private let playerView = PlayerView()
    private let posterView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let failure = UILabel()
    private var opening: Task<Void, Never>?
    private var onScreen = false
    private var watches: [NSKeyValueObservation] = []
    private var itemWatch: NSKeyValueObservation?
    /// This page set the audio session up, and lets it go when it's off screen, so music it interrupted carries on.
    private var ownsSession = false

    var zoomed: Bool { false }

    init(index: Int, item: PhotoViewer.Item, video: PhotoViewer.Video) {
        self.index = index
        self.item = item
        self.video = video
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        posterView.image = item.placeholder
        posterView.contentMode = .scaleAspectFit
        posterView.frame = view.bounds
        posterView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(posterView)

        playerView.playerLayer.player = player
        playerView.playerLayer.videoGravity = .resizeAspect
        playerView.frame = view.bounds
        playerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        playerView.isAccessibilityElement = true
        playerView.accessibilityLabel = item.name
        playerView.accessibilityIdentifier = A11y.Chat.videoPage
        view.addSubview(playerView)

        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)
        failure.textColor = UIColor.white.withAlphaComponent(0.7)
        failure.font = .preferredFont(forTextStyle: .subheadline)
        failure.numberOfLines = 0
        failure.textAlignment = .center
        failure.isHidden = true
        failure.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failure)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failure.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failure.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            failure.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))

        watches = [
            // The placeholder until the first frame's there.
            playerView.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
                let ready = layer.isReadyForDisplay
                Task { @MainActor in self?.posterView.isHidden = ready }
            },
            // Waiting for what it plays next to come.
            player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
                let waiting = player.timeControlStatus == .waitingToPlayAtSpecifiedRate
                Task { @MainActor in
                    if waiting { self?.spinner.startAnimating() } else { self?.spinner.stopAnimating() }
                }
            },
        ]
    }

    /// Only the video on screen is fetched and plays, not the ones beside it.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onScreen = true
        start()
        play()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        onScreen = false
        player.pause()
        releaseSession()
        video.stop()
    }

    /// Plays at once, as it comes.
    private func start() {
        if player.currentItem == nil, let asset = video.play() { use(asset) }
        if player.currentItem == nil || player.currentItem?.status == .readyToPlay { fetchWhole() }
    }

    /// All of it, for Share, fetched beside what plays once it's ready to, so it doesn't hold up the start.
    private func fetchWhole() {
        guard onScreen, file == nil, opening == nil else { return }
        if player.currentItem == nil { spinner.startAnimating() }
        opening = Task { [weak self, item] in
            do {
                let file = try await item.open()
                guard let self else { return }
                opening = nil
                self.file = file
                onOpened(file)
                // One that couldn't play as it came plays now that all of it is here.
                if player.currentItem == nil, let asset = video.play() {
                    use(asset)
                    if onScreen { play() }
                }
            } catch {
                guard let self else { return }
                opening = nil
                // Called off as it went off screen; it carries on from there when it's back.
                guard !(error is CancellationError), player.currentItem == nil else { return }
                fail(ErrorText.describe(error))
            }
        }
    }

    private func use(_ asset: AVURLAsset) {
        let playerItem = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: playerItem)
        itemWatch = playerItem.observe(\.status, options: [.new]) { [weak self] playerItem, _ in
            let status = playerItem.status
            Task { @MainActor in
                if status == .readyToPlay { self?.fetchWhole() }
                if status == .failed { self?.fail("This video can't be played.") }
            }
        }
        // At its end it stops, back at the start, as in Telegram. Only one item ever plays here.
        NotificationCenter.default.addObserver(self, selector: #selector(playedToEnd), name: AVPlayerItem.didPlayToEndTimeNotification, object: playerItem)
    }

    @objc private func playedToEnd() {
        player.pause()
        player.seek(to: .zero)
    }

    /// With its sound, even with the phone set to silent, as a voice message plays, and within a call's session.
    private func play() {
        guard player.currentItem != nil, failure.isHidden else { return }
        VoicePlayer.shared.stop()
        if !CallAudio.active, !ownsSession {
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try? AVAudioSession.sharedInstance().setActive(true)
            ownsSession = true
        }
        player.play()
    }

    private func releaseSession() {
        guard ownsSession else { return }
        ownsSession = false
        guard !CallAudio.active else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func fail(_ reason: String) {
        spinner.stopAnimating()
        player.pause()
        playerView.isHidden = true
        failure.text = reason
        failure.isHidden = false
    }

    @objc private func tapped() { onTap() }
}

private final class PlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

/// Under a video in the viewer, as in Telegram: play or pause, how far it's got, a bar to drag
/// to another place in it, and how much is left.
@MainActor
final class VideoControls: UIView {
    private let background = PhotoViewer.glass()
    private let button = UIButton(type: .system)
    private let elapsed = UILabel()
    private let remaining = UILabel()
    private let slider = UISlider()
    private weak var player: AVPlayer?
    private var ticks: Any?
    private var statusWatch: NSKeyValueObservation?
    private var scrubbing = false
    private var wasPlaying = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        background.frame = bounds
        background.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(background)

        var configuration = UIButton.Configuration.plain()
        configuration.baseForegroundColor = .white
        configuration.image = UIImage(systemName: "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        button.configuration = configuration
        button.accessibilityIdentifier = A11y.Chat.videoPlay
        button.addTarget(self, action: #selector(toggle), for: .primaryActionTriggered)
        for label in [elapsed, remaining] {
            label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            label.textColor = .white
            label.setContentHuggingPriority(.required, for: .horizontal)
            label.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        // Thin, as Telegram's, with a small white thumb.
        slider.minimumTrackTintColor = .white
        slider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.3)
        slider.setThumbImage(Self.thumb, for: .normal)
        slider.accessibilityLabel = "Position"
        slider.accessibilityIdentifier = A11y.Chat.videoPosition
        slider.addTarget(self, action: #selector(beganScrubbing), for: .touchDown)
        slider.addTarget(self, action: #selector(scrubbed), for: .valueChanged)
        slider.addTarget(self, action: #selector(endedScrubbing), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        let row = UIStackView(arrangedSubviews: [button, elapsed, slider, remaining])
        row.spacing = 10
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        background.contentView.addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 44),
            button.widthAnchor.constraint(equalToConstant: 44),
            button.heightAnchor.constraint(equalToConstant: 44),
            row.leadingAnchor.constraint(equalTo: background.contentView.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: background.contentView.trailingAnchor, constant: -16),
            row.topAnchor.constraint(equalTo: background.contentView.topAnchor),
            row.bottomAnchor.constraint(equalTo: background.contentView.bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Follows the video on show, or none.
    func attach(_ player: AVPlayer?) {
        guard player !== self.player else { return }
        if let ticks { self.player?.removeTimeObserver(ticks) }
        ticks = nil
        statusWatch = nil
        self.player = player
        guard let player else { return }
        ticks = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        }
        statusWatch = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.update() }
        }
        update()
    }

    private var duration: Double? {
        guard let seconds = player?.currentItem?.duration.seconds, seconds.isFinite, seconds > 0 else { return nil }
        return seconds
    }

    private func update() {
        guard let player else { return }
        // Waiting for what comes next counts as playing: the button would stop it.
        let playing = player.timeControlStatus != .paused || (scrubbing && wasPlaying)
        button.configuration?.image = UIImage(systemName: playing ? "pause.fill" : "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        button.accessibilityLabel = playing ? "Pause" : "Play"
        let current = player.currentTime().seconds
        let now = current.isFinite ? max(0, current) : 0
        slider.isEnabled = duration != nil
        guard let duration else {
            elapsed.text = Format.duration(now)
            remaining.text = nil
            return
        }
        if !scrubbing { slider.value = Float(now / duration) }
        show(now, of: duration)
    }

    private func show(_ now: Double, of duration: Double) {
        elapsed.text = Format.duration(now)
        remaining.text = "-\(Format.duration(max(0, duration - now)))"
        slider.accessibilityValue = "\(Format.duration(now)) of \(Format.duration(duration))"
    }

    @objc private func toggle() {
        guard let player else { return }
        if player.timeControlStatus == .paused { player.play() } else { player.pause() }
        update()
    }

    @objc private func beganScrubbing() {
        scrubbing = true
        wasPlaying = player?.timeControlStatus != .paused
        player?.pause()
    }

    @objc private func scrubbed() {
        guard let player, let duration else { return }
        let seconds = Double(slider.value) * duration
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        show(seconds, of: duration)
    }

    @objc private func endedScrubbing() {
        scrubbing = false
        if wasPlaying { player?.play() }
        update()
    }

    private static let thumb = UIGraphicsImageRenderer(size: CGSize(width: 14, height: 14)).image { context in
        UIColor.white.setFill()
        context.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: 14, height: 14))
    }
}
