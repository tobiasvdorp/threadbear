import CoreGraphics

/// The arithmetic of dragging one row through a list of rows, which can
/// differ in height: pure, so it's tested apart from the view that draws it
/// (ReorderList).
public struct ReorderDrag: Equatable, Sendable {
    public let from: Int
    public let heights: [CGFloat]
    public let spacing: CGFloat

    public init(from: Int, heights: [CGFloat], spacing: CGFloat = 0) {
        self.from = from
        self.heights = heights
        self.spacing = spacing
    }

    public init(from: Int, count: Int, rowHeight: CGFloat) {
        self.init(from: from, heights: Array(repeating: rowHeight, count: count))
    }

    public var count: Int { heights.count }

    public var totalHeight: CGFloat {
        heights.reduce(0, +) + spacing * CGFloat(max(0, count - 1))
    }

    /// How far past either end the dragged row may go, as a share of its
    /// height: enough to feel loose without being cut off by the list's bounds.
    private static let overshoot: CGFloat = 0.25

    /// Each row's top as the list stands, before the drag.
    private var tops: [CGFloat] { tops(of: Array(heights.indices)) }

    private func tops(of order: [Int]) -> [CGFloat] {
        var y: CGFloat = 0
        var out = Array(repeating: CGFloat(0), count: count)
        for index in order {
            out[index] = y
            y += heights[index] + spacing
        }
        return out
    }

    /// The slot the row is over: going down, past each row its bottom edge
    /// has passed the middle of; going up, each its top edge has.
    public func slot(translationY: CGFloat) -> Int {
        let tops = tops
        let top = tops[from] + translationY
        let bottom = top + heights[from]
        var slot = from
        if translationY > 0 {
            for row in (from + 1)..<count where bottom > tops[row] + heights[row] / 2 { slot = row }
        } else {
            for row in stride(from: from - 1, through: 0, by: -1) where top < tops[row] + heights[row] / 2 { slot = row }
        }
        return slot
    }

    /// The rows' order with the dragged one moved to `slot`.
    private func order(slot: Int) -> [Int] {
        var rest = Array(heights.indices).filter { $0 != from }
        rest.insert(from, at: min(max(0, slot), rest.count))
        return rest
    }

    /// Where a row sits with nothing dragged.
    public func top(ofRow row: Int) -> CGFloat { tops[row] }

    /// Where a row other than the dragged one sits with the dragged one over `slot`.
    public func restingY(ofRow row: Int, slot: Int) -> CGFloat {
        tops(of: order(slot: slot))[row]
    }

    /// Where the space for the dragged row is, over `slot`.
    public func slotY(_ slot: Int) -> CGFloat {
        tops(of: order(slot: slot))[from]
    }

    /// Where the dragged row floats.
    public func draggedY(translationY: CGFloat) -> CGFloat {
        let height = heights[from]
        let y = tops[from] + translationY
        return min(max(-height * Self.overshoot, y), totalHeight - height + height * Self.overshoot)
    }

    public static func moving(_ ids: [String], from: Int, to: Int) -> [String] {
        guard ids.indices.contains(from), ids.indices.contains(to), from != to else { return ids }
        var next = ids
        next.insert(next.remove(at: from), at: to)
        return next
    }

    /// A list that's only part of `order`, rearranged: those ids take the
    /// places they had between them, in their new order, and the rest stay put.
    public static func merged(_ part: [String], into order: [String]) -> [String] {
        var queue = part[...]
        return order.map { part.contains($0) ? queue.popFirst() ?? $0 : $0 }
    }
}
