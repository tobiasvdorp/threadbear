import SwiftUI
import ThreadbearCore

/// A list to rearrange by dragging anywhere on a row: Mike's runner order,
/// in Settings > Runners and in the Runners panel. System drag and drop only
/// offers a thumbnail and a drop target, and Mike wanted the list to
/// rearrange as you drag (7 Nov, picked from three mockups): the row lifts
/// and floats under the pointer, a dashed slot shows where it'll land, and
/// the others slide round the slot. So the rows are placed by hand, each at
/// the height it measures (ReorderDrag does the arithmetic).
struct ReorderList<Row: View>: View {
    let ids: [String]
    var style: ReorderListStyle
    /// Screenshots only: the first row held mid-drag by this much.
    var preview: CGSize?
    let commit: ([String]) -> Void
    @ViewBuilder let row: (String) -> Row

    private static var space: String { "reorderList" }

    private struct Active {
        let id: String
        let ids: [String]
        let drag: ReorderDrag
        var translation: CGSize = .zero
        var slot: Int
    }

    @State private var active: Active?
    @State private var heights: [String: CGFloat] = [:]
    /// Goes false by itself when a gesture ends in any way, which is the
    /// only word SwiftUI gives of one being cancelled.
    @GestureState private var gestureLive = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var slide: Animation? { reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.82) }

    var body: some View {
        let shown = active?.ids ?? ids
        let layout = active?.drag ?? ReorderDrag(from: 0, heights: measured(shown), spacing: style.spacing)
        ZStack(alignment: .topLeading) {
            if let active {
                // Where it'll land.
                RoundedRectangle(cornerRadius: style.liftCorner - 1, style: .continuous)
                    .strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                    .frame(height: max(0, active.drag.heights[active.drag.from] - 6 + style.liftInset.height * 2))
                    .padding(.horizontal, 2 - style.liftInset.width)
                    .offset(y: active.drag.slotY(active.slot) + 3 - style.liftInset.height)
                    .animation(slide, value: active.slot)
            }
            ForEach(Array(shown.enumerated()), id: \.element) { index, id in
                rowView(id, index: index, count: shown.count, layout: layout)
            }
        }
        .frame(height: layout.totalHeight, alignment: .top)
        .coordinateSpace(name: Self.space)
        .onChange(of: gestureLive) { _, live in
            // A drop clears `active` in onEnded, which can come just after
            // this: only a drag still going a moment later was cancelled.
            guard !live else { return }
            DispatchQueue.main.async { cancel() }
        }
        .onChange(of: ids) { _, next in
            // A row came or went mid-drag: the slots no longer mean what
            // they did. Only the order changing (from the phone) is fine:
            // the drop decides it.
            if let active, Set(active.ids) != Set(next) { cancel() }
        }
        .onAppear(perform: showPreview)
        .onChange(of: preview) { showPreview() }
    }

    private func showPreview() {
        guard let preview, ids.count > 1 else {
            if preview == nil, gestureLive == false { active = nil }
            return
        }
        // After the rows have measured themselves.
        DispatchQueue.main.async {
            let drag = ReorderDrag(from: 0, heights: measured(ids), spacing: style.spacing)
            active = Active(id: ids[0], ids: ids, drag: drag, translation: preview, slot: drag.slot(translationY: preview.height))
        }
    }

    private func measured(_ ids: [String]) -> [CGFloat] {
        ids.map { heights[$0] ?? style.estimatedHeight }
    }

    @ViewBuilder private func rowView(_ id: String, index: Int, count: Int, layout: ReorderDrag) -> some View {
        let dragged = active?.id == id
        let translation = dragged ? active?.translation ?? .zero : .zero
        let y = y(of: index, id: id, translation: translation, layout: layout)
        row(id)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights[id] = $0 }
            .background {
                if dragged {
                    // Solid, as the rows slide underneath it, and lighter
                    // than what's behind so it reads as lifted.
                    RoundedRectangle(cornerRadius: style.liftCorner, style: .continuous)
                        .fill(Color(nsColor: .windowBackgroundColor))
                        .overlay {
                            RoundedRectangle(cornerRadius: style.liftCorner, style: .continuous).fill(.primary.opacity(0.1))
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: style.liftCorner, style: .continuous).strokeBorder(.separator)
                        }
                        .shadow(color: .black.opacity(0.4), radius: 10, y: 5)
                        .padding(.horizontal, -style.liftInset.width)
                        .padding(.vertical, -style.liftInset.height)
                }
            }
            .overlay(alignment: .bottom) {
                // The row's divider: none while anything's lifted, and none on the last.
                if style.dividers, active == nil, index < count - 1 {
                    Divider()
                }
            }
            .contentShape(Rectangle())
            .pointerStyle(dragged ? .grabActive : .grabIdle)
            .rotationEffect(.degrees(dragged && !reduceMotion ? tilt(translation.width) : 0))
            .offset(x: dragged ? drift(translation.width) : 0, y: y)
            // A lifted row follows the pointer exactly; the rest slide.
            .animation(dragged ? nil : slide, value: y)
            .zIndex(dragged ? 1 : 0)
            .highPriorityGesture(
                // Ahead of the row's own buttons (a panel card's header
                // opens its details), which still get a click that doesn't
                // move: the drag only starts 3 points out.
                DragGesture(minimumDistance: 3, coordinateSpace: .named(Self.space))
                    .updating($gestureLive) { _, live, _ in live = true }
                    .onChanged { moved(id, index: index, translation: $0.translation) }
                    .onEnded { _ in drop() }
            )
    }

    private func y(of index: Int, id: String, translation: CGSize, layout: ReorderDrag) -> CGFloat {
        guard let active else { return layout.top(ofRow: index) }
        if active.id == id { return active.drag.draggedY(translationY: translation.height) }
        return active.drag.restingY(ofRow: index, slot: active.slot)
    }

    private func drift(_ width: CGFloat) -> CGFloat { min(max(-style.maxDrift, width * 0.25), style.maxDrift) }
    private func tilt(_ width: CGFloat) -> Double { min(max(-1, Double(width) / 40), 1) }

    private func moved(_ id: String, index: Int, translation: CGSize) {
        var next = active ?? Active(id: id, ids: ids, drag: ReorderDrag(from: index, heights: measured(ids), spacing: style.spacing), slot: index)
        guard next.id == id else { return }
        next.translation = translation
        next.slot = next.drag.slot(translationY: translation.height)
        active = next
    }

    private func drop() {
        guard let done = active else { return }
        withAnimation(slide) {
            active = nil
            if done.slot != done.drag.from { commit(ReorderDrag.moving(done.ids, from: done.drag.from, to: done.slot)) }
        }
    }

    /// Everything goes back where it was, and the order stays as it is.
    private func cancel() {
        guard active != nil else { return }
        withAnimation(slide) { active = nil }
    }
}

/// How a ReorderList's rows look, lifted and at rest.
struct ReorderListStyle {
    var spacing: CGFloat
    /// A row's height before it's measured.
    var estimatedHeight: CGFloat
    /// How far the lifted fill reaches past the row, each side.
    var liftInset: CGSize
    var liftCorner: CGFloat
    /// A divider under each row but the last, as a Form draws them.
    var dividers: Bool
    /// How far the row may drift sideways: a Form cuts off what leaves
    /// its row, about 10 points each side, and the fill takes 5 of those.
    var maxDrift: CGFloat

    /// One Form row of runners in Settings.
    static let formRows = ReorderListStyle(spacing: 0, estimatedHeight: 38, liftInset: CGSize(width: 5, height: 0), liftCorner: 8, dividers: true, maxDrift: 4)
    /// The Runners panel's cards, with a gap between.
    static func cards(spacing: CGFloat) -> ReorderListStyle {
        ReorderListStyle(spacing: spacing, estimatedHeight: 44, liftInset: CGSize(width: 8, height: 6), liftCorner: 10, dividers: false, maxDrift: 6)
    }
}
