import XCTest
@testable import ThreadbearCore

/// show_panel's requests (docs/protocol.md, "Showing panels").
final class PanelRequestsTests: XCTestCase {
    private func thread(_ extra: String) throws -> ThreadSummary {
        let json = """
        {"id":"t1","title":"Schema","cwd":"/w/app","accountId":"claude-3","provider":"claude","permissionMode":"full",
         "status":"idle","live":false,"needsYou":false,"createdAt":"2026-10-28T08:00:00Z","updatedAt":"2026-10-28T08:00:00Z",
         "lastActivityAt":"2026-10-28T08:00:00Z","preview":"","lastSeq":4,"lastSeenSeq":4\(extra)}
        """
        return try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
    }

    func testDecodesTheRequestAndKeepsIt() throws {
        let t = try thread(#","panelRequest":{"id":"r1","panel":"convex.dashboard","title":"Convex","where":"right","at":"2026-10-28T08:01:00Z","later":1}"#)
        XCTAssertEqual(t.panelRequest, PanelRequest(id: "r1", panel: "convex.dashboard", title: "Convex", where: "right", at: "2026-10-28T08:01:00Z"))
        let again = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(t))
        XCTAssertEqual(again.panelRequest, t.panelRequest)
        // A malformed one is as good as none, rather than losing the thread.
        XCTAssertNil(try thread(#","panelRequest":{"panel":3}"#).panelRequest)
        XCTAssertNil(try thread("").panelRequest)
    }

    func testNamesThePanelTheThreadHas() throws {
        let t = try thread(#","panels":[{"id":"convex.dashboard","title":"Convex","kind":"url","url":"https://x.dev","patch":"convex"}],"patches":[{"id":"convex","source":"builtin"}]"#)
        func panel(_ name: String) -> RequestedPanel? { PanelRequests.panel(PanelRequest(id: "r", panel: name, title: name), in: t) }
        XCTAssertEqual(panel("highlights"), .section(.highlights))
        XCTAssertEqual(panel("patches"), .section(.patches))
        XCTAssertEqual(panel("convex.dashboard"), .section(.panel("convex.dashboard")))
        XCTAssertEqual(panel("usage"), .usage)
        XCTAssertEqual(panel("updates"), .updates)
        XCTAssertEqual(panel("connectors"), .connectors)
        XCTAssertEqual(panel("threadbear.browser"), .section(.panel("threadbear.browser")))
        XCTAssertNil(panel("xcode.simulator"), "gone since the agent asked")
        let bare = try thread("")
        XCTAssertNil(PanelRequests.panel(PanelRequest(id: "r", panel: "patches", title: "Patches"), in: bare), "no patches, no Patches")
    }

    /// `pin` with `show` (8 Nov 2026): a request naming the pin, found in
    /// the thread's highlights, each time it's asked.
    func testAPinRequestNamesItsHighlight() throws {
        let t = try thread(#","panelRequest":{"id":"r2","panel":"highlights","title":"Preview check","highlight":"file:/w/page.html","at":"2026-11-08T08:01:00Z"}"#)
        let request = try XCTUnwrap(t.panelRequest)
        XCTAssertEqual(request.highlight, "file:/w/page.html")
        XCTAssertEqual(try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(t)).panelRequest, request)
        // An app without the pin's case still opens Highlights.
        XCTAssertEqual(PanelRequests.panel(request, in: t), .section(.highlights))
        let page = Highlight(id: "file:/w/page.html", kind: .file, title: "page.html", path: "/w/page.html", how: .pinned, seq: 3)
        let other = Highlight(id: "file:/w/b.md", kind: .file, title: "b.md", path: "/w/b.md", how: .written, seq: 2)
        XCTAssertEqual(PanelRequests.pin(request, in: ThreadHighlights(highlights: [other, page]))?.id, page.id)
        XCTAssertNil(PanelRequests.pin(request, in: nil), "not fetched yet")
        XCTAssertNil(PanelRequests.pin(request, in: ThreadHighlights(highlights: [other])), "unpinned since")
        XCTAssertNil(PanelRequests.pin(PanelRequest(id: "r", panel: "highlights", title: "Highlights"), in: ThreadHighlights(highlights: [page])), "a plain show_panel")
    }

    func testPlaces() {
        func place(_ w: String?) -> RequestedPlace { PanelRequests.place(PanelRequest(id: "r", panel: "usage", title: "Usage", where: w)) }
        XCTAssertEqual(place(nil), .usual)
        XCTAssertEqual(place("tab"), .tab)
        XCTAssertEqual(place("window"), .window)
        XCTAssertEqual(place("left"), .side(.left))
        XCTAssertEqual(place("bottom"), .side(.bottom))
        XCTAssertEqual(place("somewhere new"), .usual)
    }

    func testBrowserRemainsTheChosenPanelWithoutAProjectPatch() {
        XCTAssertEqual(PanelChoice.section(panels: [], hasPatches: false, remembered: "threadbear.browser"), .panel("threadbear.browser"))
    }

    func testShowsEachRequestOnceAndOnlyWhileMikeIsLooking() throws {
        var gate = PanelRequestGate()
        let waiting = try thread(#","panelRequest":{"id":"r1","panel":"usage","title":"Usage","at":"2026-10-28T08:01:00Z"}"#)
        XCTAssertNil(gate.take(waiting, looking: false), "the app isn't in front")
        XCTAssertNil(gate.take(nil, looking: true))
        XCTAssertEqual(gate.take(waiting, looking: true)?.id, "r1")
        XCTAssertNil(gate.take(waiting, looking: true), "a summary still carrying it while the runner clears it")
        // Handed back unshown (a pin's fetch failed, or Mike moved on): taken again next look.
        gate.release("r1")
        XCTAssertEqual(gate.take(waiting, looking: true)?.id, "r1")
        let next = try thread(#","panelRequest":{"id":"r2","panel":"highlights","title":"Highlights","at":"2026-10-28T08:02:00Z"}"#)
        XCTAssertEqual(gate.take(next, looking: true)?.id, "r2")
        XCTAssertNil(gate.take(try thread(""), looking: true))
    }
}
