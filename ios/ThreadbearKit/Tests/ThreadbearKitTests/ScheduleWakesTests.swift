import Foundation
import Synchronization
import Testing
@testable import ThreadbearKit

/// The inbox's wakes come from phone:wakes (backend API 45), a small row per
/// active schedule, not phone:schedules, which reads every schedule whole and
/// re-runs on every claim and run.
@Suite struct ScheduleWakesTests {
    @Test func wakesFollowsTheSmallRowsAndTheyWakeThreads() async throws {
        let transport = OneAnswerTransport(answer: """
        [{"scheduleId":"s1","threadId":"t1","nextRunAt":"2026-11-08T01:00:00.000Z"},
         {"scheduleId":"s2","threadId":"t1","nextRunAt":"2026-11-08T03:00:00.000Z"},
         {"scheduleId":"s3"}]
        """)
        let backend = ConvexBackend(transport: transport, token: "t")
        var iterator = backend.wakes().makeAsyncIterator()
        let rows = try #require(try await iterator.next())
        #expect(transport.subscribed.withLock { $0 } == ["phone:wakes"])
        #expect(rows.map(\.id) == ["s1", "s2", "s3"])
        #expect(rows.allSatisfy { $0.isActive })
        let wakes = InboxSections.wakes(rows)
        #expect(wakes["t1"]?.id == "s1")
        #expect(wakes.count == 1)
    }

    @Test func fakeWakesAreItsActiveSchedules() async throws {
        let backend = FakeBackend()
        var all = backend.schedules().makeAsyncIterator()
        var some = backend.wakes().makeAsyncIterator()
        let schedules = try #require(try await all.next())
        let wakes = try #require(try await some.next())
        #expect(wakes.map(\.id) == schedules.filter(\.isActive).map(\.id))
    }
}

final class OneAnswerTransport: ConvexTransport {
    let answer: String
    let subscribed = Mutex<[String]>([])
    init(answer: String) { self.answer = answer }
    func mutation(_ name: String, _ args: [String: JSONValue]) async throws -> Data { Data("null".utf8) }
    func query(_ name: String, _ args: [String: JSONValue]) async throws -> Data { Data("null".utf8) }
    func subscribe(_ name: String, _ args: [String: JSONValue]) -> AsyncThrowingStream<Data, Error> {
        subscribed.withLock { $0.append(name) }
        let data = Data(answer.utf8)
        return AsyncThrowingStream { $0.yield(data); $0.finish() }
    }
    func connectionStates() -> AsyncStream<Bool> { AsyncStream { $0.yield(true) } }
}
