import Foundation
import Testing
@testable import Threadbear

/// The Browser panel's plain logic. The real checks need a browser: they're in
/// BrowserBear's tests and agent/agent-host.mjs comments (5 and 8 Nov 2026).
struct AgentBrowserTests {
    @Test func aThreadsTabsDecodeFromTheHostsFile() throws {
        let json = """
        {"tabId":1004,"targetId":"AB","url":"https://example.com/","title":"Example","thread":"t1",
         "state":"yours","action":"over to you","finish":true,"status":"complete","handoffs":2,"openedAt":1,"popup":false}
        """
        let tab = try JSONDecoder().decode(AgentTab.self, from: Data(json.utf8))
        #expect(tab.tabId == 1004 && tab.thread == "t1" && tab.state == "yours" && tab.handoffs == 2)
    }

    /// Tabs a host wrote before it knew of a field, or that no thread owns.
    @Test func missingFieldsAreFine() throws {
        let json = #"{"tabId":1,"targetId":"A","url":"about:blank","title":""}"#
        let tab = try JSONDecoder().decode(AgentTab.self, from: Data(json.utf8))
        #expect(tab.thread == nil && tab.handoffs == nil)
    }

    @Test func existingChromeTabsKeepTheirProfileAndThreadWithoutADebuggingPort() throws {
        let json = #"{"tabId":24,"url":"https://github.com/","title":"GitHub","thread":"t1","bridge":true,"profile":"personal-id","profileName":"Personal","profileEmail":"me@example.com"}"#
        let tab = try JSONDecoder().decode(AgentTab.self, from: Data(json.utf8))
        #expect(tab.bridge == true && tab.targetId == nil)
        #expect(tab.profile == "personal-id" && tab.profileTitle == "Personal · me@example.com")
        #expect(tab.id == "personal-id/24")
    }

    /// The same tab number in the agents' browser is another page.
    @Test func aTabInTheAgentsBrowserIsKeptApartFromOneInChrome() throws {
        let tab = try JSONDecoder().decode(AgentTab.self, from: Data(#"{"tabId":24,"url":"https://github.com/","title":"GitHub"}"#.utf8))
        #expect(tab.profileId == AgentBrowser.agentsBrowser && tab.id == "agent-chrome/24")
    }

    /// Frames come in many reads, several lines can share one, and a reply
    /// can follow a frame in the same read: every line comes out whole, in order.
    @Test func thePipeSplitsLinesAcrossAndWithinReads() async throws {
        let path = "/tmp/tb-pipe-\(getpid())-\(UInt32.random(in: 0...UInt32.max)).sock"
        unlink(path)
        defer { unlink(path) }
        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in _ = path.withCString { strcpy(buf.baseAddress!.assumingMemoryBound(to: CChar.self), $0) } }
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        #expect(bound == 0)
        listen(server, 1)
        let big = String(repeating: "x", count: 700_000)
        let text = #"{"method":"a","params":{"data":"\#(big)"}}"# + "\n" + #"{"method":"b"}"# + "\n" + #"{"method":"c","params":{"data":"\#(big)"}}"# + "\n"
        let bytes = Array(text.utf8)
        Thread.detachNewThread {
            let client = accept(server, nil, nil)
            var i = 0
            // Uneven pieces, a little apart, so lines straddle reads.
            for size in [5, 300_000, 400_036, 7, 650_000] + [Int](repeating: 100_000, count: 10) where i < bytes.count {
                let end = min(bytes.count, i + size)
                bytes[i..<end].withUnsafeBytes { _ = write(client, $0.baseAddress, $0.count) }
                i = end
                usleep(2_000)
            }
            usleep(500_000)
            close(client)
            close(server)
        }
        let pipe = BrowserBearPipe(path: path)
        let got = try await withCheckedThrowingContinuation { (done: CheckedContinuation<[String], Error>) in
            var seen: [String] = []
            pipe.onEvent = { m in
                seen.append("\(m["method"] ?? "")\(((m["params"] as? [String: Any])?["data"] as? String)?.count ?? 0)")
                if seen.count == 3 { done.resume(returning: seen) }
            }
        }
        pipe.close()
        #expect(got == ["a700000", "b0", "c700000"])
    }
}
