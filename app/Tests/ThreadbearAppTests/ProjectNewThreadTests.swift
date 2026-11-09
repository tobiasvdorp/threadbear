import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// New Thread on a project's page: the new-thread box in the project's
/// first folder, the thread joining the project as it's made.
@MainActor
final class ProjectNewThreadTests: XCTestCase {
    func testNewThreadInAProjectStartsInItsFolder() {
        let app = AppModel()
        let project = Project(id: "p_walk", title: "Walkies", folders: ["/tmp/walkies", "/tmp/walkies-backend"])
        app.newThread(in: project)
        XCTAssertNil(app.selection)
        XCTAssertEqual(app.newThreadProjectId, "p_walk")
        XCTAssertEqual(app.newThreadCwd, "/tmp/walkies")
        XCTAssertNil(app.openProjectId, "the project page gives way to the new thread")
    }

    func testAPlainNewThreadIsntInAProject() {
        let app = AppModel()
        app.newThread(in: Project(id: "p_walk", title: "Walkies", folders: []))
        XCTAssertEqual(app.newThreadProjectId, "p_walk")
        XCTAssertNil(app.newThreadCwd, "no folder: the default one")
        app.newThread()
        XCTAssertNil(app.newThreadProjectId)
    }

    /// Codex's review: a folder or another Mac's login left from an
    /// earlier draft came along, and the In chip stayed after picking
    /// another Mac.
    func testNothingFromAnEarlierDraftComesAlong() {
        let app = AppModel()
        app.newThreadCwd = "/tmp/repo-a"
        app.newThread(in: Project(id: "p_walk", title: "Walkies", folders: []))
        XCTAssertNil(app.newThreadCwd, "the default folder, not repo-a")
        app.newThreadRunnerId = "bruce"
        app.newThreadAccount = "bruce-claude"
        app.newThread(in: Project(id: "p_walk", title: "Walkies", folders: ["/tmp/walkies"]))
        XCTAssertNil(app.newThreadRunnerId)
        XCTAssertNil(app.newThreadAccount, "another Mac's login doesn't come back to this one")
        XCTAssertEqual(app.newThreadCwd, "/tmp/walkies")
        app.chooseNewThreadRunner("bruce")
        XCTAssertNil(app.newThreadProjectId, "a project is this Mac's")
    }

    func testTheRequestCarriesTheProject() {
        var request = NewThreadRequest(text: "hi", cwd: "/tmp/walkies")
        XCTAssertEqual(request.projectIds, [])
        request.projectIds = ["p_walk"]
        XCTAssertEqual(request.projectIds, ["p_walk"])
    }
}
