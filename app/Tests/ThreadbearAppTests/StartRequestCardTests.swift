import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Another runner's request for a thread (docs/protocol.md, "Asking another
/// runner"). On 8 Nov the cloud's agent asked for a folder that isn't on
/// this Mac, and Mike only found out from the error bar after Start it: the
/// card says so first.
@MainActor
final class StartRequestCardTests: XCTestCase {
    private func decode(_ json: String) throws -> StartRequest {
        try JSONDecoder().decode(StartRequest.self, from: Data(json.utf8))
    }

    private let base = #"""
    "request": { "runnerName": "Hetzner Cloud", "threadId": "t1", "target": "main", "text": "Open both apps.", "cwd": "/srv/threadbear" },
    "target": { "id": "m5", "name": "M5", "self": true },
    "runners": [{ "id": "m5", "name": "M5", "self": true }],
    "fingerprint": "abc"
    """#

    func testAFolderThatIsNotHereIsSaidBeforeStartIt() throws {
        let info = try decode("{\(base), \"missingFolder\": \"/srv/threadbear\"}")
        XCTAssertEqual(info.missingFolder, "/srv/threadbear")
        let title = RowRenderer.startRequestTitle(info).string
        XCTAssertTrue(title.contains("/srv/threadbear isn't a folder on this Mac"), title)
    }

    func testARunnerFromBeforeItSaysNothingExtra() throws {
        let info = try decode("{\(base)}")
        XCTAssertNil(info.missingFolder)
        XCTAssertFalse(RowRenderer.startRequestTitle(info).string.contains("isn't a folder"))
    }
}
