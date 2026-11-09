import XCTest
@testable import ThreadbearCore

final class HighlightsTests: XCTestCase {
    private let sample = """
    {"highlights":[
      {"id":"file:/w/site/mockups/hero.html","kind":"file","title":"hero.html","path":"/w/site/mockups/hero.html","how":"pinned",
       "note":"Does the headline work?","show":true,"seq":40,"lastSeq":40,"at":"2026-10-27T08:00:00Z"},
      {"id":"file:/w/site/docs/copy.md","kind":"file","title":"copy.md","path":"/w/site/docs/copy.md","how":"written","seq":30,"lastSeq":31,"at":"2026-10-27T07:00:00Z"},
      {"id":"pr:https://github.com/m/site/pull/14","kind":"pr","title":"m/site#14","url":"https://github.com/m/site/pull/14","how":"created","seq":28,"lastSeq":28,"at":"2026-10-27T06:00:00Z"},
      {"id":"link:http://localhost:4321/","kind":"link","title":"localhost:4321","url":"http://localhost:4321/","how":"opened","seq":20,"lastSeq":20,"at":"2026-10-27T05:00:00Z"},
      {"id":"commit:abc1234","kind":"commit","title":"Rebuild the hero","sha":"abc1234","branch":"rebuild","pushed":true,"how":"committed","seq":18,"lastSeq":18,"at":"2026-10-27T04:00:00Z"},
      {"id":"hologram:x","kind":"hologram","title":"From the future","how":"beamed","seq":5,"lastSeq":5,"at":"2026-10-27T03:00:00Z"},
      {"id":"hologram:y","kind":"hologram","title":"A future link","url":"https://example.com","how":"mentioned","seq":4,"lastSeq":4,"at":"2026-10-27T03:00:00Z","extra":{"a":1}},
      {"kind":"file","title":"no id"}
    ],
    "edited":["/w/site/src/Hero.tsx","/w/site/docs/copy.md","/w/site/src/Hero.tsx","/w/site/src/app.css"],
    "brief":{"text":"  The three pages are rebuilt; Quick Ask's copy still needs a pass.  ","at":"2026-10-27T08:00:00Z"},
    "somethingNew":true}
    """

    func testDecodesHighlightsTolerantly() throws {
        let decoded = try JSONDecoder().decode(ThreadHighlights.self, from: Data(sample.utf8))
        XCTAssertEqual(decoded.highlights.count, 7, "the one without an id is skipped, the rest kept")
        let pin = decoded.highlights[0]
        XCTAssertEqual(pin.kind, .file)
        XCTAssertEqual(pin.how, .pinned)
        XCTAssertTrue(pin.show)
        XCTAssertEqual(pin.note, "Does the headline work?")
        XCTAssertEqual(pin.at, ISO8601.parse("2026-10-27T08:00:00Z"))
        XCTAssertEqual(decoded.highlights[4].sha, "abc1234")
        XCTAssertTrue(decoded.highlights[4].pushed)
        XCTAssertFalse(decoded.highlights[1].pushed)
        XCTAssertEqual(decoded.highlights[5].kind, .other("hologram"))
        XCTAssertEqual(decoded.highlights[5].how, .other("beamed"))
        XCTAssertEqual(decoded.highlights[5].how.word, "")
        XCTAssertEqual(decoded.edited.count, 4)
        XCTAssertNotNil(decoded.brief)
        let again = try JSONDecoder().decode(ThreadHighlights.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(again, decoded)
        // An older runner's empty answer, or one with nothing at all.
        let empty = try JSONDecoder().decode(ThreadHighlights.self, from: Data("{}".utf8))
        XCTAssertEqual(empty, ThreadHighlights())
    }

    func testSectionsGroupPinsFilesLinksAndCommits() throws {
        let decoded = try JSONDecoder().decode(ThreadHighlights.self, from: Data(sample.utf8))
        let sections = HighlightSections.build(decoded)
        XCTAssertEqual(sections.brief, "The three pages are rebuilt; Quick Ask's copy still needs a pass.")
        XCTAssertEqual(sections.pinned.map(\.title), ["hero.html"])
        XCTAssertEqual(sections.files.map(\.title), ["copy.md"])
        // The unknown kind with a url is a link; the one with neither is left out.
        XCTAssertEqual(sections.links.map(\.title), ["m/site#14", "localhost:4321", "A future link"])
        XCTAssertEqual(sections.commits.map(\.sha), ["abc1234"])
        // A file already listed isn't repeated under edited, nor is a repeat.
        XCTAssertEqual(sections.edited, ["/w/site/src/Hero.tsx", "/w/site/src/app.css"])
        XCTAssertFalse(sections.isEmpty)
        XCTAssertTrue(HighlightSections.build(ThreadHighlights()).isEmpty)
        XCTAssertTrue(HighlightSections.build(ThreadHighlights(brief: .init(text: "  "))).isEmpty)
    }

    func testBriefPointsSplitTheBullets() {
        XCTAssertEqual(HighlightSections.points("- Added the Tandem card\n\n  - Panel follows the thread \n• Waiting on Mike to test"),
                       ["Added the Tandem card", "Panel follows the thread", "Waiting on Mike to test"])
        // An older paragraph brief stays one point.
        XCTAssertEqual(HighlightSections.points("Rebuilt the pages; copy needs a pass."), ["Rebuilt the pages; copy needs a pass."])
    }

    func testWebPagesAreHttpLinksOnly() throws {
        func web(_ text: String) throws -> Bool { PreviewRules.isWebPage(try XCTUnwrap(URL(string: text))) }
        XCTAssertTrue(try web("http://localhost:4321/poddle"))
        XCTAssertTrue(try web("HTTPS://github.com/m/site/pull/14"))
        XCTAssertFalse(try web("file:///tmp/a.html"))
        XCTAssertFalse(try web("mailto:mike@example.com"))
        XCTAssertEqual(PreviewRules.viewer(forPath: "/a/b/Index.HTML"), .web)
        XCTAssertEqual(PreviewRules.viewer(forPath: "/a/b/shot.png"), .quickLook)
        XCTAssertEqual(PreviewRules.viewer(forPath: "/a/b/clip.mp4"), .quickLook)
        XCTAssertEqual(PreviewRules.viewer(forPath: "/a/b/paper.pdf"), .quickLook)
    }

    /// Markdown, plain text and code are the pane's own text view, which
    /// can be selected and edited; Quick Look's text couldn't be.
    func testTextFilesGetTheTextView() {
        for path in ["/a/INSTALL.md", "/a/notes.MD", "/a/b.markdown", "/a/readme.txt", "/a/data.csv", "/a/.env", "/a/x.log",
                     "/a/app.ts", "/a/Package.swift", "/a/config.json", "/a/Makefile"] {
            XCTAssertEqual(PreviewRules.viewer(forPath: path), .text, path)
        }
        XCTAssertTrue(PreviewRules.isMarkdown("/a/INSTALL.md"))
        XCTAssertFalse(PreviewRules.isMarkdown("/a/notes.txt"))
    }

    func testCodeFilesGetTheirLanguage() {
        XCTAssertEqual(PreviewRules.codeLanguage(forPath: "/r/runner/test/unit/release.test.ts"), "typescript")
        XCTAssertEqual(PreviewRules.codeLanguage(forPath: "/r/App.SWIFT"), "swift")
        XCTAssertEqual(PreviewRules.codeLanguage(forPath: "/r/Makefile"), "makefile")
        XCTAssertNil(PreviewRules.codeLanguage(forPath: "/r/README.md"))
        XCTAssertNil(PreviewRules.codeLanguage(forPath: "/r/clip.mp4"))
    }

    func testTextIsToldFromBinaryByItsBytes() {
        XCTAssertTrue(PreviewRules.looksLikeText(Data("import test from 'node:test';\n".utf8)))
        XCTAssertTrue(PreviewRules.looksLikeText(Data()))
        // "é" cut in half at the end of the sample.
        XCTAssertTrue(PreviewRules.looksLikeText(Data("caf".utf8) + Data([0xC3])))
        // An MPEG transport stream packet: sync byte, then binary.
        XCTAssertFalse(PreviewRules.looksLikeText(Data([0x47, 0x40, 0x00, 0x10, 0x00])))
        XCTAssertFalse(PreviewRules.looksLikeText(Data([0xFF, 0xFE, 0xFD, 0x41])))
    }

    func testTranscriptLinksToReviewFilesPreviewInThePane() {
        for path in ["/tmp/a.md", "/tmp/b.HTML", "/tmp/c.pdf", "/tmp/d.png", "/tmp/e.mov", "/tmp/f.csv", "/tmp/g.svg"] {
            XCTAssertTrue(PreviewRules.previewsInPane(transcriptLink: URL(fileURLWithPath: path)), path)
        }
        for path in ["/tmp/a.swift", "/tmp/b.ts", "/tmp/folder", "/tmp/c.zip"] {
            XCTAssertFalse(PreviewRules.previewsInPane(transcriptLink: URL(fileURLWithPath: path)), path)
        }
        XCTAssertFalse(PreviewRules.previewsInPane(transcriptLink: URL(string: "https://example.com/a.md")!))
    }

    func testTandemProjectsAreAppProjects() {
        XCTAssertTrue(PreviewRules.isAppProject("/a/Pebble Index mic test.tandem"))
        XCTAssertTrue(PreviewRules.isAppProject("/a/B.TANDEM"))
        // Tandem's hidden folder beside a project isn't one.
        XCTAssertFalse(PreviewRules.isAppProject("/a/.tandem"))
        XCTAssertFalse(PreviewRules.isAppProject("/a/notes.md"))
    }

    func testFileIconsByExtension() {
        XCTAssertEqual(FileIcon.symbol(forPath: "/a/notes.md"), "doc.text")
        XCTAssertEqual(FileIcon.symbol(forPath: "/a/mock.html"), "safari")
        XCTAssertEqual(FileIcon.symbol(forPath: "/a/shot.PNG"), "photo")
        XCTAssertEqual(FileIcon.symbol(forPath: "/a/demo.mov"), "film")
        XCTAssertEqual(FileIcon.symbol(forPath: "/a/data.csv"), "tablecells")
        XCTAssertEqual(FileIcon.symbol(forPath: "/a/App.swift"), "chevron.left.forwardslash.chevron.right")
        XCTAssertEqual(FileIcon.symbol(forPath: "/a/Makefile"), "doc")
        XCTAssertEqual(FileIcon.symbol(for: Highlight(id: "pr:1", kind: .pr, title: "m/s#1")), "arrow.triangle.pull")
        XCTAssertEqual(FileIcon.symbol(for: Highlight(id: "link:1", kind: .link, title: "x")), "link")
    }

    func testFolderIsRelativeToTheThreadsFolderElseHome() {
        let cwd = "/Users/mike/dev/site"
        XCTAssertEqual(HighlightText.folder(of: "/Users/mike/dev/site/docs/mockups/a.html", cwd: cwd, home: "/Users/mike"), "docs/mockups")
        XCTAssertEqual(HighlightText.folder(of: "/Users/mike/dev/site/README.md", cwd: cwd + "/", home: "/Users/mike"), "site")
        XCTAssertEqual(HighlightText.folder(of: "/Users/mike/dev/site-old/a.md", cwd: cwd, home: "/Users/mike"), "~/dev/site-old")
        XCTAssertEqual(HighlightText.folder(of: "/tmp/a.md", cwd: cwd, home: "/Users/mike"), "/tmp")
        XCTAssertEqual(HighlightText.address("https://www.github.com/m/site/pull/14/"), "github.com/m/site/pull/14")
        XCTAssertEqual(HighlightText.commitLine(Highlight(id: "c", kind: .commit, title: "x", branch: "main", pushed: true)), "main · pushed")
        XCTAssertEqual(HighlightText.commitLine(Highlight(id: "c", kind: .commit, title: "x")), "not pushed yet")
        XCTAssertEqual(HighlightText.editedCount(1), "1 file edited")
        XCTAssertEqual(HighlightText.editedCount(3), "3 files edited")
    }

    func testLongGroupsAreCappedUntilShowAll() {
        let commits = Array(1...15)
        let capped = HighlightSections.capped(commits, limit: HighlightSections.commitLimit, showAll: false)
        XCTAssertEqual(capped.shown, [1, 2, 3, 4, 5])
        XCTAssertEqual(capped.more, 10)
        XCTAssertEqual(HighlightSections.capped(commits, limit: 5, showAll: true).shown.count, 15)
        XCTAssertEqual(HighlightSections.capped(Array(1...5), limit: 5, showAll: false).more, 0)
        // Agents often commit without the branch showing: no empty " · ".
        XCTAssertEqual(HighlightText.commitLine(Highlight(id: "c", kind: .commit, title: "x", branch: "", pushed: true)), "pushed")
    }

    func testSummaryCarriesHighlightsAt() throws {
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"t","highlightsAt":"2026-10-27T08:00:00Z"}"#.utf8))
        XCTAssertEqual(thread.highlightsAt, ISO8601.parse("2026-10-27T08:00:00Z"))
        let again = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(thread))
        XCTAssertEqual(again.highlightsAt, thread.highlightsAt)
        let older = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"t"}"#.utf8))
        XCTAssertNil(older.highlightsAt)
    }
}

final class ListPanelTests: XCTestCase {
    func testListPanelsDecodeWithIconsAndUnknownKindsStayPages() throws {
        let json = """
        {"id":"th1","panels":[
          {"id":"tools.worktrees","title":"Worktrees","kind":"list","icon":"arrow.triangle.branch","patch":"tools"},
          {"id":"future.thing","title":"Later","kind":"hologram","url":"https://example.com","patch":"future"}
        ]}
        """
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
        XCTAssertEqual(thread.panels[0].kind, .list)
        XCTAssertEqual(thread.panels[0].icon, "arrow.triangle.branch")
        XCTAssertEqual(thread.panels[1].kind, .url)
        let again = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(thread))
        XCTAssertEqual(again.panels, thread.panels)
    }

    func testRenderDecodesItemsSkippingBrokenOnes() throws {
        let json = """
        {"items":[
          {"title":"main","detail":"/w/site abc1234 [main]","icon":"arrow.triangle.branch"},
          {"title":"Preview","url":"http://localhost:4321","tone":"attention"},
          {"title":"Build","tone":"failed","path":"/w/site/build.log"},
          {"title":"Deploy","tone":"done"},
          {"title":"Odd","tone":"sparkly"},
          {"detail":"no title"}
        ],"note":null}
        """
        let render = try JSONDecoder().decode(PanelRender.self, from: Data(json.utf8))
        let items = try XCTUnwrap(render.items)
        XCTAssertEqual(items.map(\.title), ["main", "Preview", "Build", "Deploy", "Odd"])
        XCTAssertEqual(items.map(\.tone), [nil, .attention, .failed, .done, nil])
        XCTAssertEqual(items[2].path, "/w/site/build.log")
        XCTAssertNil(render.note)
        // An image panel's answer has no items at all.
        let image = try JSONDecoder().decode(PanelRender.self, from: Data(#"{"image":{"path":"/tmp/s.png","mediaType":"image/png"}}"#.utf8))
        XCTAssertNil(image.items)
        XCTAssertEqual(image.image?.path, "/tmp/s.png")
    }

    func testSectionsDrawAHeadingWhereTheyChangeAndTrailingDecodes() throws {
        let json = #"""
        {"items":[
          {"title":"Streak","section":"Waiting · 1","trailing":"1d"},
          {"title":"Clouds","section":"Shipped · 2","trailing":"5d"},
          {"title":"Replay","section":"Shipped · 2"},
          {"title":"Loose"},
          {"title":"Back","section":"Shipped · 2"}
        ]}
        """#
        let items = try XCTUnwrap(try JSONDecoder().decode(PanelRender.self, from: Data(json.utf8)).items)
        XCTAssertEqual(items.map(\.trailing), ["1d", "5d", nil, nil, nil])
        // A row with no section ends the group, so the next one says it again.
        XCTAssertEqual(PanelItem.headings(items), ["Waiting · 1", "Shipped · 2", nil, nil, "Shipped · 2"])
    }

    func testRailIcons() {
        XCTAssertEqual(PanelIcon.symbol(for: Panel(id: "convex.dashboard", title: "Convex")), "cylinder.split.1x2")
        XCTAssertEqual(PanelIcon.symbol(for: Panel(id: "xcode.simulator", title: "Simulator", kind: .image)), "iphone")
        XCTAssertEqual(PanelIcon.symbol(for: Panel(id: "x.page", title: "Page")), "globe")
        XCTAssertEqual(PanelIcon.symbol(for: Panel(id: "x.pic", title: "Pic", kind: .image)), "photo")
        XCTAssertEqual(PanelIcon.symbol(for: Panel(id: "x.list", title: "List", kind: .list)), "list.bullet")
        XCTAssertEqual(PanelIcon.symbol(for: Panel(id: "convex.dashboard", title: "Convex", icon: "flame")), "flame")
    }

    func testSectionFallsBackToHighlights() {
        let convex = Panel(id: "convex.dashboard", title: "Convex")
        XCTAssertEqual(PanelChoice.section(panels: [convex], hasPatches: true, remembered: nil), .highlights)
        XCTAssertEqual(PanelChoice.section(panels: [convex], hasPatches: true, remembered: "convex.dashboard"), .panel("convex.dashboard"))
        XCTAssertEqual(PanelChoice.section(panels: [], hasPatches: true, remembered: "convex.dashboard"), .highlights)
        XCTAssertEqual(PanelChoice.section(panels: [], hasPatches: true, remembered: PaneSection.patchesId), .patches)
        XCTAssertEqual(PanelChoice.section(panels: [], hasPatches: false, remembered: PaneSection.patchesId), .highlights)
        XCTAssertEqual(PaneSection(id: PaneSection.highlightsId), .highlights)
        XCTAssertEqual(PaneSection.panel("x").id, "x")
    }

    func testClickingTheShowingSectionCollapsesThePane() {
        // The showing one, open: collapse, keeping the choice.
        XCTAssertEqual(PanelChoice.click(.highlights, showing: .highlights, shown: true).shown, false)
        XCTAssertEqual(PanelChoice.click(.highlights, showing: .highlights, shown: true).section, .highlights)
        // Collapsed: opens on it.
        XCTAssertEqual(PanelChoice.click(.highlights, showing: .highlights, shown: false).shown, true)
        // Another: switches, open.
        let other = PanelChoice.click(.panel("convex.dashboard"), showing: .highlights, shown: true)
        XCTAssertEqual(other.section, .panel("convex.dashboard"))
        XCTAssertTrue(other.shown)
    }
}
