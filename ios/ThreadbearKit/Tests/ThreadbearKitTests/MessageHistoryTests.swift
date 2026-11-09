import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct MessageHistoryTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func page(_ seqs: ClosedRange<Int>, hasMore: Bool, images: [Int] = []) -> MessagePage {
        MessagePage(messages: seqs.map { PhoneMessage(seq: $0, role: $0 % 2 == 0 ? .assistant : .user, text: "m\($0)", at: t0) },
                    hasMore: hasMore,
                    images: images.map { MessageImage(seq: $0, url: "https://x/\($0).png") })
    }

    /// Under the server's most, a full page grows the live query, as before.
    @Test func aFullLivePageGrows() {
        var h = MessageHistory()
        h.takeLive(page(921...1000, hasMore: true), limit: 80)
        #expect(h.next(limit: 80, step: 200) == .grow(limit: 280))
        // While the bigger page is on its way, nothing more.
        #expect(h.next(limit: 280, step: 200) == .none)
    }

    /// At the server's most (2,000 rows) the live page can't grow: the 8 Nov
    /// bug, stuck on "Loading…" for good. Older rows come as a chunk instead.
    @Test func atTheServersMostItAsksForAnOlderChunk() {
        var h = MessageHistory()
        h.takeLive(page(5501...7500, hasMore: true), limit: 2000)
        #expect(h.next(limit: 2000, step: 200) == .older(before: 5501))
        // Asked for 2,080 by an older build: the server still sends 2,000.
        var asked = MessageHistory()
        asked.takeLive(page(5501...7500, hasMore: true), limit: 2080)
        #expect(asked.next(limit: 2080, step: 200) == .older(before: 5501))
    }

    /// Big rows stop a page short of its limit (8 MB a query), with more to come.
    @Test func aPageCutShortByItsSizeAsksForAChunk() {
        var h = MessageHistory()
        h.takeLive(page(901...1000, hasMore: true), limit: 280)
        #expect(h.next(limit: 280, step: 200) == .older(before: 901))
    }

    @Test func chunksGoAboveTheLivePageUntilTheStart() {
        var h = MessageHistory()
        h.takeLive(page(5501...7500, hasMore: true), limit: 2000)
        h.startChunks()
        let took1 = h.takeOlder(page(5301...5500, hasMore: true, images: [5310]), before: 5501)
        #expect(took1)
        #expect(h.messages.map(\.seq) == Array(5301...7500))
        #expect(h.next(limit: 2000, step: 200) == .older(before: 5301))
        let took2 = h.takeOlder(page(1...5300, hasMore: false), before: 5301)
        #expect(took2)
        #expect(h.messages.count == 7500)
        #expect(!h.hasMore)
        #expect(h.next(limit: 2000, step: 200) == .none)
        #expect(h.images.map(\.seq) == [5310])
    }

    /// New messages slide the oldest off a live page of fixed size. Once
    /// chunks are in, those rows stay, or there'd be a hole above the live ones.
    @Test func rowsThatSlideOffTheLivePageStay() {
        var h = MessageHistory()
        h.takeLive(page(5501...7500, hasMore: true, images: [5502]), limit: 2000)
        h.startChunks()
        // Two new messages while the chunk was on its way.
        h.takeLive(page(5503...7502, hasMore: true), limit: 2000)
        #expect(h.firstSeq == 5501)
        let took3 = h.takeOlder(page(5301...5500, hasMore: true), before: 5501)
        #expect(took3)
        #expect(h.messages.map(\.seq) == Array(5301...7502))
        #expect(h.images.map(\.seq) == [5502])
        // And again, after the chunk.
        h.takeLive(page(5504...7503, hasMore: true), limit: 2000)
        #expect(h.messages.map(\.seq) == Array(5301...7503))
    }

    /// Before any chunk, a sliding page just moves: nothing is stitched on.
    @Test func withoutChunksTheLivePageIsAllThereIs() {
        var h = MessageHistory()
        h.takeLive(page(921...1000, hasMore: true), limit: 80)
        h.takeLive(page(922...1001, hasMore: true), limit: 80)
        #expect(h.messages.map(\.seq) == Array(922...1001))
    }

    /// A chunk asked for before rows that are no longer the first is dropped.
    @Test func aLateChunkIsDropped() {
        var h = MessageHistory()
        h.takeLive(page(5501...7500, hasMore: true), limit: 2000)
        h.startChunks()
        let took4 = h.takeOlder(page(5301...5500, hasMore: true), before: 5501)
        #expect(took4)
        let took5 = h.takeOlder(page(5301...5500, hasMore: true), before: 5501)
        #expect(!took5)
        #expect(h.messages.count == 2200)
    }

    /// Away long enough for a whole page of new messages: what came between
    /// is unknown, so it starts again from the newest rather than show a hole.
    @Test func noOverlapWithThePageBeforeStartsAgain() {
        var h = MessageHistory()
        h.takeLive(page(5501...7500, hasMore: true), limit: 2000)
        h.startChunks()
        let took = h.takeOlder(page(5301...5500, hasMore: true), before: 5501)
        #expect(took)
        h.takeLive(page(9601...11600, hasMore: true), limit: 2000)
        #expect(h.messages.map(\.seq) == Array(9601...11600))
        #expect(!h.chunked)
        #expect(h.next(limit: 2000, step: 200) == .older(before: 9601))
    }

    /// The live page's top moving back up (big rows that got smaller) takes
    /// its rows back from the chunks: nothing shows twice.
    @Test func aLivePageReachingFurtherBackTakesItsRowsBack() {
        var h = MessageHistory()
        h.takeLive(page(5501...7500, hasMore: true, images: [5505]), limit: 2000)
        h.startChunks()
        h.takeLive(page(5511...7510, hasMore: true), limit: 2000)
        h.takeLive(page(5490...7510, hasMore: true, images: [5505]), limit: 2000)
        #expect(h.messages.map(\.seq) == Array(5490...7510))
        #expect(h.images.map(\.seq) == [5505])
    }
}
