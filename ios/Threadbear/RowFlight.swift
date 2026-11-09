import SwiftUI
import ThreadbearKit

/// Where each inbox row and heading is on screen, kept up by the rows as they're
/// laid out, so a row changing heading can be drawn where it was and flown to
/// where it's gone. Starred, Inbox and Running are real List sections, so their
/// headings stick to the top while scrolling, and a List only fades a row from
/// one section to another; the flight is what makes it look like it moved.
///
/// Not observed: every row reports here each frame while scrolling, and nothing
/// should redraw for that. It's only read when a row changes heading.
@MainActor final class RowFrames {
    private var frames: [String: CGRect] = [:]

    static func row(_ threadId: String, under section: PhoneSection) -> String { "\(section.rawValue):\(threadId)" }
    static func heading(_ section: PhoneSection) -> String { "heading:\(section.rawValue)" }
    /// The list's own frame: a row or heading only counts if it's on show in it.
    static let list = "list"

    subscript(key: String) -> CGRect? {
        get { frames[key] }
        set { frames[key] = newValue }
    }

    /// Where it is, if any of it is on screen in the list.
    func visible(_ key: String) -> CGRect? {
        guard let frame = frames[key] else { return nil }
        guard let list = frames[Self.list] else { return frame }
        return list.intersects(frame) ? frame : nil
    }
}

/// A row on its way from one heading to another (AppModel.flights): drawn over
/// the list where it was, flown to where its real row now is, which stays hidden
/// until it lands. Out of a folded heading it rises from that heading; into one,
/// it sinks into it.
struct RowFlight: Identifiable, Equatable {
    let id: String
    /// As it is now, under its new heading.
    let thread: PhoneThread
    let move: InboxMove
    let from: CGRect
    /// `from` is a folded heading, not the row itself.
    let fromHeading: Bool
}

extension View {
    /// Keeps `RowFrames` told where this is, for a row's flight.
    func reportsFrame(_ key: String, to frames: RowFrames) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames[key] = $0 }
            .onDisappear { frames[key] = nil }
    }
}

/// Over the inbox list, the rows in flight. Taps and scrolls go straight through
/// to the list underneath, and it's clipped to the list so a row never flies
/// over the search field or the toolbar.
struct RowFlightLayer: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            ZStack(alignment: .topLeading) {
                // No fade in or out: the list's change is animated, and a fading
                // picture showed the rows it passed through it.
                ForEach(Array(model.flights.values)) { FlyingRow(flight: $0, origin: origin).transition(.identity) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .reportsFrame(RowFrames.list, to: model.rowFrames)
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct FlyingRow: View {
    @Environment(AppModel.self) private var model
    let flight: RowFlight
    let origin: CGPoint
    /// Where it's drawn now; nil until it knows the size of the row it's
    /// rising out of a heading as.
    @State private var rect: CGRect?
    @State private var shown = 1.0

    init(flight: RowFlight, origin: CGPoint) {
        self.flight = flight
        self.origin = origin
        // Over the row from the first frame, so it never blinks out.
        _rect = State(initialValue: flight.fromHeading ? nil : flight.from)
    }

    var body: some View {
        if let rect {
            let thread = flight.thread
            ThreadRow(thread: thread, underRunning: flight.move.to == .running,
                      wake: flight.move.to == .hibernating ? model.wakes[thread.threadId] : nil,
                      asleep: flight.move.to == .starred && InboxSections.isSnoozed(thread, now: model.now))
                .frame(width: rect.width, height: rect.height)
                // The list's own row background, out to the cell's edges, so it
                // passes over the rows it goes by rather than through them.
                .background {
                    Color(uiColor: .systemBackground)
                        .padding(EdgeInsets(top: -ThreadRow.insets.top, leading: -ThreadRow.insets.leading,
                                            bottom: -ThreadRow.insets.bottom, trailing: -ThreadRow.insets.trailing))
                }
                .opacity(shown)
                .offset(x: rect.minX - origin.x, y: rect.minY - origin.y)
        }
        Color.clear.frame(width: 0, height: 0)
            .task { await fly() }
    }

    private func fly() async {
        // The row's new place is known once the list has laid out the change, a
        // frame or two on. Not there at all (scrolled well away, or the search
        // has it elsewhere): no flight, the row just turns up.
        var target: CGRect?
        for _ in 0..<6 {
            try? await Task.sleep(for: .milliseconds(16))
            if Task.isCancelled { return }
            target = destination()
            if target != nil { break }
        }
        guard let target, let animation = Juice.rows else { return model.endFlight(flight.id) }
        let folded = model.folds.isFolded(flight.move.to)
        if flight.fromHeading {
            // Rises out of the folded heading, the size of the row it becomes.
            rect = CGRect(x: target.minX, y: flight.from.midY - target.height / 2, width: target.width, height: target.height)
            shown = 0
        }
        // Into a folded heading, it keeps its size and sinks into the heading.
        let start = rect ?? target
        let end = folded ? CGRect(x: start.minX, y: target.midY - start.height / 2, width: start.width, height: start.height) : target
        withAnimation(animation, completionCriteria: .logicallyComplete) {
            rect = end
            shown = folded ? 0 : 1
        } completion: {
            model.endFlight(flight.id)
        }
    }

    /// The real row under its new heading, or that heading if it's folded.
    private func destination() -> CGRect? {
        let to = flight.move.to
        if model.folds.isFolded(to) { return model.rowFrames.visible(RowFrames.heading(to)) }
        return model.rowFrames[RowFrames.row(flight.id, under: to)]
    }
}
