import AVFoundation
import AVKit
import CryptoKit
import ImageIO
import SwiftUI
import ThreadbearKit
import UIKit
import UniformTypeIdentifiers

extension EnvironmentValues {
    /// The open thread's pictures, for MarkdownText to find its images in.
    @Entry var threadPictures = ThreadPictures()
    /// In the thread, whose rows are all built at once: a picture isn't
    /// fetched until it's scrolled to, or opening a thread would fetch them all.
    @Entry var picturesWaitUntilSeen = false
}

/// What a picture's address turned out to be. A class so a view can tell by
/// identity that it's already showing this one, without comparing the bytes.
nonisolated final class LoadedPicture: Sendable {
    enum Motion: Sendable {
        /// A GIF, or another format with several frames, played by
        /// MovingImageView from `file`. Not its bytes: a row kept every
        /// GIF's whole file in memory (Codex review, Daybreak finding 8).
        case frames
        /// Plays full screen, from `file`.
        case video
    }

    /// A still picture, or the first frame of a moving one.
    let image: UIImage
    let motion: Motion?
    /// On disk for a moving picture, as sharing `image` would flatten it.
    let file: URL?

    init(image: UIImage, motion: Motion? = nil, file: URL? = nil) {
        self.image = image
        self.motion = motion
        self.file = file
    }

    var isVideo: Bool {
        if case .video = motion { true } else { false }
    }
}

/// Pictures from file storage or the web. Their own cache on disk, as
/// URLCache.shared won't keep anything much bigger than half a megabyte, and
/// a picture shouldn't be fetched again each time it scrolls back into view.
actor PictureLoader {
    static let shared = PictureLoader()

    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("Pictures")
        config.urlCache = URLCache(memoryCapacity: 8 * 1024 * 1024, diskCapacity: 300 * 1024 * 1024, directory: folder)
        config.requestCachePolicy = .returnCacheDataElseLoad
        return URLSession(configuration: config)
    }()
    /// By url and size, so the column's small copy and the full-screen one
    /// are kept apart. One budget for all of them, least recently used out
    /// first; rows let go of theirs once off screen, so this is what's held.
    private let decoded = CostLRU<String, LoadedPicture>(limit: 96 * 1024 * 1024)
    /// A thread of pictures doesn't fetch them all at once.
    private let downloads = ConcurrencyLimit(4)

    /// The largest side's pixels decoded: a phone's column doesn't need all
    /// of a big PNG in memory. Nil for full screen, which is still held to
    /// PictureLimits.maxFullScreenSide.
    func picture(_ url: URL, maxPixels: Int?) async throws -> LoadedPicture {
        let key = "\(maxPixels ?? 0) \(url.absoluteString)"
        if let picture = decoded.value(for: key) { return picture }
        // The address is whatever an agent wrote, so the server is anyone's:
        // read with a byte cap, never the whole response (Daybreak finding 8).
        let session = session
        let data = try await downloads.run { try await CappedDownload.data(from: url, session: session) }
        let picture = try await decode(data, url: url, maxPixels: maxPixels ?? PictureLimits.maxFullScreenSide)
        let cost = picture.image.cgImage.map { $0.bytesPerRow * $0.height } ?? Int(picture.image.size.width * picture.image.size.height * 4)
        decoded.set(picture, for: key, cost: cost)
        return picture
    }

    private func decode(_ data: Data, url: URL, maxPixels: Int) async throws -> LoadedPicture {
        // An MP4 isn't an image source, or is one with no frames. One whose
        // header says it's too many pixels throws here, before any decoding:
        // ImageIO can decode the whole of some formats on the way to a thumbnail.
        guard let source = try PictureSource.open(data) else {
            return try await decodeVideo(data, url: url, maxPixels: maxPixels)
        }
        guard let cg = PictureSource.thumbnail(source, maxSide: maxPixels) else { throw URLError(.cannotDecodeContentData) }
        let image = UIImage(cgImage: cg)
        guard CGImageSourceGetCount(source) > 1 else { return LoadedPicture(image: image) }
        let ext = (CGImageSourceGetType(source) as String?).flatMap { UTType($0)?.preferredFilenameExtension } ?? "gif"
        // Played from the file, so the bytes go once this returns.
        guard let file = try? saved(data, url: url, ext: ext) else { return LoadedPicture(image: image) }
        return LoadedPicture(image: image, motion: .frames, file: file)
    }

    /// The whole file comes down first (the runner never sends one over 10 MB,
    /// and CappedDownload stops anything over PictureLimits.maxBytes), which
    /// also means it plays from the cache with no signal. AVPlayer only plays
    /// from a URL with the right extension, so it goes in a file.
    private func decodeVideo(_ data: Data, url: URL, maxPixels: Int) async throws -> LoadedPicture {
        guard data.count > 12, data[4..<8] == Data("ftyp".utf8) else { throw URLError(.cannotDecodeContentData) }
        let quickTime = data[8..<12] == Data("qt  ".utf8)
        let file = try saved(data, url: url, ext: quickTime ? "mov" : "mp4")
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxPixels, height: maxPixels)
        let poster = try await generator.image(at: .zero).image
        return LoadedPicture(image: UIImage(cgImage: poster), motion: .video, file: file)
    }

    private func saved(_ data: Data, url: URL, ext: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Moving pictures", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        let file = folder.appendingPathComponent(name).appendingPathExtension(ext)
        if !FileManager.default.fileExists(atPath: file.path) { try data.write(to: file, options: .atomic) }
        return file
    }
}

/// A picture in a reply: as wide as the column at most, no taller than a
/// good part of the screen and never blown up past its own size. Tap for
/// full screen. Its place is kept from the size the runner sent, so the
/// thread doesn't jump as it loads.
struct ReplyPicture: View {
    /// A page of text shouldn't be pushed off screen by one tall picture.
    static let maxHeight: CGFloat = 360
    static let maxPixels = 1400
    /// More than the top bar or the reply box is tall, even with the slash
    /// palette (up to 260 pt of results) and photo chips open in it (Codex review).
    static let underBars: CGFloat = 450

    var url: URL
    var alt: String
    var width: Int?
    var height: Int?
    /// Smaller for the photos over Mike's own bubble, which sit to the right.
    var tallest: CGFloat = Self.maxHeight
    var alignment: Alignment = .leading

    @State private var loaded: LoadedPicture?
    @State private var failed = false
    @State private var fullScreen = false
    @Environment(\.picturesWaitUntilSeen) private var waitUntilSeen
    @State private var seen = false
    /// Scrolled out of view: the row lets go of its picture, which stays in
    /// PictureLoader's budgeted cache, so offscreen rows hold nothing.
    @State private var offscreen = false
    /// The loaded picture's size, kept after it's let go so the row doesn't
    /// change height.
    @State private var loadedSize: CGSize?

    private var wantsPicture: Bool { (!waitUntilSeen || seen) && !offscreen }

    private var size: CGSize? {
        if let size = loaded?.image.size ?? loadedSize { return size }
        if let width, let height, width > 0, height > 0 { return CGSize(width: width, height: height) }
        return nil
    }

    var body: some View {
        Group {
            if failed {
                PictureOnMac(alt: alt, note: "Couldn't load this picture")
            } else {
                Button { fullScreen = true } label: { picture }
                    .buttonStyle(.plain)
                    .disabled(loaded == nil)
                    .accessibilityLabel(alt.isEmpty ? "Picture" : alt)
                    .accessibilityHint(loaded?.isVideo == true ? "Plays it full screen" : "Shows it full screen")
            }
        }
        // Watched from a band reaching well past the picture, not the picture
        // itself. Scroll visibility only counts the clear middle of the screen,
        // but the top bar and the reply box are see-through: a picture under
        // either was let go and showed as a gap behind them (8 Nov, Mike's
        // recording). And any sliver of the band counts, not the default half.
        .background {
            Color.clear
                .onScrollVisibilityChange(threshold: 0.01) { visible in
                    if visible { seen = true }
                    // Not while it's open full screen, which shows this one first.
                    offscreen = !visible && !fullScreen
                    if offscreen { loaded = nil }
                }
                // Taller than either bar, so it's still "on screen" until
                // it has gone from behind them too.
                .padding(.vertical, -Self.underBars)
        }
        .task(id: wantsPicture ? url : nil) {
            guard wantsPicture else { return }
            await load()
            // `-ThreadbearViewPicture <alt>`: opens that picture full screen,
            // for screenshots, as the simulator can't be tapped from a script.
            let args = CommandLine.arguments
            if loaded != nil, let i = args.firstIndex(of: "-ThreadbearViewPicture"), i + 1 < args.count, args[i + 1] == alt { fullScreen = true }
        }
        .fullScreenCover(isPresented: $fullScreen) {
            PictureViewer(url: url, alt: alt, preview: loaded)
        }
    }

    @ViewBuilder private var picture: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        PictureFit(pixels: size, maxHeight: tallest) {
            Group {
                if let loaded {
                    if case .frames = loaded.motion {
                        MovingPicture(picture: loaded)
                    } else {
                        Image(uiImage: loaded.image).resizable().interpolation(.high)
                            .overlay { if loaded.isVideo { PlayBadge() } }
                    }
                } else {
                    Color(.secondarySystemBackground).overlay { ProgressView() }
                }
            }
            .clipShape(shape)
            .overlay(shape.strokeBorder(.quaternary, lineWidth: 0.5))
        }
        .frame(maxWidth: .infinity, alignment: alignment)
        .contentShape(Rectangle())
    }

    private func load() async {
        failed = false
        do {
            let picture = try await PictureLoader.shared.picture(url, maxPixels: Self.maxPixels)
            // Scrolled away while it came: the cache has it for next time.
            guard !offscreen else { return }
            loaded = picture
            loadedSize = picture.image.size
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            failed = true
        }
    }
}

/// On a video's first frame in the thread, which plays once it's tapped.
private struct PlayBadge: View {
    var body: some View {
        Image(systemName: "play.fill")
            .font(.title2)
            .foregroundStyle(.white)
            .frame(width: 56, height: 56)
            .background(.black.opacity(0.55), in: Circle())
    }
}

/// Shows a picture and, if it has frames, plays them for as long as it's on
/// screen, each for its own time and as many loops as the file says. Frames
/// are decoded one at a time off the main thread, from the file and at the
/// size the first frame was shown at (AnimationPlan), so neither the file's
/// bytes nor full-size frames sit in memory. One with too many frames or
/// pixels, or frames ImageIO can't read, leaves the first frame showing.
final class MovingImageView: UIImageView {
    /// Whether this run of the player is still wanted, read from the
    /// decoding queue too.
    nonisolated private final class Run: @unchecked Sendable {
        private let lock = NSLock()
        private var _stopped = false
        var stopped: Bool {
            get { lock.withLock { _stopped } }
            set { lock.withLock { _stopped = newValue } }
        }
    }
    /// The source and plan, only touched on `queue`.
    nonisolated private final class Player: @unchecked Sendable {
        let source: CGImageSource
        let plan: AnimationPlan
        init(source: CGImageSource, plan: AnimationPlan) {
            self.source = source
            self.plan = plan
        }
    }
    nonisolated private static let queue = DispatchQueue(label: "com.mikecann.threadbear.moving-pictures", qos: .userInitiated)
    private var run: Run?
    private var picture: LoadedPicture?

    func show(_ new: LoadedPicture) {
        guard new !== picture else { return }
        picture = new
        image = new.image
        play()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        play()
    }

    private func play() {
        run?.stopped = true
        run = nil
        guard window != nil, let picture, case .frames = picture.motion, let file = picture.file,
              let first = picture.image.cgImage else { return }
        let maxSide = max(first.width, first.height)
        let run = Run()
        self.run = run
        Self.queue.async { [weak self] in
            guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let plan = AnimationPlan(source, maxSide: maxSide) else { return }
            let player = Player(source: source, plan: plan)
            Self.queue.asyncAfter(deadline: .now() + plan.delays[0]) { [weak self] in
                self?.step(player, run, index: 1, loop: 0)
            }
        }
    }

    /// On `queue`: decodes frame `index`, shows it, and only once it's on
    /// screen comes back for the next. So there's never more than one decoded
    /// frame waiting: while the main thread is stuck, the chain waits with it,
    /// rather than queueing a frame every tick (Codex's second review). The
    /// frame's time counts from when it was shown, so a stall slows the
    /// picture down instead of skipping through it.
    nonisolated private func step(_ player: Player, _ run: Run, index: Int, loop: Int) {
        guard !run.stopped, let frame = player.plan.frame(player.source, at: index) else { return }
        let wraps = index + 1 == player.plan.delays.count
        let next = wraps ? 0 : index + 1
        let loop = wraps ? loop + 1 : loop
        let last = wraps && player.plan.loopCount > 0 && loop >= player.plan.loopCount
        let delay = player.plan.delays[index]
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !run.stopped else { return }
                self.image = UIImage(cgImage: frame)
            }
            // The next decode is only scheduled from here, after this frame
            // has been handed over: the one place the chain goes on.
            guard !last, !run.stopped else { return }
            Self.queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.step(player, run, index: next, loop: loop)
            }
        }
    }
}

private struct MovingPicture: UIViewRepresentable {
    var picture: LoadedPicture

    func makeUIView(context: Context) -> MovingImageView {
        let view = MovingImageView()
        view.contentMode = .scaleToFill
        return view
    }

    func updateUIView(_ view: MovingImageView, context: Context) {
        view.show(picture)
    }

    /// PictureFit's size, not the size of the frame in the view.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MovingImageView, context: Context) -> CGSize? {
        proposal.replacingUnspecifiedDimensions()
    }
}

/// Exactly the picture's shape, so its border and corners are the picture's,
/// not the column's. A Layout because aspectRatio and frame together leave a
/// tall picture in a box the column's width, or overflow when the height is
/// unbounded, as it is in a scroll view. Pixels count as 2x, so a small
/// diagram stays small and sharp while a big one fills the column.
private struct PictureFit: Layout {
    var pixels: CGSize?
    var maxHeight: CGFloat
    /// Under this a picture is too small to make out, or to tap.
    private let smallest: CGFloat = 120

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let pixels = pixels ?? CGSize(width: 2000, height: 1500)
        var natural = CGSize(width: pixels.width / 2, height: pixels.height / 2)
        if natural.width < smallest {
            natural = CGSize(width: smallest, height: natural.height * smallest / natural.width)
        }
        let fit = min(1, (proposal.width ?? natural.width) / natural.width, maxHeight / natural.height)
        return CGSize(width: (natural.width * fit).rounded(), height: (natural.height * fit).rounded())
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

/// In place of a picture or video the phone can't have: it hasn't gone up
/// yet, it's too big, or it's from a thread too old to have been looked through.
struct PictureOnMac: View {
    var alt: String
    var note = "On your Mac"

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "photo").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                if !alt.isEmpty { Text(alt).font(.subheadline) }
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// Full screen on black: pinch or double tap to zoom, drag about, share or
/// save from the top bar. It opens clear of the notch and the top bar, so all
/// of a tall picture shows. A video plays in the system's player instead.
struct PictureViewer: View {
    var url: URL
    var alt: String
    var preview: LoadedPicture?

    @Environment(\.dismiss) private var dismiss
    @State private var full: LoadedPicture?

    /// The top bar's buttons, and a little air under them.
    private static let barHeight: CGFloat = 52

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            if let picture = full ?? preview {
                if picture.isVideo, let file = picture.file {
                    VideoPane(file: file)
                } else {
                    // Read here, where the safe area still counts, as the
                    // picture itself goes edge to edge once zoomed.
                    GeometryReader { screen in
                        let safe = screen.safeAreaInsets
                        ZoomableImage(picture: picture, framing: PictureFraming(top: safe.top + Self.barHeight, left: safe.leading, bottom: safe.bottom, right: safe.trailing))
                            .ignoresSafeArea()
                    }
                }
            } else {
                ProgressView().tint(.white).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack {
                Button { dismiss() } label: { barIcon("xmark") }
                    .accessibilityLabel("Close")
                Spacer()
                if let picture = full ?? preview {
                    shareLink(picture).accessibilityLabel("Share")
                }
            }
            .padding(.horizontal)
        }
        .statusBarHidden()
        .task {
            // A video's file is the whole of it already.
            if preview?.isVideo != true { full = try? await PictureLoader.shared.picture(url, maxPixels: nil) }
        }
    }

    /// A moving picture goes as its file, so what's shared or saved still moves.
    @ViewBuilder private func shareLink(_ picture: LoadedPicture) -> some View {
        let preview = SharePreview(alt.isEmpty ? "Picture" : alt, image: Image(uiImage: picture.image))
        if let file = picture.file {
            ShareLink(item: file, preview: preview) { barIcon("square.and.arrow.up") }
        } else {
            ShareLink(item: Image(uiImage: picture.image), preview: preview) { barIcon("square.and.arrow.up") }
        }
    }

    private func barIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(.black.opacity(0.45), in: Circle())
    }
}

/// Starts playing as it opens, with sound even with the ringer off, as Mike
/// asked to see this one. Below the top bar, which would cover its controls.
private struct VideoPane: View {
    var file: URL
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .padding(.top, 52)
            .onAppear {
                try? AVAudioSession.sharedInstance().setCategory(.playback)
                try? AVAudioSession.sharedInstance().setActive(true)
                let player = AVPlayer(url: file)
                self.player = player
                player.play()
            }
            .onDisappear {
                player?.pause()
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
    }
}

/// UIScrollView for the zoom, which SwiftUI's gestures only come close to:
/// pinching about the fingers, the bounce at the limits, panning a zoomed
/// picture with the same drag.
private struct ZoomableImage: UIViewRepresentable {
    var picture: LoadedPicture
    var framing: PictureFraming

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> FittingScrollView {
        let scroll = FittingScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 8
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.imageView.contentMode = .scaleAspectFit
        scroll.addSubview(scroll.imageView)
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ scroll: FittingScrollView, context: Context) {
        scroll.imageView.show(picture)
        scroll.framing = framing
        scroll.setNeedsLayout()
    }

    final class FittingScrollView: UIScrollView {
        let imageView = MovingImageView()
        var framing = PictureFraming()
        private var fittedTo: CGSize = .zero
        private var fittedPicture: CGSize?
        private var fittedFraming = PictureFraming()

        override func layoutSubviews() {
            super.layoutSubviews()
            // Fit once per size (a rotation) or picture size, never mid-zoom.
            // By its size, as a playing GIF is a new UIImage every frame, which
            // would snap a zoomed picture back.
            if fittedTo != bounds.size || fittedPicture != imageView.image?.size || fittedFraming != framing {
                fittedTo = bounds.size
                fittedPicture = imageView.image?.size
                fittedFraming = framing
                zoomScale = 1
                imageView.frame = CGRect(origin: .zero, size: framing.fitted(imageView.image?.size ?? .zero, on: bounds.size))
                contentSize = imageView.frame.size
                center()
                // From the top of the picture: insets alone leave the offset
                // at zero, with the picture up under the notch.
                contentOffset = CGPoint(x: -contentInset.left, y: -contentInset.top)
            } else {
                center()
            }
        }

        /// Centred in the clear part of the screen while smaller than that.
        func center() {
            let insets = framing.insets(showing: contentSize, on: bounds.size)
            contentInset = UIEdgeInsets(top: insets.top, left: insets.left, bottom: insets.bottom, right: insets.right)
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            (scrollView as? FittingScrollView)?.imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            (scrollView as? FittingScrollView)?.center()
        }

        @objc func doubleTapped(_ tap: UITapGestureRecognizer) {
            guard let scroll = tap.view as? FittingScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let at = tap.location(in: scroll.imageView)
                let size = CGSize(width: scroll.bounds.width / 3, height: scroll.bounds.height / 3)
                scroll.zoom(to: CGRect(x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}
