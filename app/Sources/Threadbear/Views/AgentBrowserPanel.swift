import AppKit
import SwiftUI
import ThreadbearCore

/// The pages a thread's agents are using, through BrowserBear: in the agents'
/// own browser (Helium, in real windows behind Mike's) or in his own Chrome
/// profiles. Each row has a still of the page and Show window, which brings
/// the real window forward. Nothing is streamed or mirrored here: Mike
/// disliked the page drawn inside Threadbear (6 Nov 2026), so since 8 Nov he
/// uses a page in its own window and the panel only says what's open.
enum AgentBrowser {
    static let panelId = "threadbear.browser"

    /// BrowserBear's folder.
    static var home: String {
        ProcessInfo.processInfo.environment["BROWSERBEAR_HOME"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/BrowserBear")
    }

    /// BrowserBear's id for the agents' own browser, as opposed to one of
    /// Mike's Chrome profiles.
    static let agentsBrowser = "agent-chrome"
}

struct AgentTab: Decodable, Identifiable, Equatable {
    var tabId: Int
    var targetId: String?
    /// In one of Mike's own Chrome profiles rather than the agents' browser.
    var bridge: Bool?
    var profile: String?
    var profileName: String?
    var profileEmail: String?
    var profileTitle: String {
        [profileName, profileEmail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    var url: String
    var title: String
    var thread: String?
    /// working, yours or idle (service/marks.mjs); nil when unmarked.
    var state: String?
    var action: String?
    /// The agent is waiting on `handoff --wait`, so Done means something.
    var finish: Bool?
    var status: String?
    /// Goes up each time the agent hands this tab to Mike.
    var handoffs: Int?
    var handoffAt: Double?
    var popup: Bool?
    var openedAt: Double?
    var id: String { "\(profile ?? AgentBrowser.agentsBrowser)/\(tabId)" }
    var profileId: String { profile ?? AgentBrowser.agentsBrowser }
}

struct BrowserProfile: Decodable, Identifiable, Equatable {
    var id: String
    var name: String?
    var email: String?
}

private struct BrowserPanelState: Decodable {
    var profiles: [BrowserProfile]
    var tabs: [AgentTab]
}

/// BrowserBear's agent host writes this (agent/tabs.json).
private struct AgentState: Decodable, Equatable {
    var port: Int
    var socket: String
    /// The browser it runs: Helium, or Google Chrome without it.
    var browser: String?
    var tabs: [AgentTab]
}

/// A page's still, as the panel last got it.
struct AgentStill: Equatable {
    var image: NSImage
    var at: Date
}

/// Reads the agent host's tabs.json and asks BrowserBear for the pages in
/// Mike's own profiles. A second's lag is fine: it's for which pages a thread
/// has and what the agent's doing.
@MainActor
final class AgentBrowserModel: ObservableObject {
    static let shared = AgentBrowserModel()

    @Published private(set) var tabs: [AgentTab] = []
    @Published private(set) var port = 0
    @Published private(set) var browserName = "Helium"
    @Published private(set) var error: String?
    /// Requests whose buttons are waiting for BrowserBear's answer, by
    /// `pendingKey`. It can take a while, as the browser has to do the thing.
    @Published private(set) var pending: Set<String> = []
    /// The request each key is waiting on, so an old request's timeout
    /// can't clear a newer one's spinner.
    private var pendingRequests: [String: UUID] = [:]
    private var agentTabs: [AgentTab] = []
    private var profileTabs: [AgentTab] = []
    private var pipe: BrowserBearPipe?
    private var polling = false
    private var requestError: String?
    private var timer: Timer?
    private var last: Data?

    private init() {
        read()
        timer = .scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
    }

    private func read() {
        pollProfiles()
        let path = (AgentBrowser.home as NSString).appendingPathComponent("agent/tabs.json")
        guard let data = FileManager.default.contents(atPath: path), data != last else { return }
        last = data
        guard let state = try? JSONDecoder().decode(AgentState.self, from: data) else { return }
        agentTabs = state.tabs
        port = state.port
        if let browser = state.browser, !browser.isEmpty { browserName = browser }
        mergeTabs()
    }

    func tabs(for threadId: String) -> [AgentTab] { tabs.filter { $0.thread == threadId } }

    var available: Bool { port != 0 || FileManager.default.fileExists(atPath: BrowserBear.socket) }

    private func mergeTabs() {
        let joined = Dictionary(agentTabs.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        tabs = Array(profileTabs.reduce(into: joined) { $0[$1.id] = $1 }.values).sorted { $0.tabId < $1.tabId }
    }

    private func connection() -> BrowserBearPipe? {
        guard FileManager.default.fileExists(atPath: BrowserBear.socket) else { return nil }
        if let pipe { return pipe }
        let connection = BrowserBearPipe()
        connection.onRequestError = { [weak self] message in
            DispatchQueue.main.async { self?.polling = false; self?.error = message }
        }
        connection.onError = { [weak self, weak connection] message in
            DispatchQueue.main.async {
                guard let self, self.pipe === connection else { return }
                self.error = message
                self.polling = false
                connection?.close()
                self.pipe = nil
                self.profileTabs = []
                self.mergeTabs()
            }
        }
        pipe = connection
        return connection
    }

    private func pollProfiles() {
        guard !polling, let pipe = connection() else { return }
        polling = true
        pipe.request("panelState", reply: { [weak self] result in
            guard result["_error"] == nil else { return }
            let data = try? JSONSerialization.data(withJSONObject: result)
            let state = data.flatMap { try? JSONDecoder().decode(BrowserPanelState.self, from: $0) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.polling = false
                guard let state else { self.error = "BrowserBear sent an unreadable list of pages."; return }
                self.error = self.requestError
                self.profileTabs = state.tabs.filter { $0.bridge == true }
                self.mergeTabs()
            }
        })
    }

    static func pendingKey(_ cmd: String, _ tab: AgentTab) -> String { "\(cmd)/\(tab.id)" }
    static let openingKey = "open"

    /// `key` is what a button watches, in `pending`, until the answer comes.
    private func action(_ cmd: String, _ args: [String: Any], thread: String? = nil, key: String? = nil) {
        requestError = nil
        error = nil
        guard let pipe = connection() else { return }
        let request = UUID()
        if let key {
            pending.insert(key)
            pendingRequests[key] = request
            // A connection that drops takes its answers with it, and the pipe
            // gives up on any by 45 seconds, so the button comes back by then.
            DispatchQueue.main.asyncAfter(deadline: .now() + 46) { [weak self] in self?.answered(key, request) }
        }
        pipe.request(cmd, args, thread: thread, failure: { [weak self] message in
            DispatchQueue.main.async {
                self?.requestError = message
                self?.error = message
                if let key { self?.answered(key, request) }
            }
        }, reply: { [weak self] _ in
            DispatchQueue.main.async { if let key { self?.answered(key, request) } }
        })
    }

    private func answered(_ key: String, _ request: UUID) {
        guard pendingRequests[key] == request else { return }
        pendingRequests[key] = nil
        pending.remove(key)
    }

    func done(_ tab: AgentTab) { action("markDone", ["tab": tab.tabId], key: Self.pendingKey("markDone", tab)) }

    /// Brings the page's real window to the front.
    func show(_ tab: AgentTab, thread: String) {
        action("panelShow", ["tab": tab.tabId, "profile": tab.profileId], thread: thread, key: Self.pendingKey("panelShow", tab))
    }

    /// A new page in the agents' browser, behind Mike's windows.
    func open(_ url: String, thread: String) {
        action("open", ["profile": "agent", "url": url], thread: thread, key: Self.openingKey)
    }

    /// A small picture of the page, or nil when there isn't one just now (a
    /// background tab Chrome isn't drawing, or one handed to Mike in his own
    /// Chrome, which BrowserBear leaves alone while he works in it).
    func still(_ tab: AgentTab, thread: String, width: Int) async -> AgentStill? {
        guard let pipe = connection() else { return nil }
        let reply: [String: Any] = await withCheckedContinuation { done in
            pipe.request("panelStill", ["tab": tab.tabId, "profile": tab.profileId, "width": width], thread: thread,
                         failure: { _ in }, reply: { done.resume(returning: $0) })
        }
        guard let base64 = reply["data"] as? String, let data = Data(base64Encoded: base64), let image = NSImage(data: data) else { return nil }
        let at = (reply["at"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
        return AgentStill(image: image, at: at)
    }
}

// MARK: - The panel

struct AgentBrowserPanel: View {
    let thread: ThreadSummary
    @ObservedObject private var model = AgentBrowserModel.shared
    @State private var address = ""
    @FocusState private var addressFocused: Bool

    /// Pages waiting for Mike first, then the newest.
    private var tabs: [AgentTab] {
        model.tabs(for: thread.id).sorted {
            let yours = ($0.state == "yours", $1.state == "yours")
            if yours.0 != yours.1 { return yours.0 }
            return ($0.openedAt ?? Double($0.tabId)) > ($1.openedAt ?? Double($1.tabId))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            addressBar
            if tabs.isEmpty {
                PaneNote(text: model.error ?? (model.available ? "No pages open in this thread." : "BrowserBear isn't running."))
            } else {
                ScrollView {
                    LazyVStack(spacing: zoomed(8)) {
                        ForEach(tabs) { tab in
                            AgentPageRow(tab: tab, thread: thread.id, browserName: model.browserName)
                        }
                    }
                    .padding(zoomed(10))
                }
                if let error = model.error {
                    Text(error).font(.system(size: TypeScale.label)).foregroundStyle(.secondary).padding(zoomed(6))
                }
            }
        }
    }

    private var addressBar: some View {
        HStack(spacing: zoomed(6)) {
            TextField("Open a page in \(model.browserName)", text: $address)
                .textFieldStyle(.plain)
                .font(.system(size: TypeScale.label))
                .focused($addressFocused)
                .padding(.horizontal, zoomed(8))
                .padding(.vertical, zoomed(4))
                .background(SidebarMetrics.hover, in: RoundedRectangle(cornerRadius: zoomed(6)))
                .disabled(!model.available || model.pending.contains(AgentBrowserModel.openingKey))
                .onSubmit(go)
            if model.pending.contains(AgentBrowserModel.openingKey) {
                SpinnerMark(color: .secondaryLabelColor).frame(width: zoomed(11), height: zoomed(11))
            }
        }
        .padding(.horizontal, zoomed(10))
        .padding(.vertical, zoomed(6))
    }

    private func go() {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if !text.contains("://") { text = (text.contains(".") && !text.contains(" ") ? "https://" : "https://www.google.com/search?q=") + text }
        model.open(text, thread: thread.id)
        address = ""
        addressFocused = false
    }
}

/// One page: its still, what it is, what the agent's doing in it, and the
/// buttons. The still is asked for every few seconds while the row's on
/// screen; BrowserBear decides how fresh it can be.
struct AgentPageRow: View {
    let tab: AgentTab
    let thread: String
    let browserName: String
    @ObservedObject private var model = AgentBrowserModel.shared
    @State private var still: AgentStill?

    private static let stillWidth: CGFloat = 104

    private var yours: Bool { tab.state == "yours" }
    private var host: String { URL(string: tab.url)?.host() ?? tab.url }
    private var place: String { tab.bridge == true ? (tab.profileTitle.isEmpty ? "Chrome" : tab.profileTitle) : browserName }

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            HStack(alignment: .top, spacing: zoomed(10)) {
                picture
                VStack(alignment: .leading, spacing: zoomed(3)) {
                    HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                        if let colour = dot { Circle().fill(colour).frame(width: zoomed(7), height: zoomed(7)) }
                        Text(tab.title.isEmpty ? host : tab.title)
                            .font(.system(size: TypeScale.label, weight: .medium))
                            .lineLimit(2)
                    }
                    Text(host).font(.system(size: TypeScale.label)).foregroundStyle(.secondary).lineLimit(1)
                    if tab.state == "working", let action = tab.action {
                        Text(action).font(.system(size: TypeScale.label)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            // Under the picture and the words, so a narrow panel never cuts
            // a button's name short.
            HStack(spacing: zoomed(6)) {
                Button("Show window") { model.show(tab, thread: thread) }
                    .controlSize(.small)
                    .fixedSize()
                    .busy(model.pending.contains(AgentBrowserModel.pendingKey("panelShow", tab)))
                    .tip("Bring this page's window to the front, in \(place)")
                if yours {
                    Button("Done") { model.done(tab) }
                        .controlSize(.small)
                        .fixedSize()
                        .busy(model.pending.contains(AgentBrowserModel.pendingKey("markDone", tab)))
                        .tip("Tell the agent you've finished here")
                }
            }
        }
        .padding(zoomed(8))
        .background(RoundedRectangle(cornerRadius: zoomed(8)).strokeBorder(yours ? Color.orange.opacity(0.6) : Color.primary.opacity(0.08)))
        .task(id: tab.id) {
            while !Task.isCancelled {
                if let fresh = await model.still(tab, thread: thread, width: Int(Self.stillWidth * 2)) { still = fresh }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    /// Amber while it's Mike's turn, green while the agent works in it.
    private var dot: Color? {
        switch tab.state {
        case "yours": .orange
        case "working": .green
        default: nil
        }
    }

    private var picture: some View {
        ZStack {
            RoundedRectangle(cornerRadius: zoomed(5)).fill(Color.primary.opacity(0.06))
            if let still {
                Image(nsImage: still.image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: zoomed(Self.stillWidth), height: zoomed(Self.stillWidth * 0.62), alignment: .top)
                    .clipShape(RoundedRectangle(cornerRadius: zoomed(5)))
                    .tip("As the page looked \(still.at.formatted(.relative(presentation: .named)))")
            } else {
                Image(systemName: "globe").font(.system(size: zoomed(16))).foregroundStyle(.tertiary)
            }
        }
        .frame(width: zoomed(Self.stillWidth), height: zoomed(Self.stillWidth * 0.62))
    }
}
