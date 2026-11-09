import Foundation

public extension InboxSections {
    /// Whether any thread is now under a different heading, or has turned up
    /// or gone. The inbox animates only for this: a list update that changes a
    /// title or a working line leaves it still, as they can come in bursts.
    func changedHeadings(to new: InboxSections) -> Bool {
        placements != new.placements
    }

    /// The threads under a heading they weren't under before: the rows to give
    /// a done tick or unread dot to as they land, not with them.
    func landed(in new: InboxSections) -> Set<String> {
        let old = placements
        return Set(new.placements.filter { old[$0.key] != $0.value }.keys)
    }

    /// The threads under a heading both before and after, but a different one:
    /// the rows that travel from one to the other (InboxView flies a picture of
    /// each between them, as the List would only fade it). One that's turned up
    /// or gone has nowhere to travel from or to, so it isn't here.
    func moves(to new: InboxSections) -> [String: InboxMove] {
        let old = placements
        var moves: [String: InboxMove] = [:]
        for (id, to) in new.placements { if let from = old[id], from != to { moves[id] = InboxMove(from: from, to: to) } }
        return moves
    }

    private var placements: [String: PhoneSection] {
        var all: [String: PhoneSection] = [:]
        for thread in starred { all[thread.threadId] = .starred }
        for thread in inbox { all[thread.threadId] = .inbox }
        for thread in running { all[thread.threadId] = .running }
        for thread in scheduled { all[thread.threadId] = .hibernating }
        return all
    }

    /// Nothing for Mike to do: what the empty view says. A thread still running
    /// or waiting on a schedule, or a star on one that doesn't need him, doesn't
    /// stop it, as they each have a heading of their own under it.
    var isInboxZero: Bool { inbox.isEmpty && needsYouCount == 0 }
}

/// A thread's row going from one heading to another (`InboxSections.moves`).
public struct InboxMove: Sendable, Equatable {
    public var from: PhoneSection
    public var to: PhoneSection

    public init(from: PhoneSection, to: PhoneSection) {
        self.from = from
        self.to = to
    }
}

/// He's just cleared the inbox (AppModel, the moment a row he took away was the
/// last), for the empty view to wave when it appears. Never on launch.
public struct InboxCleared: Sendable, Equatable {
    private var at: Date?
    /// The row's collapse comes first, and this is a moment or nothing: cleared
    /// behind a search, the view that shows later shouldn't wave at him.
    private static let lasts: TimeInterval = 2

    public init() {}

    public mutating func note(before: InboxSections, after: InboxSections, now: Date) {
        if !before.isInboxZero, after.isInboxZero { at = now }
    }

    public func isPending(now: Date) -> Bool {
        guard let at else { return false }
        return now.timeIntervalSince(at) < Self.lasts
    }

    /// Whether to wave, once.
    public mutating func take(now: Date) -> Bool {
        defer { at = nil }
        return isPending(now: now)
    }
}
