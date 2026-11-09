import Foundation

/// A thread's messages on the phone (backend API 2), as far back as you've
/// scrolled: the newest ones live from phone:messages, and older chunks asked
/// for once each with beforeSeq.
///
/// The live page grows by raising its limit, as far as the server lets one
/// query go (`liveMax`, phone:messages' PAGE_MAX, or fewer rows when they're
/// big). Past that it used to be stuck on "Loading…" for good, about 5,500
/// messages short of the start of a 7,500-message thread (8 Nov). Older rows
/// now come in chunks from where the shown ones begin.
public struct MessageHistory: Sendable, Equatable {
    /// The most rows one phone:messages query returns (PAGE_MAX in convex/phone.ts).
    public static let liveMax = 2000

    /// The newest messages, live.
    public private(set) var live: MessagePage?
    /// The limit `live` was asked for with; a bigger one is on its way while
    /// it isn't the one asked for now.
    public private(set) var liveLimit = 0
    /// Older messages from chunks, oldest first, all before `live`'s.
    public private(set) var older: [PhoneMessage] = []
    public private(set) var olderImages: [MessageImage] = []
    /// Whether there's more before `older`; nil until a chunk has come.
    public private(set) var olderHasMore: Bool?
    /// From the first ask for a chunk: the live page no longer grows, and
    /// rows that slide off its top as new ones come in move to `older`, or
    /// there'd be a hole between the two.
    public private(set) var chunked = false

    public init() {}

    public var messages: [PhoneMessage] { older + (live?.messages ?? []) }

    /// The pictures of every row shown, each once.
    public var images: [MessageImage] {
        var seen = Set<String>()
        return (olderImages + (live?.images ?? [])).filter { seen.insert($0.url).inserted }
    }

    public var hasMore: Bool { olderHasMore ?? (live?.hasMore ?? false) }

    public var firstSeq: Int? { older.first?.seq ?? live?.messages.first?.seq }

    /// A new value of the live query, asked for with `limit`.
    public mutating func takeLive(_ page: MessagePage, limit: Int) {
        if chunked, let old = live, let first = page.messages.first?.seq {
            if let last = old.messages.last?.seq, last < first {
                // Nothing in common with the page before (the phone was away
                // while a whole page of new messages came): what's between
                // them is unknown, so start again from the newest rather
                // than show a hole.
                self = MessageHistory()
            } else {
                // Its top can also move back up (big rows above the byte cap
                // that got smaller): those rows are the live page's again.
                older.removeAll { $0.seq >= first }
                olderImages.removeAll { $0.seq >= first }
                let after = older.last?.seq ?? Int.min
                older += old.messages.filter { $0.seq < first && $0.seq > after }
                olderImages += old.images.filter { $0.seq < first && $0.seq > after }
            }
        }
        live = page
        liveLimit = limit
    }

    /// What "Load earlier" should do next.
    public enum Next: Equatable {
        /// Ask the live query for more.
        case grow(limit: Int)
        /// Ask for a chunk of older rows before this seq.
        case older(before: Int)
        /// Nothing: there's no more, or more is on its way.
        case none
    }

    public func next(limit: Int, step: Int) -> Next {
        guard let live, hasMore, liveLimit == limit else { return .none }
        // A full page under the server's most: more of it. One that came back
        // short of what was asked had reached what one query may read.
        if !chunked, live.messages.count >= limit, limit < Self.liveMax {
            return .grow(limit: min(limit + step, Self.liveMax))
        }
        return firstSeq.map { .older(before: $0) } ?? .none
    }

    /// Before asking for the first chunk: from now on the live page's
    /// rows are kept as it slides.
    public mutating func startChunks() { chunked = true }

    /// A chunk of rows before `seq`. False, and nothing changes, if the
    /// shown rows no longer start there (it came too late).
    @discardableResult
    public mutating func takeOlder(_ chunk: MessagePage, before seq: Int) -> Bool {
        guard seq == firstSeq else { return false }
        older = chunk.messages.filter { $0.seq < seq } + older
        olderImages = chunk.images.filter { $0.seq < seq } + olderImages
        olderHasMore = chunk.hasMore
        return true
    }
}
