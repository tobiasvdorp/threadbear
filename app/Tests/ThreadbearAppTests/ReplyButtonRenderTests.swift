import AppKit
import XCTest
@testable import Threadbear
import ThreadbearCore

/// `[title](button:<id>)` in a reply draws as a pill in its button's
/// state, and draws again when the state changes.
@MainActor
final class ReplyButtonRenderTests: XCTestCase {
    private func unique() -> String { "t" + UUID().uuidString.prefix(7).lowercased() }

    private func pill(_ text: NSAttributedString) -> (range: NSRange, id: String, look: String?)? {
        var found: (NSRange, String, String?)?
        text.enumerateAttribute(.tbReplyButton, in: NSRange(location: 0, length: text.length)) { value, range, stop in
            guard let id = value as? String else { return }
            found = (range, id, text.attribute(.tbReplyLook, at: range.location, effectiveRange: nil) as? String)
            stop.pointee = true
        }
        return found
    }

    func testAnUnknownButtonIsItsWordsAlone() {
        let text = MarkdownRenderer.render("Do it: [Fill in the form](button:\(unique()))").string
        XCTAssertEqual(text.string, "Do it: Fill in the form")
        XCTAssertNil(pill(text))
        XCTAssertNil(text.attribute(.link, at: text.length - 1, effectiveRange: nil), "not clickable")
    }

    func testAKnownButtonIsAPillThatFollowsItsState() throws {
        let id = unique()
        let store = ReplyButtons.shared
        let button = ReplyButton(id: id, title: "Fill in the form", start: .init(text: "Fill in the replacement form.", cwd: "/Users/mike/dev/me/misc"))
        store.receive(button, threadId: "th1")
        let markdown = "Pebble wants your address. [Fill in the form](button:\(id))"

        let fresh = MarkdownRenderer.render(markdown).string
        let found = try XCTUnwrap(pill(fresh))
        XCTAssertEqual(found.id, id)
        XCTAssertEqual(found.look, "start")
        XCTAssertEqual((fresh.string as NSString).substring(with: found.range), "\u{25B6}\u{FE0E}\u{00A0}Fill\u{00A0}in\u{00A0}the\u{00A0}form")
        XCTAssertEqual(fresh.attribute(.toolTip, at: found.range.location, effectiveRange: nil) as? String,
                       "Starts a thread in misc: Fill in the replacement form.")
        XCTAssertNil(fresh.attribute(.link, at: found.range.location, effectiveRange: nil), "a pill, not a link")

        store.setPressing(id, true)
        XCTAssertEqual(pill(MarkdownRenderer.render(markdown).string)?.look, "pressing", "the block's cache keys on the buttons")
        var pressed = button
        pressed.pressed = .init(at: "2026-11-07T09:00:00Z", threadId: "th_started")
        store.receive(pressed, threadId: "th1")
        store.setPressing(id, false)
        let done = MarkdownRenderer.render(markdown).string
        XCTAssertEqual(pill(done)?.look, "pressed")
        XCTAssertTrue(done.string.hasSuffix("\u{2713}\u{00A0}Fill\u{00A0}in\u{00A0}the\u{00A0}form"))
    }

    func testARowLinkingAButtonRendersAgainWhenItChanges() {
        let id = unique()
        let row = TranscriptRow(id: "a:m1", seq: 3, turnId: "t1", content: .assistant(TextItem(itemId: "m1", text: "[Go](button:\(id))", isStreaming: false)))
        let plain = TranscriptRow(id: "a:m2", seq: 4, turnId: "t1", content: .assistant(TextItem(itemId: "m2", text: "No buttons here", isStreaming: false)))
        let before = RenderCache.key(row, expanded: false, width: 800)
        let plainBefore = RenderCache.key(plain, expanded: false, width: 800)
        ReplyButtons.shared.receive(ReplyButton(id: id, title: "Go", start: .init(text: "Go", cwd: "/tmp")), threadId: "th1")
        XCTAssertNotEqual(RenderCache.key(row, expanded: false, width: 800), before)
        XCTAssertEqual(RenderCache.key(plain, expanded: false, width: 800), plainBefore, "other rows keep their renders")
        XCTAssertTrue(RenderCache.holdsButtons(row))
        XCTAssertFalse(RenderCache.holdsButtons(plain))
    }

    /// Daybreak, 8 Nov: a thread open in a panel of its own (B) puts its
    /// asks in a composer card, outside any transcript table. A pill there
    /// was taken as pressed from the main panel's thread (A), so B's ask
    /// could carry A's copied `button:` link and press A's full-access
    /// button. Text knows its thread from the view it's in, or has none.
    func testAPillInAPanelsComposerCardIsPressedFromThatThreadNeverTheSelection() {
        let app = AppModel.shared
        let saved = (app.selection, app.errorMessage)
        defer { app.selection = saved.0; app.errorMessage = saved.1 }
        let a = unique(), b = unique(), id = unique()
        ReplyButtons.shared.receive(ReplyButton(id: id, title: "Ship it", start: .init(text: "Ship it", cwd: "/tmp", permissionMode: "full")), threadId: a)
        app.selection = a

        // B's composer card, in a panel of its own.
        let controller = TranscriptController()
        let session = ThreadSession(threadId: b, app: app)
        controller.show(session)
        let card = ComposerCardHost(controller: controller)
        let ask = TranscriptRow(id: "ak:1", seq: 1, turnId: "t1", content: .asks(AsksCard(seq: 1, asks: [Ask(action: "Press [Ship it](button:\(id))", why: "")])))
        card.show(ask, threadId: b)
        let text = TranscriptTextView()
        card.addSubview(text)
        XCTAssertEqual(text.transcriptThreadId, b, "the card's own thread, not the selection")
        app.errorMessage = nil
        app.pressReplyButton(id, from: text.transcriptThreadId)
        XCTAssertEqual(app.errorMessage, "That button belongs to another thread, so it can't be pressed from here.")
        XCTAssertNil(ReplyButtons.shared.known(id)?.button.pressed)

        // The controller moving on to A before the card has B's asks out
        // of it: a press then is nobody's, not A's (Codex's review).
        let sessionA = ThreadSession(threadId: a, app: app)
        controller.show(sessionA)
        XCTAssertNil(text.transcriptThreadId)
        card.show(ask, threadId: a)
        XCTAssertEqual(text.transcriptThreadId, a, "once it's A's card, it's A's")
        _ = sessionA

        // A card with no thread, or text in no thread's view, presses nothing.
        card.show(ask, threadId: b)
        controller.show(nil)
        XCTAssertNil(text.transcriptThreadId)
        let loose = TranscriptTextView()
        NSView().addSubview(loose)
        XCTAssertNil(loose.transcriptThreadId)
        app.errorMessage = nil
        app.pressReplyButton(id, from: loose.transcriptThreadId)
        XCTAssertEqual(app.errorMessage, "That button belongs to another thread, so it can't be pressed from here.")
    }
}
