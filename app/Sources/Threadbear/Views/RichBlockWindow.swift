import AppKit
import SwiftUI

/// A reply's diagram or page in a window of its own, most of the screen,
/// like a design review (Mike, 8 Nov): beside the thread in the pane it was
/// still too small to read a big diagram.
@MainActor
final class RichBlockWindowController: NSWindowController, NSWindowDelegate {
    /// One window per block: opening it again brings that one forward.
    private static var open: [String: RichBlockWindowController] = [:]

    static func show(_ page: URL, id: String, title: String, subtitle: String?) {
        if let existing = open[id] {
            existing.refresh.count += 1
            existing.present()
            return
        }
        let controller = RichBlockWindowController(page: page, title: title, subtitle: subtitle)
        controller.onClose = { open.removeValue(forKey: id) }
        open[id] = controller
        controller.present()
    }

    /// Bumped to fetch the page's view from the pool again: the pool keeps
    /// only a few, and one dropped while this window was behind would leave
    /// it blank.
    final class Refresh: ObservableObject { @Published var count = 0 }
    private let refresh = Refresh()
    private var onClose: (() -> Void)?

    private init(page: URL, title: String, subtitle: String?) {
        let screen = NSApp.keyWindow?.screen ?? NSApp.mainWindow?.screen ?? NSScreen.main
        let frame = ReviewWindowController.frame(on: screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1240 / 0.9, height: 860 / 0.9))
        let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        if let subtitle { window.subtitle = subtitle }
        window.minSize = NSSize(width: 480, height: 360)
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.fullScreenPrimary]
        super.init(window: window)
        window.delegate = self
        window.contentView = NSHostingView(rootView: Body(page: page, refresh: refresh))
        window.setFrame(frame, display: false)
    }

    required init?(coder: NSCoder) { fatalError() }

    private func present() {
        #if DEBUG
        if Automation.instanceId != nil {
            window?.tuckBehind()
            return
        }
        #endif
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowDidBecomeKey(_ notification: Notification) { refresh.count += 1 }

    func windowWillClose(_ notification: Notification) { onClose?() }

    private struct Body: View {
        let page: URL
        @ObservedObject var refresh: Refresh

        var body: some View { LocalPagePreview(url: page, opened: refresh.count) }
    }
}
