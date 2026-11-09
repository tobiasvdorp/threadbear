import CoreGraphics
import Testing
@testable import ThreadbearKit

/// Swipe left on a thread to go forward to the one you just backed out of.
@Suite struct PageSwipesTests {
    @Test func goingBackKeepsWhatWasPoppedNearestFirst() {
        var forward = ForwardStack()
        forward.pathChanged(from: ["a", "b", "c"], to: ["a"])
        #expect(forward.next == "b")
        forward.pathChanged(from: ["a"], to: ["a", "b"])
        #expect(forward.next == "c")
        forward.pathChanged(from: ["a", "b"], to: ["a", "b", "c"])
        #expect(forward.next == nil)
    }

    @Test func openingTheSameThreadAgainIsForward() {
        var forward = ForwardStack()
        forward.pathChanged(from: ["a", "b"], to: [])
        // Tapped a's row in the inbox: b is still forward from it.
        forward.pathChanged(from: [], to: ["a"])
        #expect(forward.next == "b")
    }

    @Test func goingSomewhereElseClearsForward() {
        var forward = ForwardStack()
        forward.pathChanged(from: ["a", "b"], to: ["a"])
        forward.pathChanged(from: ["a"], to: ["a", "x"])
        #expect(forward.next == nil)
        forward.pathChanged(from: ["a", "x"], to: ["a"])
        forward.pathChanged(from: ["a"], to: ["y"])
        #expect(forward.next == nil)
    }

    @Test func noChangeLeavesItAlone() {
        var forward = ForwardStack()
        forward.pathChanged(from: ["a", "b"], to: ["a"])
        forward.pathChanged(from: ["a"], to: ["a"])
        #expect(forward.next == "b")
    }

    @Test func progressFillsToTheLine() {
        #expect(PageSwipe.progress(0) == 0)
        #expect(PageSwipe.progress(-PageSwipe.line / 2) == 0.5)
        #expect(PageSwipe.progress(PageSwipe.line * 3) == 1)
    }

    @Test func onlyClearlySidewaysCounts() {
        #expect(PageSwipe.isSideways(CGPoint(x: -300, y: 40)))
        #expect(!PageSwipe.isSideways(CGPoint(x: -100, y: 90)))
        #expect(!PageSwipe.isSideways(CGPoint(x: 0, y: 0)))
    }

    @Test func aCodeBlockThatCanStillScrollKeepsTheSwipe() {
        // 300 wide in a 200 wide view, at the start: left scrolls it, right leaves.
        #expect(PageSwipe.scrollerKeeps(forward: true, offset: 0, contentWidth: 300, width: 200))
        #expect(!PageSwipe.scrollerKeeps(forward: false, offset: 0, contentWidth: 300, width: 200))
        // Scrolled to its end: left goes forward.
        #expect(!PageSwipe.scrollerKeeps(forward: true, offset: 100, contentWidth: 300, width: 200))
        // Nothing to scroll.
        #expect(!PageSwipe.scrollerKeeps(forward: true, offset: 0, contentWidth: 200, width: 200))
    }
}
