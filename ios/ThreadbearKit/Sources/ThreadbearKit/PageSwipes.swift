import CoreGraphics

/// Forward, as in a browser, for the phone's stack of open threads. The
/// stack is already Back: going back pops it. What's popped is kept here, so
/// a swipe left on a thread can open it again, like the Mac's swipes
/// (Mike, 8 Nov: "swipe left and swipe right on the thread's text to go
/// back and forward, kind of like we do on the desktop").
public struct ForwardStack: Sendable, Equatable {
    /// Last is the next one forward.
    public private(set) var ids: [String] = []

    public init(ids: [String] = []) { self.ids = ids }

    /// Where a swipe left goes, if anywhere.
    public var next: String? { ids.last }

    /// The navigation path went from `old` to `new`, however it got there.
    public mutating func pathChanged(from old: [String], to new: [String]) {
        if new.count < old.count, Array(old.prefix(new.count)) == new {
            // Back, one or more: the nearest comes forward first.
            ids.append(contentsOf: old[new.count...].reversed())
        } else if new.count == old.count + 1, Array(new.prefix(old.count)) == old, new.last == ids.last {
            // Forward, by a swipe or by opening that same thread again,
            // which is the same step, so what's beyond it stays.
            ids.removeLast()
        } else if new != old {
            // Somewhere new: as in a browser, there's no forward from here.
            ids = []
        }
    }
}

/// A page swipe's progress: how far the finger's gone towards the line
/// where letting go goes Back or Forward.
public enum PageSwipe {
    /// Letting go past this far goes; short of it, nothing happens.
    public static let line: CGFloat = 110

    /// 0 to 1, full at the line.
    public static func progress(_ translation: CGFloat) -> CGFloat {
        min(1, max(0, abs(translation) / line))
    }

    /// Clearly sideways rather than a scroll: the way the Mac tells them apart
    /// before it commits to either.
    public static func isSideways(_ velocity: CGPoint) -> Bool {
        abs(velocity.x) > abs(velocity.y) * 1.5
    }

    /// A horizontally scrolling block (code, a table) under the finger that
    /// can still scroll the way it's going keeps the swipe, so it scrolls
    /// rather than leaving the page. `forward` is a swipe left, which scrolls
    /// the content towards its end.
    public static func scrollerKeeps(forward: Bool, offset: CGFloat, contentWidth: CGFloat, width: CGFloat) -> Bool {
        let end = contentWidth - width
        guard end > 1 else { return false }
        return forward ? offset < end - 1 : offset > 1
    }
}
