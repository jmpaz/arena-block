#if os(iOS)
import CaptureCore
import AVFoundation
import ImageIO
import SwiftUI
import UIKit

struct CaptureMediaSelection: View {
    @Bindable var session: CaptureSession
    var locked = false
    var sourceIndex: Int? = nil
    @State private var inspected: MediaChoice?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var thumbnailSize: CGFloat { dynamicTypeSize.isAccessibilitySize ? 92 : 72 }

    private var assetsBySource: [[MediaChoice]] {
        let fixturePoster = ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] == "video-frame"
            ? session.container.appendingPathComponent("fixture-0.jpg") : nil
        var position = 0
        return (session.preview?.plan?["sources"]?.array ?? []).map { source in
            (source["media"]?.array ?? []).compactMap { asset in
                defer { position += 1 }
                return MediaChoice(asset, position: position, localFixturePoster: fixturePoster)
            }
        }
    }
    private var assets: [MediaChoice] { presentedAssetsBySource.flatMap { $0 } }
    private var presentedAssetsBySource: [[MediaChoice]] {
        if let sourceIndex, assetsBySource.indices.contains(sourceIndex) {
            return [assetsBySource[sourceIndex]]
        }
        return assetsBySource
    }

    private func usesFrame(_ ref: String) -> Bool {
        if let chosen = session.draft?.videoFrames { return chosen.contains(ref) }
        return session.preview?.plan?["block"]?["frameMedia"]?.array.contains { $0["ref"]?.string == ref } == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if sourceIndex == nil && assets.count == 1, let asset = assets.first {
                singleAssetControls(asset)
            } else {
                if sourceIndex == nil {
                    HStack(spacing: 16) {
                        Text("Media").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if dynamicTypeSize.isAccessibilitySize {
                            Menu("Select") {
                                Button("All") { session.setMedia(.all) }
                                Button("None") { session.setMedia(.none) }
                            }
                            .accessibilityLabel("Select media")
                            .accessibilityIdentifier("capture.media.bulk")
                        } else {
                            Button("All") { session.setMedia(.all) }
                                .frame(minWidth: 44, minHeight: 44)
                                .accessibilityIdentifier("capture.media.all")
                            Button("None") { session.setMedia(.none) }
                                .frame(minWidth: 44, minHeight: 44)
                                .accessibilityIdentifier("capture.media.none")
                        }
                    }
                    .font(.caption).buttonStyle(.borderless)
                }
            ForEach(presentedAssetsBySource.indices, id: \.self) { presentedIndex in
                if !presentedAssetsBySource[presentedIndex].isEmpty {
                    if sourceIndex == nil && presentedAssetsBySource.count > 1 {
                        Text("Post \(presentedIndex + 1)").font(.subheadline.weight(.medium))
                            .padding(.top, presentedIndex == 0 ? 0 : 8)
                    }
                    ScrollView(.horizontal) {
                      LazyHStack(spacing: 12) {
                        ForEach(presentedAssetsBySource[presentedIndex]) { asset in
                        let included = session.includedMediaRefs.contains(asset.id)
                        VStack(spacing: 8) {
                            Button { session.toggleMedia(asset.id) } label: {
                                MediaThumbnail(asset: asset, usesFrame: usesFrame(asset.id))
                                    .frame(width: thumbnailSize, height: thumbnailSize).clipped()
                                    .opacity(included ? 1 : 0.42)
                                    .overlay {
                                        Rectangle().strokeBorder(Color.primary.opacity(included ? 0.9 : 0.15), lineWidth: included ? 2 : 1)
                                    }
                                    .overlay(alignment: .bottomTrailing) {
                                        Image(systemName: included ? "checkmark.square.fill" : "square")
                                            .font(.body)
                                            .foregroundStyle(.primary)
                                            .background(Color(uiColor: .systemBackground))
                                            .padding(5)
                                    }
                                    .overlay(alignment: .topLeading) {
                                        if asset.isPreview {
                                            Text("Preview").font(.caption2)
                                                .padding(3).background(Color(uiColor: .systemBackground))
                                        }
                                    }
                            }
                            .buttonStyle(MediaChoiceButtonStyle())
                            .accessibilityLabel(asset.label)
                            .accessibilityValue((included ? "Included" : "Excluded") + (usesFrame(asset.id) ? ", video frame" : "") + (asset.isPreview ? ", preview" : ""))
                            .accessibilityHint(included ? "Exclude this media" : "Include this media")
                            .accessibilityIdentifier("capture.media.asset.\(asset.id)")
                            .contextMenu {
                                Button("Preview", systemImage: "arrow.up.left.and.arrow.down.right") { inspected = asset }
                            }
                            if asset.kind == "video" {
                                let forced = asset.posterURL != nil &&
                                    (asset.durationSeconds.map { $0 > Double(session.draft?.videoFrameThresholdSeconds ?? 600) } ?? false)
                                Menu {
                                    Button("None", systemImage: included ? "circle" : "checkmark") {
                                        session.chooseVideo(asset.id, as: .none)
                                    }
                                    Button("Video", systemImage: included && !usesFrame(asset.id) ? "checkmark" : "play.rectangle") {
                                        session.chooseVideo(asset.id, as: .video)
                                    }.disabled(forced)
                                    if asset.posterURL != nil {
                                        Button("Frame from video", systemImage: included && usesFrame(asset.id) ? "checkmark" : "photo") {
                                            session.chooseVideo(asset.id, as: .frame)
                                        }
                                    } else {
                                        Button("Frame unavailable for this source", systemImage: "photo") { }
                                            .disabled(true)
                                    }
                                } label: {
                                    HStack(spacing: 4) {
                                        Text(!included ? "None" : forced ? "Frame · duration" : usesFrame(asset.id) ? "Frame" : "Video")
                                        Image(systemName: "chevron.down").font(.caption2)
                                    }
                                    .font(.footnote.weight(.medium))
                                    .frame(minWidth: 92, minHeight: 36)
                                }
                                .disabled(locked)
                                .accessibilityIdentifier("capture.media.frame.\(asset.id)")
                            }
                        }
                        }
                      }
                    }.scrollIndicators(.hidden)
                }
            }
            }
        }
        .disabled(locked)
        .sensoryFeedback(.selection, trigger: session.includedMediaRefs)
        .sheet(item: $inspected) { asset in
            NavigationStack {
                Group {
                    if let url = asset.url { CaptureMediaView(url: url, isVideo: asset.kind == "video") }
                    else { ContentUnavailableView("Preview unavailable", systemImage: "photo") }
                }
                .navigationTitle(asset.label).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(session.includedMediaRefs.contains(asset.id) ? "Exclude" : "Include") {
                            session.toggleMedia(asset.id)
                        }.disabled(locked)
                    }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { inspected = nil } }
                }
            }.presentationDetents([.large])
        }
    }

    @ViewBuilder
    private func singleAssetControls(_ asset: MediaChoice) -> some View {
        let included = session.includedMediaRefs.contains(asset.id)
        let usesAutomaticFrame = asset.posterURL != nil &&
            (asset.durationSeconds.map { $0 > Double(session.draft?.videoFrameThresholdSeconds ?? 600) } ?? false)
        if asset.kind == "video" {
            Text("Video from post").font(.caption).foregroundStyle(.secondary)
            if session.renderURL == nil {
                Button { inspected = asset } label: {
                    MediaThumbnail(asset: asset, usesFrame: usesFrame(asset.id), maxPixel: 1200)
                        .frame(maxWidth: .infinity).frame(height: 150).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .opacity(included ? 1 : 0.42)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Inspect video preview")
            }
            Picker("Video from post", selection: Binding(
                get: { !included ? .none : (usesAutomaticFrame || usesFrame(asset.id) ? .frame : .video) },
                set: { session.chooseVideo(asset.id, as: $0) })) {
                Text("None").tag(CaptureVideoChoice.none)
                if !usesAutomaticFrame { Text("Video").tag(CaptureVideoChoice.video) }
                if asset.posterURL != nil { Text("Frame").tag(CaptureVideoChoice.frame) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("capture.media.choice.\(asset.id)")
            if usesAutomaticFrame {
                Text("A frame is used for videos over the selected duration.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if asset.posterURL == nil {
                Text("Frame unavailable for this source")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if included && (usesAutomaticFrame || usesFrame(asset.id)) {
                Text("Uses the poster frame shown above")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        } else {
            HStack {
                Spacer()
                Button {
                    session.toggleMedia(asset.id)
                } label: {
                    Label(included ? "Included" : "Include", systemImage: included ? "checkmark.circle.fill" : "circle")
                        .font(.subheadline.weight(.medium))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(included ? "Exclude \(asset.kind)" : "Include \(asset.kind)")
                .accessibilityValue(included ? "Included" : "Excluded")
                .accessibilityIdentifier("capture.media.asset.\(asset.id)")
            }
        }
    }
}

private struct MediaChoice: Identifiable {
    let id: String
    let kind: String
    let url: URL?
    let posterURL: URL?
    let thumbnailURL: URL?
    let durationSeconds: Double?
    let label: String
    let position: Int
    let isPreview: Bool

    init?(_ asset: JSONValue, position: Int, localFixturePoster: URL? = nil) {
        guard let ref = asset["ref"]?.string else { return nil }
        id = ref
        kind = asset["kind"]?.string ?? "image"
        isPreview = asset["sourceRole"]?.string == "preview"
        self.position = position
        url = asset["url"]?.string.flatMap(URL.init(string:))
        let resolvedPoster = asset["posterUrl"]?.string.flatMap(URL.init(string:))
        posterURL = resolvedPoster
        if kind == "video", let resolvedPoster { thumbnailURL = localFixturePoster ?? resolvedPoster }
        else { thumbnailURL = resolvedPoster }
        if case .number(let value)? = asset["durationSeconds"] { durationSeconds = value } else { durationSeconds = nil }
        label = asset["alt"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "\(kind.capitalized) \(position + 1)"
    }
}

private struct MediaThumbnail: View {
    let asset: MediaChoice
    let usesFrame: Bool
    var maxPixel = 240
    @State private var localImage: UIImage?

    var body: some View {
        Group {
            if let localImage { Image(uiImage: localImage).resizable().scaledToFill() }
            else { placeholder }
        }
        .overlay {
            if asset.kind == "video", localImage != nil {
                Image(systemName: usesFrame ? "photo.fill" : "play.fill")
                    .foregroundStyle(.white).padding(7).background(.black.opacity(0.55), in: Circle())
            }
        }
        .task(id: asset.kind == "video" ? asset.thumbnailURL ?? asset.url : asset.url) {
            localImage = nil
            guard let url = asset.kind == "video" ? asset.thumbnailURL ?? asset.url : asset.url else { return }
            let loaded = await MediaThumbnailCache.shared.image(for: url, video: asset.kind == "video" && asset.posterURL == nil, maxPixel: maxPixel)
            guard !Task.isCancelled else { return }
            localImage = loaded
        }
    }

    private var placeholder: some View {
        Rectangle().fill(Color(uiColor: .secondarySystemBackground))
            .overlay {
                Image(systemName: asset.kind == "video" ? "play.fill" : asset.kind == "audio" ? "waveform" : "photo")
                    .font(.title3).foregroundStyle(.secondary)
            }
            .overlay(alignment: .bottomLeading) {
                Text(asset.position + 1, format: .number).font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary).padding(6)
            }
    }
}

/// Only visible thumbnails load. Remote videos keep a play placeholder until
/// explicitly previewed; image downloads and the decoded cache are bounded.
private actor MediaThumbnailCache {
    static let shared = MediaThumbnailCache()
    private struct CacheKey: Hashable { let url: URL; let maxPixel: Int }
    private var images: [CacheKey: UIImage] = [:]
    private var order: [CacheKey] = []
    private let byteLimit = 6 * 1024 * 1024

    func image(for url: URL, video: Bool, maxPixel: Int) async -> UIImage? {
        let key = CacheKey(url: url, maxPixel: maxPixel)
        if let image = images[key] { return image }
        let image: UIImage?
        if video {
            guard url.isFileURL else { return nil }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: maxPixel, height: maxPixel)
            image = await withTaskCancellationHandler {
                guard let result = try? await generator.image(at: .zero) else { return nil }
                return UIImage(cgImage: result.image)
            } onCancel: { generator.cancelAllCGImageGeneration() }
        } else if url.isFileURL {
            image = Self.downsample(CGImageSourceCreateWithURL(url as CFURL, nil), maxPixel: maxPixel)
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 10
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            do {
                let (bytes, response) = try await session.bytes(from: url)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                      response.expectedContentLength <= Int64(byteLimit) else { return nil }
                var data = Data()
                for try await byte in bytes {
                    try Task.checkCancellation()
                    guard data.count < byteLimit else { return nil }
                    data.append(byte)
                }
                image = Self.downsample(CGImageSourceCreateWithData(data as CFData, nil), maxPixel: maxPixel)
            } catch { return nil }
        }
        guard !Task.isCancelled, let image else { return nil }
        if order.count >= 24 { images.removeValue(forKey: order.removeFirst()) }
        images[key] = image; order.append(key)
        return image
    }

    private static func downsample(_ source: CGImageSource?, maxPixel: Int) -> UIImage? {
        guard let source,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

private struct MediaChoiceButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .scaleEffect(reduceMotion ? 1 : configuration.isPressed ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
#endif
