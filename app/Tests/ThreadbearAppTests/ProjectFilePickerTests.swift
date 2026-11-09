import AppKit
import XCTest
@testable import Threadbear

@MainActor
final class ProjectFilePickerTests: XCTestCase {
    func testOnlyOnePanelUntilCancelledThenCanOpenAgain() async throws {
        var shown = 0
        var finish: ((NSApplication.ModalResponse) -> Void)?
        let picker = ProjectFilePicker { _, completion in
            shown += 1
            finish = completion
        }
        var results: [URL?] = []
        picker.choose(configure: { _ in }) { results.append($0) }
        picker.choose(configure: { _ in }) { results.append($0) }
        XCTAssertEqual(shown, 0, "presentation leaves the button action before opening AppKit")
        await Task.yield()
        XCTAssertEqual(shown, 1)
        finish?(.cancel)
        XCTAssertEqual(results.count, 1)
        XCTAssertNil(results[0])
        picker.choose(configure: { _ in }) { results.append($0) }
        await Task.yield()
        XCTAssertEqual(shown, 2)
        finish?(.cancel)
    }

    func testAcceptsOnceAndReleasesPanelBeforeCompletion() async throws {
        let url = URL(fileURLWithPath: "/tmp/project-folder")
        var finish: ((NSApplication.ModalResponse) -> Void)?
        var shown = 0
        let picker = ProjectFilePicker { panel, completion in
            if shown == 0 { XCTAssertTrue(panel.canChooseDirectories) }
            shown += 1
            finish = completion
        }
        var results: [URL?] = []
        picker.choose(configure: { $0.canChooseDirectories = true }, makePanel: { SelectedPanel(selection: url) }) {
            results.append($0)
            picker.choose(configure: { _ in }) { _ in }
        }
        await Task.yield()
        let firstFinish = try XCTUnwrap(finish)
        firstFinish(.OK)
        firstFinish(.OK)
        XCTAssertEqual(results, [url])
        await Task.yield()
        XCTAssertEqual(shown, 2, "completion can open a new picker")
        finish?(.cancel)
    }
}

private final class SelectedPanel: NSOpenPanel {
    let selection: URL
    init(selection: URL) {
        self.selection = selection
        super.init(contentRect: .zero, styleMask: [], backing: .buffered, defer: true)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var url: URL? { selection }
}
