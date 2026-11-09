import AppKit
import SwiftUI
import ThreadbearCore
import WebKit

/// Trackpad swipes going back and forward, as in Safari: two fingers (or a
/// Magic Mouse's one) across the main window, when System Settings has
/// "Swipe between pages" on for scrolling, and three-finger swipes when
/// it's set to three fingers, which AppKit sends as swipe events instead.
/// The mouse's side buttons are `MouseNavigation`.
///
/// It works like a sidebar row's swipe: an arrow at the window's edge
/// follows the fingers and fills at the line, and letting go past it goes
/// (`NavigationSwipe`, `SwipeNavigationArrow`). AppKit's own swipe tracking
/// (`trackSwipeEvent`) replaced this for a day on 7 Nov and did nothing on
/// Mike's trackpad, with no arrow, so these are ours from end to end.
///
/// A gesture is held back from the view under the pointer until it's clear
/// which way it's going, from the fingers touching on, and handed on if it's
/// a scroll, as WebKit does. A scroll view that can scroll, given any of a
/// gesture, takes the rest straight from the system: no monitor sees it
/// again, its end included. That's why a long thread's scrolling "takes over
/// quite easily" (Mike, 6 Nov) and a short thread's doesn't, and it's the
/// reason for `missedTheStart` too: the start of the next gesture can go the
/// same way (seen with real events on Tinker Desk, 7 Nov).
///
/// Over a sidebar row nothing's held back, as the row (RowSwipeController)
/// needs the whole gesture: a swipe left is its archive, and it gives up a
/// swipe the other way to Back or Forward while there's somewhere to go
/// (`takesFingersRight`).
///
/// Which way is Back follows System Settings' natural scrolling, as Safari's
/// does: the page moves with the content, so with natural scrolling fingers
/// going right go Back, and without it fingers going left do. The first
/// version always went Back to the right, backwards for Mike, who has natural
/// scrolling off (8 Nov).
@MainActor
@Observable
final class SwipeNavigation {
    static let shared = SwipeNavigation()

    private(set) var swipe = NavigationSwipe()
    /// Natural scrolling, for the gesture under way: the content and the
    /// fingers go the same way. The card fills the way the fingers go.
    private(set) var natural = true
    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored private var monitor: Any?
    /// The events held back while deciding, to hand on if it's a scroll.
    @ObservationIgnored private var held: [NSEvent] = []
    @ObservationIgnored private weak var heldWindow: NSWindow?
    /// Handing those on: they're on their way, not new.
    @ObservationIgnored private var replaying = false
    /// After a page swipe the trackpad keeps sending momentum events;
    /// they're ours too, or whatever's under the pointer would scroll.
    @ObservationIgnored private var eatingMomentum = false
    /// The fingers have touched and this gesture's already begun here;
    /// its `began` is only the first movement.
    @ObservationIgnored private var touched = false
    /// When the last scroll event got here, to tell a new gesture from
    /// more of one a scroll view has had since.
    @ObservationIgnored private var lastEvent: TimeInterval = 0
    /// System Settings' "Swipe between pages" with two fingers; a test's own.
    @ObservationIgnored var scrollSwipesOn: () -> Bool = { NSEvent.isSwipeTrackingFromScrollEventsEnabled }

    func install(app: AppModel) {
        guard monitor == nil else { return }
        self.app = app
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .swipe]) { [weak self] event in
            guard let self else { return event }
            return self.handle(event, in: event.window) ? nil : event
        }
        // The lift goes to whichever app is in front by then.
        NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.cancel()
                RowSwipeController.listening?.cancelGesture()
            }
        }
    }

    /// Whether fingers going right go Back or Forward just now: a row
    /// deciding what a swipe is asks, so the two never both take it.
    /// `inverted`: natural scrolling, where that's Back.
    func takesFingersRight(inverted: Bool) -> Bool {
        guard scrollSwipesOn(), let app else { return false }
        return inverted ? app.canGoBack : app.canGoForward
    }

    /// Whether the event was ours (held back, or a page swipe's).
    func handle(_ event: NSEvent, in window: NSWindow?) -> Bool {
        guard !replaying, let app else { return false }
        guard let window, window === MainWindowFrame.window else {
            // A sheet or another window has the gesture now, so the lift
            // won't come here.
            if event.type == .scrollWheel { cancel() }
            return false
        }
        if event.type == .swipe { return threeFingers(event, in: window, app: app) }
        if !event.momentumPhase.isEmpty {
            guard eatingMomentum else { return false }
            if event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) { eatingMomentum = false }
            return true
        }
        // A mouse wheel has no phases, and Shift-scrolling one sideways
        // isn't a swipe.
        guard event.hasPreciseScrollingDeltas, !event.phase.isEmpty else { return false }
        defer { lastEvent = event.timestamp }
        if event.phase.contains(.mayBegin) {
            start(event, in: window, app: app)
            touched = true
            guard swipe.phase == .deciding, swipe.holds else { return false }
            hold(event, in: window)
            return true
        }
        if event.phase.contains(.began) {
            if !touched || swipe.phase != .deciding { start(event, in: window, app: app) }
            touched = false
        } else if event.phase.contains(.changed), missedTheStart(event) {
            start(event, in: window, app: app)
        }
        if event.phase.contains(.began) || event.phase.contains(.changed) {
            return moved(event, in: window)
        }
        if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            touched = false
            let wasTracking = swipe.direction != nil
            let holds = swipe.holds
            let stillMoving = event.timestamp - lastEvent < Self.flickGap
            let to = withAnimation(.easeOut(duration: 0.15)) {
                event.phase.contains(.ended) ? swipe.end(stillMoving: stillMoving) : { swipe.reset(); return nil }()
            }
            // Lifted before it was clear: a tap's worth, the view's to have.
            release()
            go(to, app: app)
            eatingMomentum = wasTracking
            // Over a row the row has seen the gesture start, and needs its
            // end to stop listening; otherwise the view under the pointer
            // never saw this one start.
            return wasTracking && holds
        }
        return swipe.direction != nil
    }

    private func start(_ event: NSEvent, in window: NSWindow, app: AppModel) {
        eatingMomentum = false
        release()
        guard scrollSwipesOn() else { return swipe.reset() }
        natural = event.isDirectionInvertedFromDevice
        // A row only ever lets fingers going right by.
        let overRow = RowSwipeController.listening?.isHovered == true
        let free = freeWays(at: event.locationInWindow, in: window, scrolls: true)
        let ways = free.intersection(historyWays(app))
        let fingersRight: NavigationSwipe.Direction = event.isDirectionInvertedFromDevice ? .back : .forward
        // Over a row, a way with nowhere to go is the row's (it gives a
        // little and stops); elsewhere the card says there's nowhere to go.
        swipe.begin(allowed: overRow ? ways.intersection([fingersRight]) : ways,
                    empty: overRow ? [] : free.subtracting(ways), holds: !overRow)
    }

    /// A movement with no gesture under way, or after a scroll that went
    /// quiet here because the scroll view took it, is a new gesture whose
    /// start the scroll view had. Left as more of the old scroll, it would
    /// be passed on, and the scroll view would have this one as well.
    private func missedTheStart(_ event: NSEvent) -> Bool {
        switch swipe.phase {
        case .idle: return true
        case .ignoring: return event.timestamp - lastEvent > Self.quietGap
        case .deciding, .tracking: return false
        }
    }

    /// Longer than any gap between one gesture's events (fingers still on
    /// the trackpad send none, and then it's a fresh decision anyway).
    private static let quietGap: TimeInterval = 0.2
    /// Longer than this between the last movement and the lift isn't a flick.
    private static let flickGap: TimeInterval = 0.1

    private func moved(_ event: NSEvent, in window: NSWindow) -> Bool {
        // The content's way, right positive (Back), as the system scrolls
        // it: the fingers' way with natural scrolling, the other way without.
        let wasArmed = swipe.armed
        let verdict = withAnimation(nil) {
            swipe.move(dx: Double(event.scrollingDeltaX), dy: Double(event.scrollingDeltaY), elapsed: event.timestamp - lastEvent)
        }
        if swipe.armed != wasArmed {
            // A tick under the fingers on crossing the line, as a row's.
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        }
        switch verdict {
        case .wait:
            guard swipe.holds else { return false }
            hold(event, in: window)
            return true
        case .scroll:
            release()
            return false
        case .swipe:
            held = []
            return true
        }
    }

    private func hold(_ event: NSEvent, in window: NSWindow) {
        held.append(event)
        heldWindow = window
    }

    /// Hands the held events on to the view under the pointer, in order,
    /// before the one that showed it's a scroll. To the window they were
    /// for, which could be gone by now.
    private func release() {
        let events = held
        held = []
        guard let window = heldWindow, !events.isEmpty else { return }
        heldWindow = nil
        replaying = true
        for event in events { window.sendEvent(event) }
        replaying = false
    }

    /// The gesture's over and its lift won't come here.
    private func cancel() {
        guard swipe.phase != .idle || !held.isEmpty || touched || eatingMomentum else { return }
        held = []
        heldWindow = nil
        touched = false
        eatingMomentum = false
        withAnimation(.easeOut(duration: 0.15)) { swipe.reset() }
    }

    /// AppKit's swipe event, one per gesture: a positive deltaX is the
    /// fingers going left, which is Forward, as Safari has it.
    private func threeFingers(_ event: NSEvent, in window: NSWindow, app: AppModel) -> Bool {
        let ways = freeWays(at: event.locationInWindow, in: window, scrolls: false).intersection(historyWays(app))
        if event.deltaX < 0, ways.contains(.back) { go(.back, app: app); return true }
        if event.deltaX > 0, ways.contains(.forward) { go(.forward, app: app); return true }
        return false
    }

    private func go(_ direction: NavigationSwipe.Direction?, app: AppModel) {
        switch direction {
        case .back: app.goBack()
        case .forward: app.goForward()
        case nil: break
        }
    }

    private func historyWays(_ app: AppModel) -> Set<NavigationSwipe.Direction> {
        var ways: Set<NavigationSwipe.Direction> = []
        if app.canGoBack { ways.insert(.back) }
        if app.canGoForward { ways.insert(.forward) }
        return ways
    }

    /// The ways a swipe at `point` is the window's rather than what's under
    /// the pointer: nothing there scrolls sideways that way first (a wide
    /// table, a row of chips), as Safari leaves a wide page to scroll until
    /// it's at its edge. Back moves the content right, which shows what's to
    /// its left, whichever way the system scrolls. A web page in a panel
    /// keeps every swipe, as it scrolls (and goes back) by itself.
    /// `scrolls`: false for a three-finger swipe, which doesn't scroll
    /// anything, so only a web page can want it first.
    private func freeWays(at point: NSPoint, in window: NSWindow, scrolls: Bool) -> Set<NavigationSwipe.Direction> {
        var ways: Set<NavigationSwipe.Direction> = [.back, .forward]
        // The frame view has no superview, so the window's point is its own.
        var view = (window.contentView?.superview ?? window.contentView)?.hitTest(point)
        while let v = view, !ways.isEmpty {
            if v is WKWebView { return [] }
            if scrolls, let scroll = v as? NSScrollView, let document = scroll.documentView {
                let shown = scroll.contentView.bounds
                if document.frame.width > shown.width + 1 {
                    if shown.minX > 0.5 { ways.remove(.back) }
                    if shown.maxX < document.frame.width - 0.5 { ways.remove(.forward) }
                }
            }
            view = v.superview
        }
        return ways
    }
}

/// The card in the middle of the window while a page swipe is under way:
/// which thread or page letting go will open. The card fills as the fingers
/// go, from the side they start on, and is blue at the line. Mike picked the
/// card from four designs on 8 Nov for saying where Back goes, as it crosses
/// views; its first bar filled left to right whichever way he swiped, which
/// he found confusing, and he picked this fill from four more the same day.
struct SwipeNavigationArrow: View {
    @Environment(AppModel.self) private var app
    private var nav: SwipeNavigation { SwipeNavigation.shared }

    var body: some View {
        if let direction = nav.swipe.direction {
            let back = direction == .back
            // Nowhere to go: said, rather than nothing showing at all.
            let place = app.destination(back: back) ?? (back ? "Nothing to go back to" : "Nothing to go forward to", nil)
            card(back: back, place: place, empty: nav.swipe.isEmpty || app.destination(back: back) == nil)
                // In as soon as it's clear it's a swipe, not with the line.
                // A nowhere-to-go card only gives a little, so it's solid at once.
                .opacity(nav.swipe.isEmpty ? 1 : min(1, 0.4 + nav.swipe.progress * 2))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    private func card(back: Bool, place: (title: String, detail: String?), empty: Bool) -> some View {
        let armed = nav.swipe.armed
        let accent = Color(nsColor: .controlAccentColor)
        let shape = RoundedRectangle(cornerRadius: zoomed(14), style: .continuous)
        // Back moves the content right; the fingers go that way too with
        // natural scrolling, the other way without.
        let fingersLeft = back != nav.natural
        return HStack(spacing: zoomed(12)) {
            Image(systemName: back ? "chevron.left" : "chevron.right")
                .font(.system(size: zoomed(14), weight: .semibold))
                .foregroundStyle(armed ? Color.white : Color.secondary)
                .frame(width: zoomed(34), height: zoomed(34))
                .background(Circle().fill(armed ? accent : Color.primary.opacity(0.08)))
            VStack(alignment: .leading, spacing: zoomed(2)) {
                if !empty {
                    Text(back ? "Back to" : "Forward to")
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                }
                Text(place.title)
                    .font(.system(size: zoomed(14), weight: empty ? .regular : .semibold))
                    .foregroundStyle(empty ? Color.secondary : Color.primary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = place.detail {
                    Text(detail)
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, zoomed(18))
        .padding(.vertical, zoomed(16))
        .frame(width: zoomed(340))
        .background {
            // The fill, from the side the fingers start on.
            GeometryReader { geo in
                Rectangle()
                    .fill(armed ? accent.opacity(0.32) : Color.primary.opacity(0.07))
                    .frame(width: geo.size.width * nav.swipe.progress)
                    .frame(maxWidth: .infinity, alignment: fingersLeft ? .trailing : .leading)
            }
            .clipShape(shape)
        }
        .background {
            // Solid: the transcript mustn't show through behind the name.
            shape.fill(Color(nsColor: .windowBackgroundColor))
                .shadow(color: .black.opacity(0.4), radius: zoomed(20), y: zoomed(6))
        }
        .overlay(shape.strokeBorder(armed ? accent : Color(nsColor: .separatorColor), lineWidth: armed ? 1 : 0.5))
        .animation(Juice.hover, value: armed)
    }
}
