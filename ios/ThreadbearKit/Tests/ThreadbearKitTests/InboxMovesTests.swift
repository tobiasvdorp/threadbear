import Foundation
import Testing
@testable import ThreadbearKit

/// What makes the inbox animate: a thread changing heading is news, so its row
/// glides. A title or a working line changing isn't, or a busy inbox would never
/// sit still under his thumb.
@Suite struct InboxMovesTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    private func thread(_ id: String, status: ThreadStatus = .idle, working: String? = nil, starred: Bool = false, title: String? = nil, ago: Double = 60) -> PhoneThread {
        PhoneThread(threadId: id, title: title ?? id, status: status, lastActivityAt: now.addingTimeInterval(-ago),
                    starredAt: starred ? now : nil, working: working)
    }
    private func sections(_ threads: PhoneThread...) -> InboxSections { InboxSections.build(threads, now: now) }

    @Test func aFinishedTurnMovesFromRunningToInbox() {
        let before = sections(thread("a", status: .running, working: "Running npm test"), thread("b"))
        let after = sections(thread("a"), thread("b"))
        #expect(before.changedHeadings(to: after))
    }

    @Test func aStarElsewhereMoves() {
        #expect(sections(thread("a")).changedHeadings(to: sections(thread("a", starred: true))))
    }

    @Test func aThreadTurningUpOrLeavingCounts() {
        #expect(sections(thread("a")).changedHeadings(to: sections(thread("a"), thread("b"))))
        #expect(sections(thread("a"), thread("b")).changedHeadings(to: sections(thread("a"))))
    }

    @Test func aFieldChangingStaysStill() {
        let before = sections(thread("a", status: .running, working: "Running npm test"), thread("b"))
        let after = sections(thread("a", status: .running, working: "Reading a file", title: "A new title"), thread("b", ago: 5))
        #expect(!before.changedHeadings(to: after))
    }

    @Test func aReorderInsideAHeadingStaysStill() {
        let before = sections(thread("a", ago: 10), thread("b", ago: 20))
        let after = sections(thread("a", ago: 30), thread("b", ago: 20))
        #expect(before.inbox.map(\.threadId) != after.inbox.map(\.threadId))
        #expect(!before.changedHeadings(to: after))
    }

    @Test func theRowsThatLandedAreTheOnesInANewHeading() {
        let before = sections(thread("a", status: .running, working: "Busy"), thread("b"), thread("c", starred: true))
        let after = sections(thread("a"), thread("b"), thread("c", starred: true), thread("d"))
        #expect(before.landed(in: after) == ["a", "d"])
        #expect(after.landed(in: after).isEmpty)
    }

    /// Starred, Inbox and Running are real sections again, so their headings
    /// stick while scrolling, and a List only fades a row from one section to
    /// another. These are the rows the inbox flies across instead.
    @Test func theRowsThatTravelAreTheOnesUnderANewHeading() {
        let before = sections(thread("a", status: .running, working: "Busy"), thread("b"), thread("c", starred: true), thread("e"))
        let after = sections(thread("a"), thread("b"), thread("c"), thread("d"), thread("e", starred: true))
        #expect(before.moves(to: after) == [
            "a": InboxMove(from: .running, to: .inbox),
            "c": InboxMove(from: .starred, to: .inbox),
            "e": InboxMove(from: .inbox, to: .starred),
        ])
        #expect(after.moves(to: after).isEmpty)
    }

    /// A new thread or one that's gone has nowhere to travel from or to: it just
    /// turns up or goes, and a new one still gets its mark popped in.
    @Test func aThreadTurningUpOrLeavingDoesntTravel() {
        let before = sections(thread("a"), thread("gone", status: .running, working: "Busy"))
        let after = sections(thread("a"), thread("new"))
        #expect(before.moves(to: after).isEmpty)
        #expect(before.landed(in: after) == ["new"])
    }

    /// Waiting on a schedule puts a row under Hibernating, which travels too.
    @Test func aScheduledRowTravelsToHibernating() {
        let wake = PhoneSchedule(id: "s", title: "Look again", whenText: "Tomorrow", threadId: "a", nextRunAt: now.addingTimeInterval(3600))
        let before = InboxSections.build([thread("a", status: .running, working: "Busy")], now: now)
        let after = InboxSections.build([thread("a")], now: now, wakes: ["a": wake])
        #expect(before.moves(to: after) == ["a": InboxMove(from: .running, to: .hibernating)])
    }
}
