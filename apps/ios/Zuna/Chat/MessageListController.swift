import SwiftUI
import UIKit
import ZunaModels

/// What the chat screen can ask of its list, and what it keeps for the list while the
/// chat is open, as the list is made again after leaving a jump.
@MainActor
final class MessageListBridge {
    var scrollToBottom: () -> Void = {}
    /// The list has been shown once, which is when it opens at the first unread message.
    var opened = false
    /// The first unread message when the chat opened, with a line above it until the chat is left.
    var unreadLine: String?
    /// The newest message that's been on screen enough to count as read. Kept here, not in
    /// the screen's state: near the oldest message, measuring rows again can move the list
    /// by one, and drawing the screen again each time moved it again, many times a second.
    var seen = 0
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
        /// Older messages are still to load, so the oldest here isn't where the chat starts.
        var hasMore: Bool
        var server: AppModel.ServerState
        var conversation: ConversationView
        var highlighted: String?
        /// The messages picked to act on together, or nil when not picking.
        var selection: [String]?
        /// The channel's message being edited where it is.
        var editing: String?
        var jump: JumpTarget?
        var actions: ChatActions
    }

    var model: AppModel!
    var images: ImageStore!
    var bridge: MessageListBridge!
    var onAtBottomChange: (Bool) -> Void = { _ in }
    var onNearOldest: () -> Void = {}
    var onJumpHandled: (String) -> Void = { _ in }
    /// The newest message that's been on screen enough to count as read.
    var onSeen: (Int) -> Void = { _ in }

    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
    private var input: Input?
    private var contexts: [String: MessageRowContext] = [:]
    private var atBottom = true
    /// The message the list opened at, kept at the top of the screen as the list gets its
    /// size, which SwiftUI gives it only after the first update, until someone scrolls.
    private var openedAt: String?
    private var placedHeight: CGFloat = 0
    /// Gliding to the newest message, which keeping the list in place would cut short, as
    /// reading on the way updates the list.
    private var scrollingDown = false
    private var seen = 0
    private var seenPending = false
    private var handledJump: Int?
    private var swiping: (cell: MessageCell, message: MessageView)?
    private let replyFeedback = UIImpactFeedbackGenerator(style: .medium)

    private static let groupWindow = 5 * 60 * 1000
    private static let flip = CGAffineTransform(scaleX: 1, y: -1)

    override func viewDidLoad() {
        super.viewDidLoad()
        let layout = ChatLayout { _, _ in
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

        let registration = UICollectionView.CellRegistration<MessageCell, String> { [weak self] cell, _, id in
            guard let self, let input, let context = contexts[id] else { return }
            // A cell taken for another message starts at rest.
            if cell.messageId != id {
                cell.messageId = id
                cell.swipe.offset = 0
                cell.swipe.armed = false
            }
            let swipe = cell.swipe
            cell.contentConfiguration = UIHostingConfiguration {
                MessageRow(context: context, server: input.server, actions: input.actions)
                    .environment(self.model)
                    .environment(self.images)
                    .environment(swipe)
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
        // A chat with unread messages opens at the first, as Telegram's does, under a line
        // that stays until the chat is left. Decided once, from what's loaded then.
        var openAt: String?
        if !bridge.opened {
            bridge.opened = true
            if !input.detached, input.conversation.unread > 0 {
                let selfId = input.server.me?.userId
                let blocked = input.server.prefs.blocked ?? []
                bridge.unreadLine = input.items.first { AppModel.isUnread($0, ownRead: input.conversation.ownRead, selfId: selfId, blocked: blocked) }?.id
                openAt = bridge.unreadLine
            }
        }
        rebuildContexts()
        let ids = input.items.reversed().map(\.id)
        let oldIds = dataSource.snapshot().itemIdentifiers
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(ids)
        let kept = Set(oldIds).intersection(ids)
        snapshot.reconfigureItems(Array(kept))

        // A new message at the bottom slides in while you're there; anything else just appears,
        // as several at once do when catching up, so the chat is at the newest straight away.
        let newAtBottom = oldIds.first.flatMap { ids.firstIndex(of: $0) } == 1
        let animate = newAtBottom && atBottom && !model.reduceMotion
        let anchor = atBottom || oldIds.isEmpty || scrollingDown ? nil : visibleAnchor()
        // Coming back to a chat that was scrolled up shows the same messages again.
        if oldIds.isEmpty, !input.detached {
            openedAt = openAt ?? model.savedPositions[input.listKey]
        }
        let apply = { [weak self] in
            guard let self else { return }
            dataSource.apply(snapshot, animatingDifferences: animate) { [weak self] in
                guard let self else { return }
                if let anchor { restore(anchor) }
                if oldIds.isEmpty { placeOpening() }
                // Sending always brings you to the newest message.
                if let newest = input.items.last, newest.id != oldIds.first, newest.senderId == input.server.me?.userId, previous != nil {
                    scrollToBottom(animated: true)
                }
                handleJump()
                if input.editing != previous?.editing { revealEditing() }
                noteSeen()
            }
        }
        // Telegram's spring, critically damped, which the list's own animation inside takes on.
        if animate { UIView.animate(springDuration: 0.267, bounce: 0, animations: apply) } else { apply() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard view.window != nil, collectionView.bounds.height != placedHeight else { return }
        placedHeight = collectionView.bounds.height
        placeOpening()
        revealEditing()
        noteSeen()
    }

    /// Keeps the message being edited in place on screen, as the keyboard comes up and the list gets shorter.
    private func revealEditing() {
        guard let id = input?.editing, let index = dataSource.snapshot().indexOfItem(id) else { return }
        let indexPath = IndexPath(item: index, section: 0)
        collectionView.layoutIfNeeded()
        guard let frame = collectionView.layoutAttributesForItem(at: indexPath)?.frame,
              !collectionView.bounds.inset(by: collectionView.adjustedContentInset).contains(frame) else { return }
        collectionView.scrollToItem(at: indexPath, at: .centeredVertically, animated: true)
    }

    /// Grouping and day separators depend on the neighbors, so every row's context is rebuilt.
    private func rebuildContexts() {
        guard let input else { return }
        let items = input.items
        let selfId = input.server.me?.userId ?? ""
        let readUpTo = input.conversation.readUpTo(selfId: selfId)
        let channel = input.conversation.kind == .channel
        var result: [String: MessageRowContext] = [:]
        for (index, message) in items.enumerated() {
            let previous = index > 0 ? items[index - 1] : nil
            let next = index + 1 < items.count ? items[index + 1] : nil
            let showDay = previous.map { !Format.sameDay($0.createdAt, message.createdAt) } ?? true
            result[message.id] = MessageRowContext(
                message: message,
                showDay: showDay,
                // In a channel a reply starts a run of its own, under its name, as in Discord.
                grouped: !showDay && !(channel && message.reply != nil) && Self.continues(previous, message),
                lastInGroup: !Self.continues(message, next),
                own: message.senderId == selfId,
                isGroup: input.conversation.kind != .dm,
                readUpTo: readUpTo,
                unreadLine: message.id == bridge.unreadLine,
                highlighted: input.highlighted == message.id,
                selecting: input.selection != nil,
                selected: input.selection?.contains(message.id) ?? false,
                channel: channel,
                startOfChat: index == 0 && !input.hasMore && !input.detached,
                editing: input.editing == message.id
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
        openedAt = nil
        let bottom = CGPoint(x: 0, y: -collectionView.adjustedContentInset.top)
        scrollingDown = animated && collectionView.contentOffset != bottom
        collectionView.setContentOffset(bottom, animated: animated)
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        scrollingDown = false
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        openedAt = nil
        scrollingDown = false
    }

    private func handleJump() {
        guard let jump = input?.jump, jump.nonce != handledJump,
              let index = dataSource.snapshot().indexOfItem(jump.messageId) else { return }
        handledJump = jump.nonce
        openedAt = nil
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

    /// Puts the message the list opened at at the top of the screen, or as near as the list
    /// goes. The rows on the way settle their sizes as they're laid out, so a second pass puts it right.
    private func placeOpening() {
        guard let openedAt, let index = dataSource.snapshot().indexOfItem(openedAt) else { return }
        for _ in 0..<2 {
            collectionView.layoutIfNeeded()
            guard let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return }
            let inset = collectionView.adjustedContentInset
            let lowest = -inset.top
            let highest = max(lowest, collectionView.contentSize.height + inset.bottom - collectionView.bounds.height)
            // Upside down, the top of the screen is the bottom of the scroll view.
            collectionView.contentOffset.y = min(max(frame.maxY - collectionView.bounds.height, lowest), highest)
        }
    }

    /// Tells the screen the newest message that's been on screen enough to count as read:
    /// all of it, or most of the screen, as on the desktop. At the newest message, everything.
    private func noteSeen() {
        // Before the list is on screen it has no size of its own yet.
        guard view.window != nil, placedHeight > 0, let input else { return }
        var newest = 0
        if atBottom, !input.detached {
            newest = input.items.last { $0.seq != nil && !$0.id.hasPrefix("sys-") }?.seq ?? 0
        } else {
            // Upside down, a row's bottom on screen is the top of its frame.
            let bounds = collectionView.bounds
            for indexPath in collectionView.indexPathsForVisibleItems {
                guard let frame = collectionView.layoutAttributesForItem(at: indexPath)?.frame,
                      frame.maxY > bounds.minY, frame.minY < bounds.maxY,
                      frame.minY >= bounds.minY - 1 || frame.maxY >= bounds.midY,
                      let id = dataSource.itemIdentifier(for: indexPath), !id.hasPrefix("sys-"),
                      let seq = contexts[id]?.message.seq else { continue }
                newest = max(newest, seq)
            }
        }
        guard newest != seen else { return }
        seen = newest
        // Once a turn, with where the list ended up: it passes other places as it settles.
        guard !seenPending else { return }
        seenPending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            seenPending = false
            onSeen(seen)
        }
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

    /// The row follows through its `RowSwipe`: a transform on the cell's content view
    /// doesn't last, as the cell sets that view's frame again whenever it lays out.
    @objc private func swiped(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            let point = gesture.location(in: collectionView)
            guard let indexPath = collectionView.indexPathForItem(at: point),
                  let cell = collectionView.cellForItem(at: indexPath) as? MessageCell,
                  let id = dataSource.itemIdentifier(for: indexPath),
                  let message = input?.items.first(where: { $0.id == id }),
                  message.seq != nil, message.deletedAt == nil, message.status == .sent, message.system == nil else { return }
            swiping = (cell, message)
            replyFeedback.prepare()
        case .changed:
            guard let swiping, swiping.cell.messageId == swiping.message.id else { return }
            let threshold = RowSwipe.threshold
            let pull = max(0, -gesture.translation(in: collectionView).x)
            // Under the finger to the threshold, then less and less, as Telegram's does.
            let shown = pull <= threshold ? pull : threshold + (1 - 1 / ((pull - threshold) * 0.4 / 600 + 1)) * 600
            let swipe = swiping.cell.swipe
            swipe.offset = -shown
            if (pull >= threshold) != swipe.armed {
                swipe.armed.toggle()
                // Felt as it passes the threshold, so it's known that letting go answers.
                if swipe.armed { replyFeedback.impactOccurred() }
            }
        case .ended, .cancelled, .failed:
            guard let swiping else { return }
            self.swiping = nil
            let swipe = swiping.cell.swipe
            if gesture.state == .ended, swipe.armed, swiping.cell.messageId == swiping.message.id {
                input?.actions.reply(swiping.message)
            }
            withAnimation(.smooth(duration: 0.3)) {
                swipe.offset = 0
                swipe.armed = false
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
        noteSeen()
        let remaining = scrollView.contentSize.height - (scrollView.contentOffset.y + scrollView.bounds.height)
        if remaining < 800 {
            DispatchQueue.main.async { [weak self] in self?.onNearOldest() }
        }
    }
}

/// The list's layout, which brings a new message up from under the composer, as Telegram's
/// does, instead of fading it in where it lands.
private final class ChatLayout: UICollectionViewCompositionalLayout {
    private var inserted: Set<IndexPath> = []

    override func prepare(forCollectionViewUpdates updateItems: [UICollectionViewUpdateItem]) {
        super.prepare(forCollectionViewUpdates: updateItems)
        inserted = Set(updateItems.compactMap { $0.updateAction == .insert ? $0.indexPathAfterUpdate : nil })
    }

    override func finalizeCollectionViewUpdates() {
        super.finalizeCollectionViewUpdates()
        inserted = []
    }

    override func initialLayoutAttributesForAppearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let attributes = super.initialLayoutAttributesForAppearingItem(at: itemIndexPath)
        guard inserted.contains(itemIndexPath), let below = attributes?.copy() as? UICollectionViewLayoutAttributes else { return attributes }
        // Upside down, below on screen is up here. From further than its height, as in Telegram,
        // so it comes up a little behind the messages it pushes. Moved by a transform, as the
        // cell taking its size puts its frame back where it lands.
        below.transform = CGAffineTransform(translationX: 0, y: -below.size.height * 1.6)
        return below
    }
}

/// A message's cell, which keeps how far its message is pulled to answer it.
private final class MessageCell: UICollectionViewCell {
    let swipe = RowSwipe()
    var messageId: String?
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
    let onSeen: (Int) -> Void

    func makeUIViewController(context: Context) -> MessageListController {
        let controller = MessageListController()
        controller.model = model
        controller.images = images
        controller.bridge = bridge
        bridge.scrollToBottom = { [weak controller] in controller?.scrollToBottom(animated: true) }
        return controller
    }

    func updateUIViewController(_ controller: MessageListController, context: Context) {
        controller.onAtBottomChange = onAtBottomChange
        controller.onNearOldest = onNearOldest
        controller.onJumpHandled = onJumpHandled
        controller.onSeen = onSeen
        controller.update(input)
    }
}
