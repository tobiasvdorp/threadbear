import Foundation
import Testing
@testable import BearDock

// Small builders so each tree reads like the picture of it.
private func g(_ id: String, _ panels: [PanelID], _ selected: PanelID? = nil) -> DockNode {
    .group(DockGroup(id: id, panels: panels, selected: selected))
}
private func h(_ id: String, _ children: [DockNode], _ fractions: [Double]? = nil) -> DockNode {
    .split(DockSplit(id: id, axis: .horizontal, children: children, fractions: fractions))
}
private func v(_ id: String, _ children: [DockNode], _ fractions: [Double]? = nil) -> DockNode {
    .split(DockSplit(id: id, axis: .vertical, children: children, fractions: fractions))
}
/// "n1", "n2", ... so new ids are predictable.
private func ids() -> () -> String {
    var n = 0
    return { n += 1; return "n\(n)" }
}

/// Threadbear's option 2: threads | transcript | highlights over convex.
private func threeColumns() -> DockLayout {
    DockLayout(root: h("root", [
        g("left", ["threads"]),
        g("mid", ["transcript"]),
        v("right", [g("hl", ["highlights"]), g("cx", ["convex"])]),
    ], [0.25, 0.5, 0.25]))
}

@Test func edgeAlongTheSameAxisJoinsAsASiblingSharingTheTargetsSpace() {
    var layout = threeColumns()
    layout.move("convex", .edge(group: "mid", .right), newID: ids())
    #expect(layout.root == h("root", [
        g("left", ["threads"]),
        g("mid", ["transcript"]),
        g("n1", ["convex"]),
        g("hl", ["highlights"]),
    ], [0.25, 0.25, 0.25, 0.25]))
}

@Test func edgeAcrossTheAxisWrapsTheTargetInANewSplit() {
    var layout = threeColumns()
    layout.move("threads", .edge(group: "mid", .bottom), newID: ids())
    // threads' column went, so its quarter is shared between the rest.
    #expect(layout.root == h("root", [
        v("n2", [g("mid", ["transcript"]), g("n1", ["threads"])]),
        v("right", [g("hl", ["highlights"]), g("cx", ["convex"])]),
    ], [0.5 / 0.75, 0.25 / 0.75]))
}

@Test func nestingGoesAsDeepAsYouLike() {
    var layout = threeColumns()
    let next = ids()
    layout.move("threads", .edge(group: "cx", .left), newID: next)   // n1, in split n2
    layout.move("highlights", .edge(group: "n1", .top), newID: next) // n3, in split n4
    layout.move("convex", .edge(group: "n1", .right), newID: next)   // n5, in split n6
    // Three levels: a row, a column in it, a row in that.
    guard case .split(let root) = layout.root else { Issue.record("expected a split"); return }
    #expect(root.children == [
        g("mid", ["transcript"]),
        v("n4", [g("n3", ["highlights"]), h("n6", [g("n1", ["threads"]), g("n5", ["convex"])])]),
    ])
    // threads' quarter went to the right, then convex's sixth back to both.
    #expect(abs(root.fractions[0] - 0.8) < 1e-9)
}

@Test func movingTheOnlyPanelOutCollapsesItsGroupAndSplit() {
    var layout = threeColumns()
    layout.move("highlights", .tab(group: "mid"))
    // The right column is down to convex alone, so it's just that group now.
    #expect(layout.root == h("root", [
        g("left", ["threads"]),
        g("mid", ["transcript", "highlights"], "highlights"),
        g("cx", ["convex"]),
    ], [0.25, 0.5, 0.25]))
}

@Test func sameAxisSplitsFlatten() {
    let node = h("a", [g("x", ["X"]), h("b", [g("y", ["Y"]), g("z", ["Z"])])], [0.5, 0.5])
    #expect(DockLayout.normalised(node) == h("a", [g("x", ["X"]), g("y", ["Y"]), g("z", ["Z"])], [0.5, 0.25, 0.25]))
}

@Test func takingASelectedTabShowsItsNeighbour() {
    var layout = DockLayout(root: h("root", [g("a", ["A", "B", "C"], "B"), g("d", ["D"])]))
    layout.move("B", .tab(group: "d"))
    #expect(layout.group(id: "a")?.selected == "C")
    #expect(layout.group(id: "d") == DockGroup(id: "d", panels: ["D", "B"], selected: "B"))
    layout.move("C", .tab(group: "d"))
    #expect(layout.group(id: "a")?.selected == "A")
}

@Test func splittingAGroupByOneOfItsOwnTabs() {
    var layout = DockLayout(root: g("a", ["A", "B"]))
    layout.move("B", .edge(group: "a", .right), newID: ids())
    #expect(layout.root == h("n2", [g("a", ["A"]), g("n1", ["B"])]))
}

@Test func swapTradesPlaces() {
    var layout = threeColumns()
    layout.move("threads", .swap(group: "cx"))
    #expect(layout.group(id: "left")?.panels == ["convex"])
    #expect(layout.group(id: "cx") == DockGroup(id: "cx", panels: ["threads"]))
}

@Test func windowEdgesSpanTheWholeSide() {
    var layout = threeColumns()
    let next = ids()
    layout.move("convex", .window(.right), newID: next)
    #expect(layout.root == h("root", [
        g("left", ["threads"]),
        g("mid", ["transcript"]),
        g("hl", ["highlights"]),
        g("n1", ["convex"]),
    ], [0.1875, 0.375, 0.1875, 0.25]))

    layout.move("threads", .window(.bottom), newID: next)
    guard case .split(let root) = layout.root else { Issue.record("expected a split"); return }
    #expect(root.axis == .vertical)
    #expect(root.fractions == [0.75, 0.25])
    #expect(root.children.last == g("n2", ["threads"]))
}

@Test func dropsThatGoNowhereAreRefused() {
    let layout = threeColumns()
    #expect(!layout.canDrop("threads", .edge(group: "left", .right)))
    #expect(!layout.canDrop("threads", .tab(group: "left")))
    #expect(!layout.canDrop("threads", .swap(group: "left")))
    #expect(!layout.canDrop("nope", .tab(group: "left")))
    #expect(!layout.canDrop("threads", .tab(group: "nope")))
    #expect(!DockLayout(root: g("a", ["A"])).canDrop("A", .window(.left)))
    #expect(layout.canDrop("threads", .edge(group: "mid", .left)))
    var unchanged = layout
    unchanged.move("threads", .tab(group: "left"))
    #expect(unchanged == layout)
}

@Test func closeAndAddBack() {
    var layout = threeColumns()
    layout.close("convex")
    #expect(!layout.contains("convex"))
    layout.add("convex", .tab(group: "hl"))
    #expect(layout.group(id: "hl")?.panels == ["highlights", "convex"])
    var single = DockLayout(root: g("a", ["A"]))
    single.close("A")
    #expect(single.root == g("a", ["A"]))
}

@Test func dividerFractionsStayNormalised() {
    var layout = threeColumns()
    layout.setFractions(split: "root", [1, 2, 1])
    guard case .split(let root) = layout.root else { Issue.record("expected a split"); return }
    #expect(root.fractions == [0.25, 0.5, 0.25])
}

@Test func roundTripsThroughJSON() throws {
    let layout = threeColumns()
    let data = try JSONEncoder().encode(layout)
    #expect(try JSONDecoder().decode(DockLayout.self, from: data) == layout)
}

@Test func aHiddenTitleOnlyHidesWhileThePanelIsOnItsOwn() {
    var layout = threeColumns()
    layout.setTitleHidden("threads", true)
    #expect(!layout.showsHeader(layout.group(id: "left")!))
    // Joined by a tab: the tabs are needed to switch, so the bar comes back.
    layout.move("transcript", .tab(group: "left"))
    #expect(layout.showsHeader(layout.group(containing: "threads")!))
    // On its own again, wherever it ends up, the title stays hidden.
    layout.move("threads", .window(.right))
    #expect(!layout.showsHeader(layout.group(containing: "threads")!))
    layout.setTitleHidden("threads", false)
    #expect(layout.showsHeader(layout.group(containing: "threads")!))
}

@Test func layoutsSavedBeforeHiddenTitlesStillLoad() throws {
    let old = #"{"root":{"group":{"_0":{"id":"a","panels":["A"],"selected":"A"}}}}"#
    let layout = try JSONDecoder().decode(DockLayout.self, from: Data(old.utf8))
    #expect(layout.hiddenTitles.isEmpty)
    #expect(layout.panels == ["A"])
}

@Test func theTopLeadingGroupIsTheFirstChildAllTheWayDown() {
    #expect(threeColumns().topLeadingGroupID == "left")
    var layout = threeColumns()
    layout.move("highlights", .window(.top), newID: ids())
    #expect(layout.topLeadingGroupID == "n1")
}

@MainActor @Test func showAndToggleFromARail() {
    let dock = DockController(layout: threeColumns())
    // Open behind another tab: brought to the front.
    dock.layout.move("convex", .tab(group: "hl"))
    #expect(!dock.isShowing("highlights"))
    dock.toggle("highlights")
    #expect(dock.isShowing("highlights"))
    // Showing: closed.
    dock.toggle("highlights")
    #expect(!dock.layout.contains("highlights"))
    // Closed: opened as a tab beside the first of `near` that's open.
    dock.toggle("highlights", near: ["nope", "convex"])
    #expect(dock.layout.group(containing: "highlights")?.panels == ["convex", "highlights"])
}

@Test func summaryReadsLikeTheWindow() {
    var layout = threeColumns()
    layout.setTitleHidden("threads", true)
    layout.move("convex", .tab(group: "hl"))
    #expect(layout.summary == "row[threads (no title) 25% | transcript 50% | highlights+convex* 25%]")
}

@MainActor @Test func unavailablePanelsAreLeftOutOfTheirGroup() {
    let group = DockGroup(id: "g", panels: ["highlights", "convex", "simulator"], selected: "simulator")
    let drawn = GroupView.visible(group) { $0 != "simulator" }
    #expect(drawn == DockGroup(id: "g", panels: ["highlights", "convex"], selected: "highlights"))
    // Nothing available: drawn as it is, for the app's own note.
    #expect(GroupView.visible(group) { _ in false } == group)
}

@MainActor @Test func aSideWithNothingToShowGivesItsRoomToTheRest() {
    // A thread's patch panel moved to a side of its own, while a thread
    // without it is on show: that side goes and the others share its room.
    let split = DockSplit(id: "root", axis: .horizontal, children: [
        g("tool", ["tandem"]), g("mid", ["transcript"]), g("right", ["highlights", "convex"]),
    ], fractions: [0.25, 0.5, 0.25])
    let shown = SplitView.shownIndices(split) { $0 != "tandem" && $0 != "convex" }
    #expect(shown == [1, 2])
    let shares: [Double] = SplitView.normalized(shown.map { split.fractions[$0] })
    let expected: [Double] = [2.0 / 3, 1.0 / 3]
    #expect(shares == expected)
    // A divider dragged meanwhile keeps the hidden side's share.
    #expect(SplitView.merged([0.5, 0.5], into: split.fractions, at: shown) == [0.25, 0.375, 0.375])
    // Nothing available anywhere: all of it, as a group does.
    #expect(SplitView.shownIndices(split) { _ in false } == [0, 1, 2])
    // The traffic lights move on to the next side.
    #expect(GroupView.topLeadingGroupID(.split(split)) { $0 != "tandem" } == "mid")
    #expect(GroupView.topLeadingGroupID(.split(split)) { _ in true } == "tool")
}

// MARK: Windows of their own

@Test func floatingTakesAPanelOutOfTheTreeButKeepsItOpen() {
    var layout = threeColumns()
    let frame = CGRect(x: 100, y: 200, width: 400, height: 300)
    layout.float("highlights", frame: frame)
    #expect(layout.root == h("root", [
        g("left", ["threads"]),
        g("mid", ["transcript"]),
        g("cx", ["convex"]),
    ], [0.25, 0.5, 0.25]))
    #expect(layout.floating == [DockFloat(panel: "highlights", frame: frame)])
    #expect(layout.contains("highlights"))
    #expect(layout.group(containing: "highlights") == nil)
    #expect(layout.panels.last == "highlights")
    #expect(layout.summary.hasSuffix(" + window[highlights]"))
}

@Test func floatingAgainOnlyMovesTheWindow() {
    var layout = threeColumns()
    layout.float("convex", frame: CGRect(x: 0, y: 0, width: 300, height: 300))
    layout.float("convex", frame: CGRect(x: 50, y: 60, width: 320, height: 340))
    #expect(layout.floating == [DockFloat(panel: "convex", frame: CGRect(x: 50, y: 60, width: 320, height: 340))])
}

@Test func theLastPanelInTheDockCantFloat() {
    var layout = DockLayout(root: g("only", ["transcript"]))
    #expect(!layout.canFloat("transcript"))
    layout.float("transcript", frame: .zero)
    #expect(layout.floating.isEmpty)
    #expect(layout.root == g("only", ["transcript"]))
}

@Test func aFloatingPanelDocksBackAnywhereButASwap() {
    var layout = threeColumns()
    layout.float("threads", frame: .zero)
    #expect(layout.canDrop("threads", .tab(group: "mid")))
    #expect(layout.canDrop("threads", .edge(group: "mid", .left)))
    #expect(layout.canDrop("threads", .window(.left)))
    #expect(!layout.canDrop("threads", .swap(group: "mid")))
    layout.move("threads", .edge(group: "hl", .top), newID: ids())
    #expect(layout.floating.isEmpty)
    #expect(layout.group(containing: "threads")?.id == "n1")
}

@Test func closingAFloatingPanelClosesItsWindow() {
    var layout = threeColumns()
    layout.float("convex", frame: .zero)
    layout.close("convex")
    #expect(layout.floating.isEmpty)
    #expect(!layout.contains("convex"))
}

@Test func layoutsSavedBeforeWindowsStillLoad() throws {
    var old = try JSONSerialization.jsonObject(with: JSONEncoder().encode(threeColumns())) as! [String: Any]
    old.removeValue(forKey: "floating")
    let decoded = try JSONDecoder().decode(DockLayout.self, from: JSONSerialization.data(withJSONObject: old))
    #expect(decoded.floating.isEmpty)
    var floated = threeColumns()
    floated.float("convex", frame: CGRect(x: 1, y: 2, width: 3, height: 4))
    #expect(try JSONDecoder().decode(DockLayout.self, from: JSONEncoder().encode(floated)) == floated)
}

@Test func putBackAlongASideComesBackTheSizeItWas() {
    var layout = DockLayout(root: h("root", [g("left", ["threads"]), g("mid", ["transcript"])], [0.3, 0.7]))
    layout.float("transcript", frame: .zero, home: .window(.right), share: 0.7)
    layout.move("transcript", .window(.right), newID: ids())
    guard case .split(let s) = layout.root else { Issue.record("expected a split"); return }
    #expect(s.children == [g("left", ["threads"]), g("n1", ["transcript"])])
    #expect(abs(s.fractions[1] - 0.7) < 0.0001)
}
