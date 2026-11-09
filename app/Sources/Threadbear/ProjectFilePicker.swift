import AppKit

/// Leave the SwiftUI button action before presenting AppKit's picker. A
/// nested runModal loop can reenter the action and strand a second panel.
@MainActor
final class ProjectFilePicker {
    typealias Presenter = @MainActor (NSOpenPanel, @escaping (NSApplication.ModalResponse) -> Void) -> Void
    private var active: NSOpenPanel?
    private let present: Presenter

    init(present: @escaping Presenter = { panel, finish in
        if let window = NSApp.keyWindow ?? NSApp.mainWindow {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            panel.begin(completionHandler: finish)
        }
    }) {
        self.present = present
    }

    func choose(configure: (NSOpenPanel) -> Void,
                makePanel: @MainActor () -> NSOpenPanel = { NSOpenPanel() },
                completion: @escaping (URL?) -> Void) {
        guard active == nil else { return }
        let panel = makePanel()
        configure(panel)
        active = panel
        Task { @MainActor [self] in
            self.present(panel) { [weak self] response in
                guard let self, self.active === panel else { return }
                self.active = nil
                completion(response == .OK ? panel.url : nil)
            }
        }
    }
}
