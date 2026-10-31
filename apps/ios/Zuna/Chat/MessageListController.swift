import SwiftUI
import UIKit
import ZunaModels

/// What the chat screen can ask of its list.
@MainActor
final class MessageListBridge {
    var scrollToBottom: () -> Void = {}
}

/// The messages of a chat in a `UICollectionView` turned upside down, as chat
/// apps do: the newest message is item 0 at the bottom, older pages are added
/// past the end, so loading history and cells settling their size happen out
/// of sight instead of moving what's on screen.
final class MessageListController: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    struct Input {
        var listKey: String
        var detached: Bool
        var items: [MessageView]
        var server: AppModel.ServerState
        var conversation: ConversationView
        var highlighted: String?
        /// The messages picked to act on together, or nil when not picking.
        var selection: [String]?
        var jump: JumpTarget?
        var actions: ChatActions
    }

    var model: AppModel!
    var images: ImageStore!
    var onAtBottomChange: (Bool) -> Void = { _ in }
    var onNearOldest: () -> Void = {}
    var onJumpHandled: (String) -> Void = { _ in }

    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
    private var input: Input?
    private var contexts: [String: MessageRowContext] = [:]
    private var atBottom = true
    private var handledJump: Int?
    private var swiping: (cell: UICollectionViewCell, message: MessageView)?
    private let replyIcon = UIImageView(image: UIImage(systemName: "arrowshape.turn.up.left.circle.fill"))

    private static let groupWindow = 5 * 60 * 1000
    private static let flip = CGAffineTransform(scaleX: 1, y: -1)

    override func viewDidLoad() {
        super.viewDidLoad()
        let layout = UICollectionViewCompositionalLayout { _, _ in
            let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(64))
            let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [NSCollectionLayoutItem(layoutSize: size)])
            return NSCollectionLayoutSection(group: group)
        }
        collectionView = ChatCollectionView(frame: view.bounds, collectionViewLayout: layout)
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.backgroundColor = .clear
        collectionView.transform = Self.flip
        collectionView.contentInsetAdjustmentBehavior = .never
        // Upside down, the top of the content is the newest message, at the bottom of the screen.
        collectionView.contentInset = UIEdgeInsets(top: 10, left: 0, bottom: 8, right: 0)
        collectionView.scrollsToTop = false
        collectionView.keyboardDismissMode = .interactive
        collectionView.delegate = self
        collectionView.accessibilityIdentifier = A11y.Chat.list
        view.addSubview(collectionView)

        // Swiping a message to the left answers it, as in Telegram.
        let swipe = UIPanGestureRecognizer(target: self, action: #selector(swiped(_:)))
        swipe.delegate = self
        collectionView.addGestureRecognizer(swipe)
        replyIcon.tintColor = UIColor(Theme.text2)
        replyIcon.frame = CGRect(x: 0, y: 0, width: 30, height: 30)
        replyIcon.alpha = 0
        view.addSubview(replyIcon)

        let registration = UICollectionView.CellRegistration<UICollectionViewCell, String> { [weak self] cell, _, id in
            guard let self, let input, let context = contexts[id] else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                MessageRow(context: context, server: input.server, actions: input.actions)
                    .environment(self.model)
                    .environment(self.images)
            }
            .margins(.all, 0)
            cell.contentView.transform = Self.flip
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { collectionView, indexPath, id in
            collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
        }
    }

    func update(_ input: Input) {
        loadViewIfNeeded()
        let previous = self.input
        self.input = input
        rebuildContexts()
        let ids = input.items.reversed().map(\.id)
        let oldIds = dataSource.snapshot().itemIdentifiers
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(ids)
        let kept = Set(oldIds).intersection(ids)
        snapshot.reconfigureItems(Array(kept))

        // New messages at the bottom slide in while you're there; anything else just appears.
        let newAtBottom = oldIds.first.map { ids.first != $0 && ids.contains($0) } ?? false
        let animate = newAtBottom && atBottom && !model.reduceMotion
        let anchor = atBottom || oldIds.isEmpty ? nil : visibleAnchor()
        // Coming back to a chat that was scrolled up shows the same messages again.
        let saved = oldIds.isEmpty && !input.detached ? model.savedPositions[input.listKey] : nil
        dataSource.apply(snapshot, animatingDifferences: animate) { [weak self] in
            guard let self else { return }
            if let anchor { restore(anchor) }
            if let saved, let index = dataSource.snapshot().indexOfItem(saved) {
                collectionView.layoutIfNeeded()
                // Upside down, the bottom of the scroll view is the top of the screen.
                collectionView.scrollToItem(at: IndexPath(item: index, section: 0), at: .bottom, animated: false)
            }
            // Sending always brings you to the newest message.
            if let newest = input.items.last, newest.id != oldIds.first, newest.senderId == input.server.me?.userId, previous != nil {
                scrollToBottom(animated: true)
            }
            handleJump()
        }
    }

    /// Grouping and day separators depend on the neighbors, so every row's context is rebuilt.
    private func rebuildContexts() {
        guard let input else { return }
        let items = input.items
        let selfId = input.server.me?.userId ?? ""
        let readUpTo = input.conversation.readBy.reduce(0) { highest, entry in entry.key == selfId ? highest : max(highest, entry.value) }
        var result: [String: MessageRowContext] = [:]
        for (index, message) in items.enumerated() {
            let previous = index > 0 ? items[index - 1] : nil
            let next = index + 1 < items.count ? items[index + 1] : nil
            let showDay = previous.map { !Format.sameDay($0.createdAt, message.createdAt) } ?? true
            result[message.id] = MessageRowContext(
                message: message,
                showDay: showDay,
                grouped: !showDay && Self.continues(previous, message),
                lastInGroup: !Self.continues(message, next),
                own: message.senderId == selfId,
                isGroup: input.conversation.kind == .group,
                readUpTo: readUpTo,
                highlighted: input.highlighted == message.id,
                selecting: input.selection != nil,
                selected: input.selection?.contains(message.id) ?? false
            )
        }
        contexts = result
    }

    /// A message continues the one before it: same sender, within five minutes, the same day.
    private static func continues(_ a: MessageView?, _ b: MessageView?) -> Bool {
        guard let a, let b, a.system == nil, b.system == nil else { return false }
        return a.senderId == b.senderId && b.createdAt - a.createdAt < groupWindow && Format.sameDay(a.createdAt, b.createdAt)
    }

    // MARK: Scrolling

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        guard let input, !input.detached else { return }
        if atBottom {
            model.savedPositions[input.listKey] = nil
        } else if let top = collectionView.indexPathsForVisibleItems.max(), let id = dataSource.itemIdentifier(for: top) {
            model.savedPositions[input.listKey] = id
        }
    }

    func scrollToBottom(animated: Bool) {
        collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.adjustedContentInset.top), animated: animated)
    }

    private func handleJump() {
        guard let jump = input?.jump, jump.nonce != handledJump,
              let index = dataSource.snapshot().indexOfItem(jump.messageId) else { return }
        handledJump = jump.nonce
        collectionView.layoutIfNeeded()
        collectionView.scrollToItem(at: IndexPath(item: index, section: 0), at: .centeredVertically, animated: false)
        DispatchQueue.main.async { [weak self] in self?.onJumpHandled(jump.messageId) }
    }

    /// The first message on screen and where it is, so updates elsewhere don't move it.
    private func visibleAnchor() -> (id: String, offset: CGFloat)? {
        guard let indexPath = collectionView.indexPathsForVisibleItems.min(),
              let id = dataSource.itemIdentifier(for: indexPath),
              let attributes = collectionView.layoutAttributesForItem(at: indexPath) else { return nil }
        return (id, attributes.frame.minY - collectionView.contentOffset.y)
    }

    private func restore(_ anchor: (id: String, offset: CGFloat)) {
        guard let index = dataSource.snapshot().indexOfItem(anchor.id) else { return }
        collectionView.layoutIfNeeded()
        guard let attributes = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0)) else { return }
        collectionView.contentOffset.y = attributes.frame.minY - anchor.offset
    }

    // MARK: Swipe to reply

    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        // Not while picking messages, where a tap picks one.
        if input?.selection != nil { return false }
        guard let pan = gesture as? UIPanGestureRecognizer else { return true }
        let velocity = pan.velocity(in: collectionView)
        // Only a mostly sideways swipe to the left, so scrolling stays as it was.
        return velocity.x < 0 && abs(velocity.x) > abs(velocity.y) * 1.5
    }

    @objc private func swiped(_ gesture: UIPanGestureRecognizer) {
        let threshold: CGFloat = 64
        switch gesture.state {
        case .began:
            let point = gesture.location(in: collectionView)
            guard let indexPath = collectionView.indexPathForItem(at: point),
                  let cell = collectionView.cellForItem(at: indexPath),
                  let id = dataSource.itemIdentifier(for: indexPath),
                  let message = input?.items.first(where: { $0.id == id }),
                  message.seq != nil, message.deletedAt == nil, message.status == .sent, message.system == nil else { return }
            swiping = (cell, message)
        case .changed:
            guard let swiping else { return }
            let offset = max(-threshold * 1.4, min(0, gesture.translation(in: collectionView).x))
            swiping.cell.contentView.transform = Self.flip.translatedBy(x: offset, y: 0)
            let frame = swiping.cell.convert(swiping.cell.bounds, to: view)
            replyIcon.center = CGPoint(x: frame.maxX - 26, y: frame.midY)
            replyIcon.alpha = min(1, -offset / threshold)
        case .ended, .cancelled, .failed:
            guard let swiping else { return }
            self.swiping = nil
            if gesture.state == .ended, gesture.translation(in: collectionView).x <= -threshold {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                input?.actions.reply(swiping.message)
            }
            UIView.animate(withDuration: 0.2) {
                swiping.cell.contentView.transform = Self.flip
                self.replyIcon.alpha = 0
            }
        default:
            break
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let bottom = scrollView.contentOffset.y <= -scrollView.adjustedContentInset.top + 64
        // Scrolling also happens while SwiftUI updates the list, when its state can't change, so these wait a turn.
        if bottom != atBottom {
            atBottom = bottom
            DispatchQueue.main.async { [weak self] in self?.onAtBottomChange(bottom) }
        }
        let remaining = scrollView.contentSize.height - (scrollView.contentOffset.y + scrollView.bounds.height)
        if remaining < 800 {
            DispatchQueue.main.async { [weak self] in self?.onNearOldest() }
        }
    }
}

/// Upside down, the cells' order is newest first; VoiceOver reads them top to bottom, as they look.
private final class ChatCollectionView: UICollectionView {
    private var cellsOnScreen: [UICollectionViewCell] {
        visibleCells.sorted { $0.convert($0.bounds, to: nil).minY < $1.convert($1.bounds, to: nil).minY }
    }

    override func accessibilityElementCount() -> Int {
        cellsOnScreen.count
    }

    override func accessibilityElement(at index: Int) -> Any? {
        let cells = cellsOnScreen
        return cells.indices.contains(index) ? cells[index] : nil
    }

    override func index(ofAccessibilityElement element: Any) -> Int {
        guard let cell = element as? UICollectionViewCell else { return NSNotFound }
        return cellsOnScreen.firstIndex(of: cell) ?? NSNotFound
    }
}

/// The list in SwiftUI.
struct MessageListView: UIViewControllerRepresentable {
    @Environment(AppModel.self) private var model
    @Environment(ImageStore.self) private var images
    let input: MessageListController.Input
    let bridge: MessageListBridge
    let onAtBottomChange: (Bool) -> Void
    let onNearOldest: () -> Void
    let onJumpHandled: (String) -> Void

    func makeUIViewController(context: Context) -> MessageListController {
        let controller = MessageListController()
        controller.model = model
        controller.images = images
        bridge.scrollToBottom = { [weak controller] in controller?.scrollToBottom(animated: true) }
        return controller
    }

    func updateUIViewController(_ controller: MessageListController, context: Context) {
        controller.onAtBottomChange = onAtBottomChange
        controller.onNearOldest = onNearOldest
        controller.onJumpHandled = onJumpHandled
        controller.update(input)
    }
}
