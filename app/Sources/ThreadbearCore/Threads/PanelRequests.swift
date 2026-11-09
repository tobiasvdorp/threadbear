import Foundation

/// A panel the agent asked to show Mike (show_panel, docs/protocol.md,
/// "Showing panels"), as the window has it: one of the thread's own pane
/// sections, or one of the app's.
public enum RequestedPanel: Equatable, Sendable {
    case section(PaneSection)
    case usage
    case updates
    case connectors
}

/// Where a closed panel opens. An open one stays where Mike put it.
public enum RequestedPlace: Equatable, Sendable {
    /// Where the app would put it: a thread's section beside its other open
    /// ones, else down the right; Usage and Updates under the threads.
    case usual
    /// A tab beside the thread, which closes when the main panel moves on.
    case tab
    /// Along that side of the window.
    case side(Side)
    /// A window of its own.
    case window

    public enum Side: String, Sendable { case left, right, top, bottom }
}

public enum PanelRequests {
    /// The panel a request names, or nil when the thread hasn't got it (a
    /// patch can go between the request and the look).
    public static func panel(_ request: PanelRequest, in thread: ThreadSummary) -> RequestedPanel? {
        switch request.panel {
        case "highlights": return .section(.highlights)
        case "patches": return thread.patches.isEmpty ? nil : .section(.patches)
        case "usage": return .usage
        case "updates": return .updates
        case "connectors": return .connectors
        case "threadbear.browser", "browser": return .section(.panel("threadbear.browser"))
        default: return thread.panels.contains { $0.id == request.panel } ? .section(.panel(request.panel)) : nil
        }
    }

    /// The pin a `pin` with `show` request opens, from the thread's
    /// highlights as fetched. Nil for a plain panel request, or when the
    /// pin isn't in them (not fetched yet, or unpinned since).
    public static func pin(_ request: PanelRequest, in highlights: ThreadHighlights?) -> Highlight? {
        guard request.panel == "highlights", let id = request.highlight else { return nil }
        return highlights?.highlights.first { $0.id == id }
    }

    /// Where it opens if it's closed. Anything unknown is the usual place.
    public static func place(_ request: PanelRequest) -> RequestedPlace {
        switch request.where {
        case "tab": return .tab
        case "window": return .window
        case let side?: return RequestedPlace.Side(rawValue: side).map(RequestedPlace.side) ?? .usual
        case nil: return .usual
        }
    }
}

/// Which waiting request to show, and when: once each, while Mike is
/// looking at its thread. The runner clears it when the app says it showed
/// it, but the summary that still has it can arrive first, so the ids
/// taken are kept for the rest of the run.
public struct PanelRequestGate: Sendable {
    private var taken: Set<String> = []

    public init() {}

    /// The thread in the main panel's request to show now, if Mike is
    /// looking (the app in front) and it hasn't been shown yet.
    public mutating func take(_ thread: ThreadSummary?, looking: Bool) -> PanelRequest? {
        guard looking, let request = thread?.panelRequest, !taken.contains(request.id) else { return nil }
        taken.insert(request.id)
        return request
    }

    /// Hands a taken request back, unshown: a pin whose highlights didn't
    /// come, or that Mike moved away from while they were fetched. The
    /// next look at its thread takes it again.
    public mutating func release(_ requestId: String) { taken.remove(requestId) }
}
