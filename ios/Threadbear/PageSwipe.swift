import SwiftUI
import ThreadbearKit
import UIKit

/// Where a swipe left on a thread goes: the thread last backed out of
/// (InboxView's ForwardStack), and how to open it.
struct PageForward {
    let threadId: String
    let go: @MainActor () -> Void
}

extension EnvironmentValues {
    @Entry var pageForward: PageForward?
}

/// A page swipe under way.
struct PageDrag: Equatable {
    var forward: Bool
    var progress: CGFloat
    var armed: Bool { progress >= 1 }
}

/// Swipe left on a thread's messages to go Forward, right to go Back, as
/// the Mac's trackpad swipes do, with the same card in the middle saying
/// where letting go will land (Mike picked it for the Mac on 8 Nov).
///
/// From iOS 26 the system already pops on a swipe right anywhere on the
/// page, sliding the inbox in under the finger, so Back is left to it there
/// and this only does Forward. Before 26 Back is the edge only, so this
/// does both.
struct PageSwipes: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(\.pageForward) private var forward
    @Environment(\.dismiss) private var dismiss
    @State private var drag: PageDrag?

    private static var doesBack: Bool {
        if #available(iOS 26, *) { false } else { true }
    }

    func body(content: Content) -> some View {
        content
            .gesture(PagePan(canBack: Self.doesBack, canForward: forward != nil, drag: $drag) { forward in
                if forward { self.forward?.go() } else { dismiss() }
            })
            .overlay {
                if let drag, let place = destination(forward: drag.forward) {
                    PageSwipeCard(forward: drag.forward, title: place.title, detail: place.detail, drag: drag)
                        // In as soon as it's clear it's a swipe, not with the line.
                        .opacity(min(1, 0.4 + drag.progress * 2))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .sensoryFeedback(.impact(weight: .light), trigger: drag?.armed == true) { _, armed in armed }
            .accessibilityActions {
                if let forward { Button("Forward") { forward.go() } }
            }
            .onAppear {
                // `-ThreadbearSwipeCard`: the card held at the line, for screenshots.
                if ProcessInfo.processInfo.arguments.contains("-ThreadbearSwipeCard"), forward != nil {
                    drag = PageDrag(forward: true, progress: 1)
                }
            }
    }

    private func destination(forward: Bool) -> (title: String, detail: String?)? {
        guard forward else { return ("Inbox", nil) }
        guard let id = self.forward?.threadId else { return nil }
        guard let thread = model.knownThread(id) else { return ("Thread", nil) }
        return (thread.title.isEmpty ? "Untitled" : thread.title, thread.placeText)
    }
}

extension View {
    func pageSwipes() -> some View { modifier(PageSwipes()) }
}

/// The Mac's SwipeNavigationArrow card, at the phone's sizes.
private struct PageSwipeCard: View {
    let forward: Bool
    let title: String
    let detail: String?
    let drag: PageDrag

    var body: some View {
        let armed = drag.armed
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: forward ? "chevron.right" : "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(armed ? Color.white : Color.secondary)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(armed ? Color.accentColor : Color.primary.opacity(0.08)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(forward ? "Forward to" : "Back to")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(armed ? Color.accentColor : Color.primary.opacity(0.45))
                        .frame(width: geo.size.width * drag.progress)
                }
            }
            .frame(height: 3)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .frame(maxWidth: 320)
        .background {
            shape.fill(.regularMaterial)
                .shadow(color: .black.opacity(0.3), radius: 20, y: 6)
        }
        .overlay(shape.strokeBorder(armed ? Color.accentColor : Color(uiColor: .separator), lineWidth: armed ? 1 : 0.5))
        .padding(.horizontal, 32)
        .animation(Juice.card, value: armed)
    }
}

/// The pan behind PageSwipes. A UIKit recognizer rather than a SwiftUI
/// DragGesture, so it can decline before it starts: anything not clearly
/// sideways stays the thread's scroll, and a code block or table that can
/// still scroll the way the finger's going keeps it.
private struct PagePan: UIGestureRecognizerRepresentable {
    var canBack: Bool
    var canForward: Bool
    @Binding var drag: PageDrag?
    var go: (_ forward: Bool) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func updateUIGestureRecognizer(_ pan: UIPanGestureRecognizer, context: Context) {
        context.coordinator.canBack = canBack
        context.coordinator.canForward = canForward
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        let coordinator = context.coordinator
        switch pan.state {
        case .began:
            // The page stops scrolling under a sideways swipe.
            coordinator.scrolls.forEach { $0.isEnabled = false; $0.isEnabled = true }
            fallthrough
        case .changed:
            let forward = coordinator.forward
            let x = pan.translation(in: pan.view).x
            // Only the way it started counts: swung back past where it began is nothing.
            drag = PageDrag(forward: forward, progress: PageSwipe.progress(forward ? min(0, x) : max(0, x)))
        case .ended:
            let done = drag
            drag = nil
            coordinator.scrolls = []
            if let done, done.armed { go(done.forward) }
        default:
            drag = nil
            coordinator.scrolls = []
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var canBack = false
        var canForward = false
        /// Which way the swipe under way started.
        var forward = false
        /// The scroll views' own pans running alongside, cancelled once this starts.
        var scrolls: [UIGestureRecognizer] = []

        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer, let view = pan.view else { return false }
            let velocity = pan.velocity(in: view)
            guard PageSwipe.isSideways(velocity) else { return false }
            let forward = velocity.x < 0
            guard forward ? canForward : canBack else { return false }
            var under = view.hitTest(pan.location(in: view), with: nil)
            while let v = under {
                if let scroller = v as? UIScrollView,
                   PageSwipe.scrollerKeeps(forward: forward, offset: scroller.contentOffset.x + scroller.adjustedContentInset.left,
                                           contentWidth: scroller.contentSize.width + scroller.adjustedContentInset.left + scroller.adjustedContentInset.right,
                                           width: scroller.bounds.width) {
                    return false
                }
                under = v.superview
            }
            self.forward = forward
            return true
        }

        /// Alongside the page's own scrolling, which would otherwise take a
        /// sideways swipe for itself and never let this start.
        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            guard let scroller = other.view as? UIScrollView, other === scroller.panGestureRecognizer else { return false }
            if !scrolls.contains(where: { $0 === other }) { scrolls.append(other) }
            return true
        }
    }
}
