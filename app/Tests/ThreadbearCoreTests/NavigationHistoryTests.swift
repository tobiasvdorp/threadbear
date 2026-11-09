import XCTest
@testable import ThreadbearCore

final class NavigationHistoryTests: XCTestCase {
    func testBackAndForward() {
        var history = NavigationHistory<String>()
        XCTAssertFalse(history.canGoBack)
        history.record("a")
        history.record("b")
        history.record("c")
        XCTAssertEqual(history.back(), "b")
        XCTAssertEqual(history.back(), "a")
        XCTAssertNil(history.back(), "nothing before the first")
        XCTAssertEqual(history.current, "a")
        XCTAssertEqual(history.forward(), "b")
        XCTAssertEqual(history.forward(), "c")
        XCTAssertNil(history.forward())
    }

    /// Being where it already is adds nothing (as after going back), and
    /// going somewhere new from the middle drops what was ahead.
    func testRecordingFromTheMiddle() {
        var history = NavigationHistory<String>()
        for place in ["a", "b", "c"] { history.record(place) }
        _ = history.back()
        history.record("b")
        XCTAssertTrue(history.canGoForward)
        history.record("d")
        XCTAssertEqual(history.entries, ["a", "b", "d"])
        XCTAssertFalse(history.canGoForward)
    }

    /// A place that's turned into another takes its entry: Back skips
    /// what it was, and what was ahead goes, as on going somewhere new.
    func testReplacingTheCurrentPlace() {
        var history = NavigationHistory<String>()
        for place in ["a", "new", "b"] { history.record(place) }
        _ = history.back()
        history.replaceCurrent(with: "c")
        XCTAssertEqual(history.entries, ["a", "c"])
        XCTAssertFalse(history.canGoForward)
        XCTAssertEqual(history.back(), "a")

        // Turning into the place before it leaves just the one.
        history.record("new")
        history.replaceCurrent(with: "a")
        XCTAssertEqual(history.entries, ["a"])
        XCTAssertEqual(history.current, "a")

        // With nothing yet it's the first entry.
        var empty = NavigationHistory<String>()
        empty.replaceCurrent(with: "a")
        XCTAssertEqual(empty.entries, ["a"])
    }

    func testSkipsPlacesThatAreGone() {
        var history = NavigationHistory<String>()
        for place in ["a", "gone", "c"] { history.record(place) }
        XCTAssertEqual(history.back { $0 != "gone" }, "a")
        XCTAssertEqual(history.forward { $0 != "gone" }, "c")
        // With nowhere valid to go it stays put.
        XCTAssertNil(history.back { $0 == "nowhere" })
        XCTAssertEqual(history.current, "c")
    }

    func testKeepsTheNewest() {
        var history = NavigationHistory<Int>(limit: 3)
        for place in 1...5 { history.record(place) }
        XCTAssertEqual(history.entries, [3, 4, 5])
        XCTAssertEqual(history.back(), 4)
    }

    /// Peeking says where Back and Forward go, skipping what can't be
    /// shown, and moves nothing.
    func testPeekSaysWhereItWouldGoWithoutGoing() {
        var history = NavigationHistory<String>()
        for place in ["a", "b", "c"] { history.record(place) }
        XCTAssertEqual(history.peek(back: true), "b")
        XCTAssertEqual(history.peek(back: true, where: { $0 != "b" }), "a")
        XCTAssertNil(history.peek(back: false))
        XCTAssertEqual(history.current, "c")
        _ = history.back()
        XCTAssertEqual(history.peek(back: false), "c")
    }
}
