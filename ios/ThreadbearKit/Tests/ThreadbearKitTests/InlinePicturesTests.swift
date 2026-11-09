import Foundation
import Testing
@testable import ThreadbearKit

/// docs/protocol.md, "Pictures in a message", on the phone.
struct InlinePicturesTests {
    let m = InlinePictures.markString

    @Test func photosGoInWhereTheCursorIsWithASpaceEitherSide() {
        let one = InlinePictures.inserting(1, in: "compare this with that", replacing: NSRange(location: 12, length: 0))
        #expect(one.text == "compare this \(m) with that")
        #expect(one.firstIndex == 0)
        #expect(one.cursor == 14)
        // Two more at the end: after the first photo, spaced.
        let more = InlinePictures.inserting(2, in: one.text, replacing: NSRange(location: (one.text as NSString).length, length: 0))
        #expect(more.text == "compare this \(m) with that \(m) \(m) ")
        #expect(more.firstIndex == 1)
        // In place of a selection, and clamped past the end.
        #expect(InlinePictures.inserting(1, in: "a bad word", replacing: NSRange(location: 2, length: 3)).text == "a \(m) word")
        #expect(InlinePictures.inserting(1, in: "", replacing: NSRange(location: 9, length: 4)).text == "\(m) ")
    }

    @Test func marksGoAsNumberedMarkersAndPhotosAloneAsNoWords() {
        #expect(InlinePictures.sentText("this \(m) like \(m)") == "this [Picture 1] like [Picture 2]")
        #expect(InlinePictures.sentText("\(m) \(m) ") == "")
        #expect(InlinePictures.sentText("plain") == "plain")
    }

    @Test func eachPhotoHasOneMark() {
        #expect(InlinePictures.normalized("look", count: 2) == "look \(m) \(m)")
        #expect(InlinePictures.normalized("a \(m) b \(m)", count: 1) == "a \(m) b ")
        #expect(InlinePictures.removingMark(0, from: "this \(m) that") == "this that")
    }

    /// A message's markers become chips, the first naming each number.
    @Test func aMessageSplitsIntoWordsAndChips() {
        #expect(InlinePictures.pieces("this [Picture 1] like [Picture 2], see [Picture 1] again") == [
            .words("this "), .picture(1), .words(" like "), .picture(2), .words(", see [Picture 1] again"),
        ])
        #expect(InlinePictures.pieces("[Picture 1]") == [.picture(1)])
        #expect(InlinePictures.unplaced("this [Picture 1] and [Picture 2]", count: 2) == 0)
        #expect(InlinePictures.unplaced("see [Picture 2]", count: 3) == 2)
        #expect(InlinePictures.pieces("no pictures [picture 1] [Picture 0]") == [.words("no pictures [picture 1] [Picture 0]")])
    }

    /// The runner's "[2 pictures]" line goes once the photos are there to
    /// show, and only then.
    @Test func sentPhotosReplaceTheirLine() {
        let photo = { (seq: Int, n: Int) in MessageImage(seq: seq, src: "picture:\(n)", url: "https://x/\(seq)-\(n)") }
        let both = ThreadPictures([photo(5, 2), photo(5, 1), photo(4, 1), MessageImage(seq: 5, src: "/a.png", url: "https://x/a")])
        #expect(both.pasted(seq: 5).map(\.url) == ["https://x/5-1", "https://x/5-2"])
        #expect(both.words(of: "look\n\n[2 pictures]", seq: 5) == "look")
        #expect(both.words(of: "[2 pictures]", seq: 5) == "")
        // One kept on the Mac: the line stays.
        #expect(ThreadPictures([photo(5, 1)]).words(of: "look\n\n[2 pictures]", seq: 5) == "look\n\n[2 pictures]")
        // A marker places picture 1, so the line counts only picture 2.
        #expect(ThreadPictures([photo(5, 2)]).words(of: "this [Picture 1]\n\n[1 picture]", seq: 5) == "this [Picture 1]")
        #expect(ThreadPictures().words(of: "plain words", seq: 5) == "plain words")
    }
}
