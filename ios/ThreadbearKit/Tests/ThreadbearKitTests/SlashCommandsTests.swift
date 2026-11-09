import Foundation
import Testing
@testable import ThreadbearKit

/// The phone's slash command palette (backend API 61): the list comes back
/// as a slashCommands command's result.
struct SlashCommandsTests {
    @Test func aCommandsResultDecodesAsTheList() throws {
        let json = #"{"state":"done","result":[{"name":"compact","source":"cli"},{"name":"deslop","description":"Clean","source":"skill","scope":"user","path":"/u/.claude/skills/deslop/SKILL.md"}]}"#
        let status = try JSONDecoder().decode(CommandStatus.self, from: Data(json.utf8))
        #expect(status.commands?.map(\.name) == ["compact", "deslop"])
        #expect(status.commands?.last?.path == "/u/.claude/skills/deslop/SKILL.md")
    }

    @Test func anyOtherResultReadsAsNone() throws {
        for json in [#"{"state":"done","result":{"items":[]}}"#, #"{"state":"pending"}"#] {
            let status = try JSONDecoder().decode(CommandStatus.self, from: Data(json.utf8))
            #expect(status.commands == nil)
        }
    }

    @Test func theFakeAnswersWithAList() async throws {
        let backend = FakeBackend()
        let id = try await backend.slashCommands(threadId: "t1")
        for try await status in backend.command(id) {
            #expect(status?.state == .done)
            #expect(status?.commands?.isEmpty == false)
            break
        }
    }
}
