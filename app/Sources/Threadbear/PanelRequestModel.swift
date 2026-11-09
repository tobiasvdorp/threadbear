import AppKit
import BearDock
import ThreadbearCore

// show_panel (docs/protocol.md, "Showing panels"): a panel the agent asked
// to show Mike waits on its thread until he's looking at it, then opens, or
// comes to the front wherever he has it. Nothing he has open moves.

extension AppModel {
    /// Shows the request waiting on the thread in the main panel, if Mike is
    /// looking at it, and tells the runner it's done. Called when that
    /// thread's summary changes, when it's selected, when the app comes to
    /// the front and when the thread list loads.
    func servePanelRequest() {
        guard openProjectId == nil, !showsHomePage,
              let thread = selectedThread, let request = panelRequestGate.take(thread, looking: isLooking) else { return }
        if request.highlight != nil { return showPinned(request, in: thread) }
        guard let panel = PanelRequests.panel(request, in: thread) else {
            // Left for the runner to clear with Mike's next message.
            AppLog.write("panels", "\(thread.id.prefix(8)) asked to show \(request.panel), which it hasn't got")
            return
        }
        showRequested(panel, at: PanelRequests.place(request), in: thread)
        AppLog.write("panels", "showed \(request.panel) for \(thread.id.prefix(8))")
        tellShown(request, in: thread)
    }

    /// `pin` with `show`: the pin opens in the pane over Highlights, as a
    /// click on its row there does. Fetched first when the list here
    /// doesn't have it yet (the pin came in while Mike was elsewhere, or
    /// the fetch after it hasn't landed). One that's gone (unpinned since)
    /// still opens Highlights.
    private func showPinned(_ request: PanelRequest, in thread: ThreadSummary) {
        Task { @MainActor in
            if PanelRequests.pin(request, in: highlights[thread.id]) == nil, !(await fetchHighlights(thread.id)) {
                // Not shown, so not said to be: his next look tries again.
                panelRequestGate.release(request.id)
                return
            }
            // The fetch let other things happen: he may have moved on, or
            // sent a message (which clears it) or had a newer request
            // replace it. Shown only if it's still his to see now.
            guard openProjectId == nil, !showsHomePage, isLooking, selection == thread.id,
                  let current = threads[thread.id], current.panelRequest?.id == request.id else {
                panelRequestGate.release(request.id)
                return
            }
            showRequested(.section(.highlights), at: .usual, in: current)
            if let pin = PanelRequests.pin(request, in: highlights[thread.id]) {
                // Only the pane: an agent showing a file never starts its
                // app (Daybreak, 7 Nov: a .tandem symlinked to a .command).
                open(pin, in: current, external: false, shownByAgent: true)
                AppLog.write("panels", "showed pin \(pin.id) for \(thread.id.prefix(8))")
            } else {
                AppLog.write("panels", "\(thread.id.prefix(8)) asked to show pin \(request.highlight ?? ""), which isn't in its highlights")
            }
            tellShown(request, in: current)
        }
    }

    private func tellShown(_ request: PanelRequest, in thread: ThreadSummary) {
        guard let client = client(for: thread.id) else { return }
        Task {
            do {
                _ = try await client.panelShown(threadId: thread.id, requestId: request.id)
            } catch {
                AppLog.write("rpc", "threads.panelShown failed: \(error.localizedDescription)")
            }
        }
    }

    /// Opens the panel at `place`, or brings it to the front if it's open,
    /// docked or in a window of its own. A pane section becomes the
    /// thread's chosen one, as a click on its rail button makes it.
    func showRequested(_ panel: RequestedPanel, at place: RequestedPlace, in thread: ThreadSummary) {
        let id: PanelID
        switch panel {
        case .section(let section):
            if panePreview[thread.id].map({ $0.from != section }) ?? false { panePreview[thread.id] = nil }
            panelChoice[thread.id] = section.id
            id = section.id
        case .usage: id = WindowDock.usage
        case .updates: id = WindowDock.updates
        case .connectors: id = WindowDock.connectors
        }
        if dock.layout.contains(id) { return dock.show(id) }
        switch place {
        case .usual:
            switch panel {
            case .section(let section): showPane(section)
            case .usage: usageShown = true
            case .updates: updatesShown = true
            case .connectors: connectorsShown = true
            }
        case .tab: openMainTab(id)
        case .side(let side): dock.open(id, .window(DockEdge(rawValue: side.rawValue) ?? .right))
        case .window: dock.openInNewWindow(id)
        }
    }
}
