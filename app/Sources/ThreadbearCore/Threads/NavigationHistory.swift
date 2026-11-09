/// Back and forward through the places Mike has been in the window, as a
/// browser keeps them: going somewhere new drops whatever was ahead.
/// `Place` is the app's (the sidebar view, the thread, the sub-agent and
/// the project page); this only keeps the order.
public struct NavigationHistory<Place: Equatable>: Sendable where Place: Sendable {
    public private(set) var entries: [Place] = []
    /// The entry showing now; -1 while there are none.
    public private(set) var index = -1
    public let limit: Int

    public init(limit: Int = 100) {
        self.limit = limit
    }

    public var current: Place? { entries.indices.contains(index) ? entries[index] : nil }
    public var canGoBack: Bool { index > 0 }
    public var canGoForward: Bool { index < entries.count - 1 }

    /// Notes where the window is now. Being where it already is (as after
    /// going back, once the app has caught up) adds nothing.
    public mutating func record(_ place: Place) {
        guard place != current else { return }
        entries.removeSubrange((index + 1)...)
        entries.append(place)
        if entries.count > limit { entries.removeFirst(entries.count - limit) }
        index = entries.count - 1
    }

    /// Puts `place` where the current entry is, for a place that's turned
    /// into another: the new-thread screen once its thread has started.
    /// Back from it then goes to wherever was before, not to what it was.
    /// Like going somewhere new, it drops whatever was ahead.
    public mutating func replaceCurrent(with place: Place) {
        guard current != nil else { return record(place) }
        entries.removeSubrange((index + 1)...)
        entries[index] = place
        // Never the same place twice in a row, as `record` keeps it.
        if index > 0, entries[index - 1] == place {
            entries.removeLast()
            index -= 1
        }
    }

    /// The nearest earlier place that `isValid` still allows (a thread
    /// that's been deleted, say, is skipped), or nil with nowhere to go.
    public mutating func back(where isValid: (Place) -> Bool = { _ in true }) -> Place? {
        step(by: -1, where: isValid)
    }

    public mutating func forward(where isValid: (Place) -> Bool = { _ in true }) -> Place? {
        step(by: 1, where: isValid)
    }

    /// Where `back` or `forward` would go, without going: what a swipe's
    /// card names before the fingers lift.
    public func peek(back: Bool, where isValid: (Place) -> Bool = { _ in true }) -> Place? {
        var copy = self
        return back ? copy.back(where: isValid) : copy.forward(where: isValid)
    }

    private mutating func step(by delta: Int, where isValid: (Place) -> Bool) -> Place? {
        var next = index + delta
        while entries.indices.contains(next) {
            if isValid(entries[next]) {
                index = next
                return entries[next]
            }
            next += delta
        }
        return nil
    }
}
