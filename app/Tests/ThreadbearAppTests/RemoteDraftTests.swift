import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// A new thread on another runner (the composer's "Runs on"): its pickers
/// and folders are that runner's, and it's made over that runner's
/// connection and listed as its. A new thread on this Mac never is.
@MainActor
final class RemoteDraftTests: XCTestCase {
    /// A login an earlier test left as the last one used would be this
    /// Mac's pick instead of claude-here (saved defaults outlive a run).
    private let keys = [AppModel.lastAccountKey, "lastAccountId.byProvider", "lastAccountId.codex.byProvider", AppModel.defaultRunnerKey,
                        AppModel.directRemoteLinkKey]

    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
    }

    override func tearDown() {
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
        super.tearDown()
    }

    private let bruce = RemoteRunner(id: "r-bruce", name: "bruce", icon: "macmini", online: true,
                                     rpcUrl: URL(string: "ws://127.0.0.1:1/bruce/rpc"), tokenFile: "/tmp/not-read")
    private let bruceLogins: [String: Any] = [
        "runnerVersion": "test", "protocol": 1,
        "accounts": [["id": "claude-bruce", "provider": "claude", "title": "bruce@example.com"]],
        "defaults": ["cwd": "/Users/bruce/dev", "accountId": "claude-bruce"],
        "pools": [],
    ]

    /// This Mac's runner and bruce's, each on a transport that answers
    /// as told and records what it was asked.
    private func app() async throws -> (AppModel, RecordingTransport, RecordingTransport) {
        let app = AppModel()
        let local = RecordingTransport()
        local.answers["threads.create"] = { params in ["thread": ["id": "th_here", "title": "Here", "cwd": params["cwd"] ?? ""]] }
        let client = RPCClient(transport: local)
        try await client.start()
        app.useClientForTesting(client)
        app.accounts = [Account(id: "claude-here", provider: "claude", title: "me@example.com")]
        app.defaults = RunnerDefaults(cwd: "/Users/me/misc", accountId: "claude-here")

        let away = RecordingTransport()
        away.answers["hello"] = { [bruceLogins] _ in bruceLogins }
        away.answers["threads.list"] = { _ in ["threads": []] }
        away.answers["threads.create"] = { params in ["thread": ["id": "th_bruce", "title": "On bruce", "cwd": params["cwd"] ?? "", "accountId": params["accountId"] ?? ""]] }
        // These are the direct link's tests (bruce's own connection, its
        // token and host pin); since 5 Nov the default goes through this
        // Mac's runner and Convex instead, which never touches RemoteClients.
        app.directRemoteLink = true
        app.useRemoteClientsForTesting(RemoteClients(version: "test", makeTransport: { _, _ in away }, readToken: { _ in "token" }, pins: .memory(["/tmp/not-read": "127.0.0.1"])))
        app.remoteRunners = [bruce]
        return (app, local, away)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<400 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testADraftForAnotherRunnerUsesItsLoginsAndGoesThere() async throws {
        let (app, local, away) = try await app()
        app.newThreadCwd = "/Users/me/somewhere-here"
        app.chooseNewThreadRunner(bruce.id)
        XCTAssertNil(app.newThreadCwd, "this Mac's folder means nothing on bruce")
        try await until { app.remoteLogins[self.bruce.id] != nil }

        // Its pickers, folder and request are bruce's.
        XCTAssertEqual(app.logins(for: nil)?.accounts.map(\.id), ["claude-bruce"])
        let settings = ThreadSettings(app: app, thread: nil)
        XCTAssertEqual(settings.accountSections.flatMap(\.items).map(\.id), ["claude-bruce"])
        XCTAssertEqual(settings.cwd, "/Users/bruce/dev")
        XCTAssertEqual(app.newThreadAccountId, "claude-bruce")
        XCTAssertEqual(settings.folderMenu().items.first?.title, "/Users/bruce/dev")
        XCTAssertEqual(settings.folderMenu().items.last?.title, "Other…", "a path typed, not a folder picked on this Mac")
        // A folder from one of bruce's threads is offered too.
        var theirs = ThreadSummary(id: "t_old", title: "Old one", cwd: "/Volumes/CannMedia", status: .idle)
        theirs.runnerId = bruce.id
        app.threads[theirs.id] = theirs
        XCTAssertEqual(app.remoteFolders(bruce.id), ["/Users/bruce/dev", "/Volumes/CannMedia"])
        app.newThreadCwd = "/Volumes/CannMedia"

        app.drafts["new"] = Draft(text: "Check the drive")
        app.send(threadId: nil)
        try await until { app.selection == "th_bruce" }
        let create = try XCTUnwrap(away.params("threads.create").first)
        XCTAssertEqual(create["cwd"] as? String, "/Volumes/CannMedia")
        XCTAssertEqual(create["accountId"] as? String, "claude-bruce")
        XCTAssertEqual(create["text"] as? String, "Check the drive")
        XCTAssertTrue(local.params("threads.create").isEmpty, "never this Mac's runner")
        XCTAssertEqual(app.threads["th_bruce"]?.runnerId, bruce.id, "listed as bruce's, so its calls go there")
        XCTAssertEqual(app.route("th_bruce"), .remote(bruce))
        XCTAssertNil(app.drafts["new"])
        XCTAssertNil(app.newThreadRunnerId, "the next one starts on this Mac again")
    }

    /// The starred runner (the machine menu's Default, Settings > Runners):
    /// new drafts start there, a pick for one draft sticks until it's sent,
    /// and the next draft is back on the default.
    func testNewThreadsStartOnTheDefaultRunner() async throws {
        let (app, local, _) = try await app()
        XCTAssertNil(app.newThreadRunnerId, "this Mac until a default is set")

        app.setDefaultRunner(bruce.id)
        XCTAssertEqual(app.newThreadRunnerId, bruce.id)
        XCTAssertEqual(UserDefaults.standard.string(forKey: AppModel.defaultRunnerKey), bruce.id, "kept across launches")
        XCTAssertTrue(ThreadSettings(app: app, thread: nil).runnerMenu().items.contains { $0.title == "bruce" && $0.badge != nil }, "the star is on bruce")

        // Mike puts this one on this Mac: a runner list refresh leaves it.
        app.chooseNewThreadRunner(nil)
        app.applyDefaultRunner()
        XCTAssertNil(app.newThreadRunnerId)

        // Sent here, so the next draft goes back to bruce.
        app.drafts["new"] = Draft(text: "Tidy my notes")
        app.send(threadId: nil)
        try await until { app.selection == "th_here" }
        XCTAssertEqual(local.params("threads.create").count, 1)
        XCTAssertEqual(app.newThreadRunnerId, bruce.id)

        // An offline default can't take a thread: this Mac instead.
        app.setDefaultRunner(nil)
        app.remoteRunners = [RemoteRunner(id: bruce.id, name: "bruce", online: false, rpcUrl: bruce.rpcUrl, tokenFile: bruce.tokenFile)]
        app.setDefaultRunner(bruce.id)
        XCTAssertNil(app.newThreadRunnerId)
    }

    func testAThisMacDraftNeverGetsARunner() async throws {
        let (app, local, away) = try await app()
        // Chosen and then put back: it's this Mac's again.
        app.chooseNewThreadRunner(bruce.id)
        app.chooseNewThreadRunner(nil)
        XCTAssertEqual(app.logins(for: nil)?.accounts.map(\.id), ["claude-here"])
        XCTAssertEqual(ThreadSettings(app: app, thread: nil).cwd, "/Users/me/misc")

        app.drafts["new"] = Draft(text: "Tidy my notes")
        app.send(threadId: nil)
        try await until { app.selection == "th_here" }
        XCTAssertEqual(local.params("threads.create").first?["accountId"] as? String, "claude-here")
        XCTAssertTrue(away.params("threads.create").isEmpty)
        XCTAssertNil(app.threads["th_here"]?.runnerId)
        XCTAssertEqual(app.route("th_here"), .local)
    }

    func testARunnerThatCantBeReachedKeepsTheDraft() async throws {
        let (app, _, _) = try await app()
        let unreachable = RemoteRunner(id: "r-studio", name: "studio", online: false)
        app.remoteRunners.append(unreachable)
        app.chooseNewThreadRunner(unreachable.id)
        try await until { app.newThreadRunnerProblem != nil }
        app.drafts["new"] = Draft(text: "Render it")
        app.send(threadId: nil)
        try await until { app.errorMessage != nil }
        XCTAssertEqual(app.drafts["new"]?.text, "Render it", "still in the box")
        XCTAssertTrue(app.errorMessage?.contains("studio") == true)
        XCTAssertNil(app.selection)
    }
}

/// A thread on another runner can be archived or put away from its sidebar
/// row while nothing of that runner's is open, so there's no connection to it
/// yet. That connects, rather than failing as if this Mac's runner had gone.
@MainActor
final class RemoteRowActionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
        UserDefaults.standard.removeObject(forKey: AppModel.directRemoteLinkKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: AppModel.directRemoteLinkKey)
        super.tearDown()
    }

    private let bruce = RemoteRunner(id: "r-bruce", name: "bruce", icon: "macmini", online: true,
                                     rpcUrl: URL(string: "ws://127.0.0.1:1/bruce/rpc"), tokenFile: "/tmp/not-read")

    private func app(token: String? = "token") async throws -> (AppModel, RecordingTransport, RecordingTransport) {
        let app = AppModel()
        let local = RecordingTransport()
        let client = RPCClient(transport: local)
        try await client.start()
        app.useClientForTesting(client)

        let away = RecordingTransport()
        away.answers["hello"] = { _ in ["runnerVersion": "test", "protocol": 1, "accounts": [], "defaults": ["cwd": "/Users/bruce/dev", "accountId": "claude-bruce"], "pools": []] }
        away.answers["threads.list"] = { _ in ["threads": []] }
        away.answers["threads.update"] = { params in ["thread": ["id": params["threadId"] ?? "", "title": "On bruce", "archivedAt": "2026-10-31T00:00:00Z"]] }
        away.answers["threads.hibernateWhen"] = { params in ["thread": ["id": params["threadId"] ?? "", "title": "On bruce", "snoozedUntil": "2026-11-01T00:00:00Z"]] }
        // The direct link's own connection, as in RemoteDraftTests.
        app.directRemoteLink = true
        app.useRemoteClientsForTesting(RemoteClients(version: "test", makeTransport: { _, _ in away }, readToken: { _ in token }, pins: .memory(["/tmp/not-read": "127.0.0.1"])))
        app.remoteRunners = [bruce]
        var thread = ThreadSummary(id: "th_bruce", title: "On bruce", status: .idle)
        thread.runnerId = bruce.id
        app.threads[thread.id] = thread
        return (app, local, away)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<800 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testArchivingARowConnectsToItsRunner() async throws {
        let (app, local, away) = try await app()
        XCTAssertNil(app.client(for: "th_bruce"), "nothing of bruce's is open")
        app.archive("th_bruce")
        try await until { app.threads["th_bruce"]?.isArchived == true }
        XCTAssertEqual(app.threads["th_bruce"]?.isArchived, true)
        XCTAssertEqual(away.params("threads.update").count, 1)
        XCTAssertTrue(local.params("threads.update").isEmpty, "it's bruce's thread")
        XCTAssertNil(app.errorMessage)
    }

    func testSwipingARowConnectsToItsRunner() async throws {
        let (app, _, away) = try await app()
        app.archive("th_bruce", slid: true)
        try await until { !away.params("threads.update").isEmpty }
        XCTAssertEqual(away.params("threads.update").count, 1, "a swipe used to do nothing at all")
    }

    func testHibernatingARowConnectsToItsRunner() async throws {
        let (app, _, away) = try await app()
        app.hibernateWhen("th_bruce", said: "tomorrow")
        try await until { !away.params("threads.hibernateWhen").isEmpty }
        XCTAssertEqual(away.params("threads.hibernateWhen").count, 1)
    }

    func testARunnerItCantReachIsNamedAndTheRowComesBack() async throws {
        let (app, _, _) = try await app(token: nil)
        app.archive("th_bruce")
        try await until { app.errorMessage != nil }
        XCTAssertEqual(app.errorMessage, "Can't reach bruce from this Mac. Its runner token isn't on this Mac yet (secrets/runners/r-bruce.token).")
        XCTAssertEqual(app.threads["th_bruce"]?.isArchived, false)
        XCTAssertFalse(app.slidingOff.contains("th_bruce"))
    }
}

/// Answers each request from `answers` by method (an empty result for any
/// other), and records the params of each.
private final class RecordingTransport: RPCTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var sent: [(method: String, params: [String: Any])] = []
    var answers: [String: ([String: Any]) -> [String: Any]] = [:]

    func open() async throws {}

    func send(_ text: String) async throws {
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let method = object["method"] as? String else { return }
        let params = object["params"] as? [String: Any] ?? [:]
        lock.withLock { sent.append((method, params)) }
        // The auth handshake has no id; nothing to answer.
        guard let id = object["id"] else { return }
        let result = answers[method]?(params) ?? [:]
        push(["jsonrpc": "2.0", "id": id, "result": result])
    }

    func params(_ method: String) -> [[String: Any]] {
        lock.withLock { sent.filter { $0.method == method }.map(\.params) }
    }

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !inbox.isEmpty {
                let data = inbox.removeFirst()
                lock.unlock()
                continuation.resume(returning: data)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func close() {
        lock.lock()
        let waiting = waiter
        waiter = nil
        lock.unlock()
        waiting?.resume(throwing: RPCError.disconnected("closed"))
    }

    private func push(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        lock.lock()
        if let waiting = waiter {
            waiter = nil
            lock.unlock()
            waiting.resume(returning: data)
        } else {
            inbox.append(data)
            lock.unlock()
        }
    }
}

/// Pictures for another runner's thread. On 8 Nov Mike pasted one into a new
/// thread on Hetzner Cloud and the banner said "Pictures can't go to Hetzner
/// Cloud from this Mac yet." Through Convex (the default) they go now: this
/// Mac's runner uploads them with the message (docs/protocol.md, "Other
/// runners' threads through the backend", Pictures). The direct link still
/// can't carry them, and says how to send them instead.
@MainActor
final class RemotePicturesTests: XCTestCase {
    private let keys = [AppModel.lastAccountKey, "lastAccountId.byProvider", "lastAccountId.codex.byProvider", AppModel.defaultRunnerKey,
                        AppModel.directRemoteLinkKey]

    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
    }

    override func tearDown() {
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
        super.tearDown()
    }

    private let cloud = RemoteRunner(id: "r-cloud", name: "Hetzner Cloud", icon: "cloud", online: true)
    private let picture = ImageRef(path: "/runner/inbox/a.png", mediaType: "image/png")

    private func app(direct: Bool = false) async throws -> (AppModel, RecordingTransport) {
        let app = AppModel()
        let local = RecordingTransport()
        local.answers["threads.create"] = { _ in ["thread": ["id": "th_cloud", "title": "On the cloud", "cwd": "/root"]] }
        local.answers["threads.send"] = { _ in ["turnId": ""] }
        let client = RPCClient(transport: local)
        try await client.start()
        app.useClientForTesting(client)
        app.accounts = [Account(id: "claude-here", provider: "claude", title: "me@example.com")]
        app.defaults = RunnerDefaults(cwd: "/Users/me/misc", accountId: "claude-here")
        app.directRemoteLink = direct
        app.remoteRunners = [cloud]
        return (app, local)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<400 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testANewThreadOnAnotherRunnerTakesItsPicturesThroughConvex() async throws {
        let (app, local) = try await app()
        app.chooseNewThreadRunner(cloud.id)
        XCTAssertNil(app.picturesRefusal(for: nil), "pasting one is fine")
        app.drafts["new"] = Draft(text: "Why does it look like this?", images: [picture])
        app.send(threadId: nil)
        try await until { app.selection == "th_cloud" }
        XCTAssertNil(app.errorMessage)
        let create = try XCTUnwrap(local.params("threads.create").first)
        XCTAssertEqual(create["runnerId"] as? String, cloud.id, "this Mac's runner sends it on")
        let images = try XCTUnwrap(create["images"] as? [[String: Any]])
        XCTAssertEqual(images.map { $0["path"] as? String }, [picture.path])
        XCTAssertNil(app.drafts["new"])
    }

    func testAMessageToAnotherRunnersThreadTakesItsPictures() async throws {
        let (app, local) = try await app()
        var thread = ThreadSummary(id: "t_cloud", title: "On the cloud", cwd: "/root", status: .idle)
        thread.runnerId = cloud.id
        app.threads[thread.id] = thread
        XCTAssertNil(app.picturesRefusal(for: thread))
        app.drafts[thread.id] = Draft(text: "This one", images: [picture])
        app.send(threadId: thread.id)
        try await until { !local.params("threads.send").isEmpty }
        let send = try XCTUnwrap(local.params("threads.send").first)
        XCTAssertEqual((send["images"] as? [[String: Any]])?.count, 1)
        XCTAssertNil(app.errorMessage)
    }

    func testTheDirectLinkSaysHowToSendThemAndKeepsTheDraft() async throws {
        let (app, local) = try await app(direct: true)
        app.remoteRunners = [RemoteRunner(id: cloud.id, name: cloud.name, online: true, rpcUrl: URL(string: "ws://127.0.0.1:1/rpc"), tokenFile: "/tmp/not-read")]
        app.chooseNewThreadRunner(cloud.id)
        let why = try XCTUnwrap(app.picturesRefusal(for: nil))
        XCTAssertTrue(why.contains("Hetzner Cloud") && why.contains("Connect to other machines directly"), why)
        let draft = Draft(text: "Look", images: [picture])
        app.drafts["new"] = draft
        app.send(threadId: nil)
        XCTAssertEqual(app.errorMessage, why)
        XCTAssertEqual(app.drafts["new"], draft, "still in the box")
        XCTAssertTrue(local.params("threads.create").isEmpty)
    }

    func testThisMacsOwnThreadsAreNeverRefused() async throws {
        let (app, _) = try await app(direct: true)
        XCTAssertNil(app.picturesRefusal(for: ThreadSummary(id: "here", title: "Here", cwd: "/Users/me", status: .idle)))
        XCTAssertNil(app.picturesRefusal(for: nil), "a new thread on this Mac")
    }
}
