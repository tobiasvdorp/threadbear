import XCTest
@testable import ThreadbearCore

/// The arithmetic of dragging a row through a list (Settings > Runners and
/// the Runners panel, Mike, 7 and 8 Nov): which slot it's over, where the
/// other rows slide to, where the dragged one floats, and the order that
/// comes out. Rows can differ in height (a panel card with its details open).
final class ReorderDragTests: XCTestCase {
    private let drag = ReorderDrag(from: 0, count: 4, rowHeight: 40)

    func testTheSlotChangesAsTheRowPassesHalfwayOverTheNext() {
        XCTAssertEqual(drag.slot(translationY: 0), 0)
        XCTAssertEqual(drag.slot(translationY: 19), 0)
        XCTAssertEqual(drag.slot(translationY: 21), 1)
        XCTAssertEqual(drag.slot(translationY: 90), 2)
        XCTAssertEqual(ReorderDrag(from: 3, count: 4, rowHeight: 40).slot(translationY: -21), 2)
    }

    func testTheSlotStopsAtEitherEnd() {
        XCTAssertEqual(drag.slot(translationY: -500), 0)
        XCTAssertEqual(drag.slot(translationY: 5000), 3)
    }

    func testTheOtherRowsSlideToMakeRoomForTheSlot() {
        // Row 0 over slot 2: rows 1 and 2 move up one, row 3 stays.
        XCTAssertEqual(drag.restingY(ofRow: 1, slot: 2), 0)
        XCTAssertEqual(drag.restingY(ofRow: 2, slot: 2), 40)
        XCTAssertEqual(drag.restingY(ofRow: 3, slot: 2), 120)
        XCTAssertEqual(drag.slotY(2), 80)
        // Dragged upwards: the rows it passed move down one.
        let up = ReorderDrag(from: 3, count: 4, rowHeight: 40)
        XCTAssertEqual(up.restingY(ofRow: 0, slot: 1), 0)
        XCTAssertEqual(up.restingY(ofRow: 1, slot: 1), 80)
        XCTAssertEqual(up.restingY(ofRow: 2, slot: 1), 120)
    }

    func testOverItsOwnSlotNothingMoves() {
        let middle = ReorderDrag(from: 2, count: 4, rowHeight: 40)
        for row in [0, 1, 3] { XCTAssertEqual(middle.restingY(ofRow: row, slot: 2), CGFloat(row) * 40) }
    }

    func testTheDraggedRowFollowsThePointerButStaysNearTheList() {
        XCTAssertEqual(drag.draggedY(translationY: 55), 55)
        // A quarter of a row past either end, so a tilted row isn't cut off by the group.
        XCTAssertEqual(drag.draggedY(translationY: -500), -10)
        XCTAssertEqual(drag.draggedY(translationY: 5000), 130)
    }

    /// Cards of 50, 100 and 50 points with 10 between, the first dragged down.
    func testRowsOfDifferentHeightsAndTheGapsBetween() {
        let cards = ReorderDrag(from: 0, heights: [50, 100, 50], spacing: 10)
        XCTAssertEqual(cards.totalHeight, 220)
        // Its bottom edge (50 + dy) passes the tall card's middle (60 + 50) at dy 60.
        XCTAssertEqual(cards.slot(translationY: 59), 0)
        XCTAssertEqual(cards.slot(translationY: 61), 1)
        // Over slot 1 the tall card moves up to the top, and the slot is below it.
        XCTAssertEqual(cards.restingY(ofRow: 1, slot: 1), 0)
        XCTAssertEqual(cards.slotY(1), 110)
        XCTAssertEqual(cards.restingY(ofRow: 2, slot: 1), 170)
        // Past the last card's middle (170 + 25) at dy 145: the end.
        XCTAssertEqual(cards.slot(translationY: 146), 2)
        XCTAssertEqual(cards.draggedY(translationY: 5000), 220 - 50 + 12.5)
    }

    /// At rest every row is in its own place, one after another (the panel
    /// once stacked its first two cards on each other here).
    func testAtRestTheRowsFollowOneAnother() {
        let cards = ReorderDrag(from: 0, heights: [50, 100, 50], spacing: 10)
        XCTAssertEqual([0, 1, 2].map(cards.top(ofRow:)), [0, 60, 170])
    }

    func testTheOrderThatComesOut() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(ReorderDrag.moving(ids, from: 0, to: 2), ["b", "c", "a", "d"])
        XCTAssertEqual(ReorderDrag.moving(ids, from: 3, to: 0), ["d", "a", "b", "c"])
        XCTAssertEqual(ReorderDrag.moving(ids, from: 1, to: 1), ids)
    }

    /// The panel lists the runners runners.list has, which can be fewer than
    /// the order knows: a drop there keeps the rest of the order where it was.
    func testADropOnPartOfTheListKeepsTheRest() {
        XCTAssertEqual(ReorderDrag.merged(["c", "a"], into: ["a", "b", "c"]), ["c", "b", "a"])
    }
}
