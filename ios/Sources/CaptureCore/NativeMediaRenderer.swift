import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import CoreVideo

public struct NativeRenderedMedia: Codable, Sendable {
    public var fileURL: URL
    public var contentType: String
    public var byteCount: Int
}

public struct NativeStagedMedia: Sendable {
    public var ref: String
    public var kind: String
    public var fileURL: URL
    public var width: Double
    public var height: Double
    public var duration: Double
    public var fps: Double
    public var hasAudio: Bool
    public init(ref: String, kind: String, fileURL: URL, width: Double, height: Double, duration: Double = 0, fps: Double = 0, hasAudio: Bool = false) {
        self.ref = ref; self.kind = kind; self.fileURL = fileURL; self.width = width; self.height = height
        self.duration = duration; self.fps = fps; self.hasAudio = hasAudio
    }
}

public struct NativeMediaRecipe: Sendable {
    public struct Tile: Sendable {
        public var ref: String
        public var rect: CGRect
        public init(ref: String, rect: CGRect) { self.ref = ref; self.rect = rect }
    }
    public var kind: String
    public var width: Int
    public var height: Int
    public var tiles: [Tile]
    public var duration: Double
    public var fps: Double
    public var audioRefs: [String]
    public var maximumBytes: Int
    public init(kind: String, width: Int, height: Int, tiles: [Tile], duration: Double = 0, fps: Double = 30, audioRefs: [String] = [], maximumBytes: Int) {
        self.kind = kind; self.width = width; self.height = height; self.tiles = tiles
        self.duration = duration; self.fps = fps; self.audioRefs = audioRefs; self.maximumBytes = maximumBytes
    }
    public init(json: JSONValue) throws {
        guard let kind = json["kind"]?.string, let width = json["width"]?.int, let height = json["height"]?.int else { throw CaptureError.message("The shared engine returned an invalid media recipe.") }
        func number(_ value: JSONValue?) -> Double { if case .number(let n) = value { return n }; return 0 }
        let tiles = try (json["tiles"]?.array ?? []).map { tile -> Tile in
            guard let ref = tile["ref"]?.string, let rect = tile["rect"] else { throw CaptureError.message("A media tile is incomplete.") }
            return Tile(ref: ref, rect: CGRect(x: number(rect["x"]), y: number(rect["y"]), width: number(rect["width"]), height: number(rect["height"])))
        }
        self.init(kind: kind, width: width, height: height, tiles: tiles, duration: number(json["duration"]), fps: number(json["fps"]), audioRefs: json["audio"]?.array.compactMap(\.string) ?? [], maximumBytes: (kind == "video" ? 250 : 20) * 1024 * 1024)
    }
}

private final class MediaRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, url.scheme == "https", url.user == nil, url.password == nil else { completionHandler(nil); return }
        var redirected = request
        redirected.setValue(nil, forHTTPHeaderField: "Authorization")
        redirected.setValue(nil, forHTTPHeaderField: "Cookie")
        completionHandler(redirected)
    }
}

public enum NativeMediaRenderer {
    public static let mediaSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 15 * 60
        return URLSession(configuration: configuration, delegate: MediaRedirectDelegate(), delegateQueue: nil)
    }()
    private struct ExportCancellation: @unchecked Sendable {
        let exporter: AVAssetExportSession
        func cancel() { exporter.cancelExport() }
    }

    public static func stage(ref: String, kind: String, source: URL, directory: URL, audioSource: URL? = nil, session: URLSession = NativeMediaRenderer.mediaSession) async throws -> NativeStagedMedia {
        if let audioSource {
            let video = try await stage(ref: ref, kind: kind, source: source, directory: directory, session: session)
            defer { try? FileManager.default.removeItem(at: video.fileURL) }
            return try await mux(ref: ref, video: video.fileURL, audioSource: audioSource, directory: directory, session: session)
        }
        guard source.scheme == "https", source.user == nil, source.password == nil else {
            throw CaptureError.message("This media does not have a secure download address.")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if kind == "video", source.pathExtension.lowercased() == "m3u8" {
            return try await stageStream(ref: ref, source: source, directory: directory)
        }
        let (download, response) = try await session.download(from: source)
        defer { try? FileManager.default.removeItem(at: download) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CaptureError.message("A source media file could not be downloaded.")
        }
        if kind == "video", ["application/vnd.apple.mpegurl", "application/x-mpegurl"].contains(http.mimeType?.lowercased() ?? "") {
            return try await stageStream(ref: ref, source: source, directory: directory)
        }
        let bytes = try download.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes > 0, bytes <= 500 * 1024 * 1024 else { throw CaptureError.message("This source media file is too large to process on this device.") }
        let file = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(kind == "image" ? "image" : "mp4")
        try FileManager.default.moveItem(at: download, to: file)
        do { return try await inspect(ref: ref, kind: kind, file: file) }
        catch { try? FileManager.default.removeItem(at: file); throw error }
    }

    private static func mux(ref: String, video: URL, audioSource: URL, directory: URL, session: URLSession) async throws -> NativeStagedMedia {
        guard audioSource.scheme == "https", audioSource.user == nil, audioSource.password == nil else { throw CaptureError.message("The audio source does not have a secure download address.") }
        let (audioFile, response) = try await session.download(from: audioSource)
        defer { try? FileManager.default.removeItem(at: audioFile) }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              let bytes = try audioFile.resourceValues(forKeys: [.fileSizeKey]).fileSize, bytes > 0, bytes <= 500 * 1024 * 1024 else {
            throw CaptureError.message("The video’s audio could not be downloaded. Capture will not save a silent substitute.")
        }
        let localAudio = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("m4a")
        try FileManager.default.moveItem(at: audioFile, to: localAudio)
        defer { try? FileManager.default.removeItem(at: localAudio) }
        let videoAsset = AVURLAsset(url: video)
        let audioAsset = AVURLAsset(url: localAudio)
        let composition = AVMutableComposition()
        guard let videoSource = try await videoAsset.loadTracks(withMediaType: .video).first,
              let audioTrack = try await audioAsset.loadTracks(withMediaType: .audio).first,
              let videoTarget = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let audioTarget = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw CaptureError.message("The separate video and audio tracks could not be joined.") }
        let videoRange = try await videoSource.load(.timeRange)
        let audioRange = try await audioTrack.load(.timeRange)
        try videoTarget.insertTimeRange(videoRange, of: videoSource, at: .zero)
        videoTarget.preferredTransform = try await videoSource.load(.preferredTransform)
        let audioDuration = CMTimeCompare(audioRange.duration, videoRange.duration) < 0 ? audioRange.duration : videoRange.duration
        try audioTarget.insertTimeRange(CMTimeRange(start: audioRange.start, duration: audioDuration), of: audioTrack, at: .zero)
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else { throw CaptureError.message("This device cannot combine the video and audio.") }
        let output = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
        exporter.outputURL = output
        exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = true
        let cancellation = ExportCancellation(exporter: exporter)
        do {
            try await withTaskCancellationHandler {
                await exporter.export()
                try Task.checkCancellation()
                guard exporter.status == .completed else { throw exporter.error ?? CaptureError.message("The video and audio could not be combined.") }
            } onCancel: { cancellation.cancel() }
            let result = try await inspect(ref: ref, kind: "video", file: output)
            guard result.hasAudio else { throw CaptureError.message("The combined video is missing its audio.") }
            return result
        } catch { try? FileManager.default.removeItem(at: output); throw error }
    }

    private static func stageStream(ref: String, source: URL, directory: URL) async throws -> NativeStagedMedia {
        let asset = AVURLAsset(url: source)
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else { throw CaptureError.message("This stream cannot be prepared on this device.") }
        let output = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
        exporter.outputURL = output
        exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = true
        let cancellation = ExportCancellation(exporter: exporter)
        do {
            try await withTaskCancellationHandler {
                await exporter.export()
                try Task.checkCancellation()
                guard exporter.status == .completed else { throw exporter.error ?? CaptureError.message("This stream could not be downloaded. Open Capture to try again.") }
            } onCancel: { cancellation.cancel() }
            return try await inspect(ref: ref, kind: "video", file: output)
        } catch { try? FileManager.default.removeItem(at: output); throw error }
    }

    public static func inspect(ref: String, kind: String, file: URL) async throws -> NativeStagedMedia {
        if kind == "image" {
            guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                  width.doubleValue > 0, height.doubleValue > 0 else { throw CaptureError.message("A source image could not be read.") }
            let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
            let rotated = [5, 6, 7, 8].contains(orientation)
            return NativeStagedMedia(ref: ref, kind: kind, fileURL: file, width: rotated ? height.doubleValue : width.doubleValue, height: rotated ? width.doubleValue : height.doubleValue, duration: 0, fps: 0, hasAudio: false)
        }
        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw CaptureError.message("This source does not contain a playable video.") }
        let size = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let oriented = CGRect(origin: .zero, size: size).applying(transform)
        let duration = try await asset.load(.duration).seconds
        let fps = try await track.load(.nominalFrameRate)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        guard duration.isFinite, duration > 0, oriented.width > 0, oriented.height > 0 else { throw CaptureError.message("This video has invalid dimensions or duration.") }
        return NativeStagedMedia(ref: ref, kind: kind, fileURL: file, width: abs(oriented.width), height: abs(oriented.height), duration: duration, fps: fps > 0 ? Double(fps) : 30, hasAudio: !audio.isEmpty)
    }

    public static func render(recipe: NativeMediaRecipe, media: [NativeStagedMedia], directory: URL) async throws -> NativeRenderedMedia {
        try Task.checkCancellation()
        guard recipe.width > 0, recipe.height > 0, recipe.width <= 16384, recipe.height <= 16384, !recipe.tiles.isEmpty else { throw CaptureError.message("The media layout is invalid.") }
        guard recipe.width * recipe.height <= 4096 * 4096 else { throw CaptureError.message("This composition is too large to render safely on this device.") }
        let assets = Dictionary(media.map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first })
        guard recipe.tiles.allSatisfy({ assets[$0.ref] != nil && $0.rect.width > 0 && $0.rect.height > 0 && $0.rect.minX >= 0 && $0.rect.minY >= 0 && $0.rect.maxX <= CGFloat(recipe.width) && $0.rect.maxY <= CGFloat(recipe.height) }) else { throw CaptureError.message("The media layout references a missing file or invalid tile.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(recipe.kind == "video" ? "mp4" : "jpg")
        do {
            if recipe.kind == "video" { try await renderVideo(recipe: recipe, assets: assets, file: file) }
            else { try renderImage(recipe: recipe, assets: assets, file: file) }
            let bytes = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard bytes > 0, bytes <= recipe.maximumBytes else { throw CaptureError.message("The rendered media exceeds Are.na’s upload limit. Choose fewer media items.") }
            return NativeRenderedMedia(fileURL: file, contentType: recipe.kind == "video" ? "video/mp4" : "image/jpeg", byteCount: bytes)
        } catch { try? FileManager.default.removeItem(at: file); throw error }
    }

    private static func decodedImage(_ file: URL, maximumDimension: Int) throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumDimension
              ] as CFDictionary) else { throw CaptureError.message("A source image could not be decoded.") }
        return image
    }

    private static func renderImage(recipe: NativeMediaRecipe, assets: [String: NativeStagedMedia], file: URL) throws {
        guard let context = CGContext(data: nil, width: recipe.width, height: recipe.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw CaptureError.message("There is not enough memory to compose these images.") }
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: recipe.width, height: recipe.height))
        for tile in recipe.tiles {
            try Task.checkCancellation()
            guard let media = assets[tile.ref], media.kind == "image" else { throw CaptureError.message("The image composition contains a video.") }
            let image = try decodedImage(media.fileURL, maximumDimension: max(recipe.width, recipe.height))
            let rect = CGRect(x: tile.rect.minX, y: CGFloat(recipe.height) - tile.rect.maxY, width: tile.rect.width, height: tile.rect.height)
            let scale = max(rect.width / CGFloat(image.width), rect.height / CGFloat(image.height))
            let size = CGSize(width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale)
            context.saveGState()
            context.clip(to: rect)
            context.draw(image, in: CGRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height))
            context.restoreGState()
        }
        guard let image = context.makeImage(), let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw CaptureError.message("The composed image could not be encoded.") }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw CaptureError.message("The composed image could not be saved.") }
    }

    private static func renderVideo(recipe: NativeMediaRecipe, assets: [String: NativeStagedMedia], file: URL) async throws {
        guard recipe.duration.isFinite, recipe.duration > 0, recipe.fps.isFinite, recipe.fps > 0, recipe.fps <= 60 else { throw CaptureError.message("The video timing is invalid.") }
        let composition = AVMutableComposition()
        var temporaryFiles: [URL] = []
        defer { for temporaryFile in temporaryFiles { try? FileManager.default.removeItem(at: temporaryFile) } }
        let duration = CMTime(seconds: recipe.duration, preferredTimescale: 600)
        var layers: [AVMutableVideoCompositionLayerInstruction] = []
        var audioParameters: [AVMutableAudioMixInputParameters] = []
        for tile in recipe.tiles {
            try Task.checkCancellation()
            guard let media = assets[tile.ref] else { throw CaptureError.message("A selected media file is missing.") }
            let sourceFile: URL
            if media.kind == "image" {
                sourceFile = file.deletingLastPathComponent().appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
                temporaryFiles.append(sourceFile)
                try await stillVideo(imageFile: media.fileURL, output: sourceFile, size: CGSize(width: max(2, Int(tile.rect.width / 2) * 2), height: max(2, Int(tile.rect.height / 2) * 2)))
            } else { sourceFile = media.fileURL }
            let asset = AVURLAsset(url: sourceFile)
            guard let source = try await asset.loadTracks(withMediaType: .video).first,
                  let target = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw CaptureError.message("The video composition could not be created.") }
            let sourceDuration = try await asset.load(.duration)
            try loop(source: source, into: target, sourceDuration: sourceDuration, duration: duration)
            let naturalSize = try await source.load(.naturalSize)
            let preferred = try await source.load(.preferredTransform)
            let bounds = CGRect(origin: .zero, size: naturalSize).applying(preferred)
            let scale = max(tile.rect.width / bounds.width, tile.rect.height / bounds.height)
            let transform = preferred.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
                .concatenating(CGAffineTransform(scaleX: scale, y: scale))
                .concatenating(CGAffineTransform(translationX: tile.rect.midX - bounds.width * scale / 2, y: tile.rect.midY - bounds.height * scale / 2))
            let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: target)
            layer.setTransform(transform, at: .zero)
            layer.setCropRectangle(tile.rect.applying(transform.inverted()).intersection(CGRect(origin: .zero, size: naturalSize)), at: .zero)
            layers.append(layer)
            if recipe.audioRefs.contains(tile.ref), let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first,
               let targetAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                let audioRange = try await sourceAudio.load(.timeRange)
                try loop(source: sourceAudio, into: targetAudio, sourceDuration: audioRange.duration, duration: duration, sourceStart: audioRange.start)
                let parameters = AVMutableAudioMixInputParameters(track: targetAudio)
                parameters.setVolume(1 / Float(max(1, recipe.audioRefs.count)), at: .zero)
                audioParameters.append(parameters)
            }
        }
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
        instruction.layerInstructions = layers
        instruction.backgroundColor = CGColor(gray: 0, alpha: 1)
        let video = AVMutableVideoComposition()
        video.renderSize = CGSize(width: recipe.width, height: recipe.height)
        video.frameDuration = CMTime(seconds: 1 / recipe.fps, preferredTimescale: 60000)
        video.instructions = [instruction]
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { throw CaptureError.message("This device cannot export the video composition.") }
        exporter.outputURL = file
        exporter.outputFileType = .mp4
        exporter.videoComposition = video
        let audioMix = AVMutableAudioMix()
        audioMix.inputParameters = audioParameters
        exporter.audioMix = audioMix
        exporter.shouldOptimizeForNetworkUse = true
        exporter.fileLengthLimit = Int64(recipe.maximumBytes)
        let cancellation = ExportCancellation(exporter: exporter)
        try await withTaskCancellationHandler {
            await exporter.export()
            try Task.checkCancellation()
            guard exporter.status == .completed else { throw exporter.error ?? CaptureError.message("The video export was interrupted. Try again when Capture is open.") }
        } onCancel: { cancellation.cancel() }
    }

    private static func loop(source: AVAssetTrack, into target: AVMutableCompositionTrack, sourceDuration: CMTime, duration: CMTime, sourceStart: CMTime = .zero) throws {
        guard sourceDuration.seconds.isFinite, sourceDuration.seconds > 0 else { throw CaptureError.message("A source video has no duration.") }
        var cursor = CMTime.zero
        while CMTimeCompare(cursor, duration) < 0 {
            try Task.checkCancellation()
            let remaining = CMTimeSubtract(duration, cursor)
            let length = CMTimeCompare(sourceDuration, remaining) < 0 ? sourceDuration : remaining
            try target.insertTimeRange(CMTimeRange(start: sourceStart, duration: length), of: source, at: cursor)
            cursor = CMTimeAdd(cursor, length)
        }
    }

    private static func stillVideo(imageFile: URL, output: URL, size: CGSize) async throws {
        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height)])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: Int(size.width), kCVPixelBufferHeightKey as String: Int(size.height), kCVPixelBufferCGImageCompatibilityKey as String: true, kCVPixelBufferCGBitmapContextCompatibilityKey as String: true])
        guard writer.canAdd(input) else { throw CaptureError.message("This device cannot include still images in a video.") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CaptureError.message("The image video encoder could not start.") }
        writer.startSession(atSourceTime: .zero)
        do {
            var pixel: CVPixelBuffer?
            guard CVPixelBufferCreate(kCFAllocatorDefault, Int(size.width), Int(size.height), kCVPixelFormatType_32ARGB, [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pixel) == kCVReturnSuccess, let pixel else { throw CaptureError.message("There is not enough memory to include this image in the video.") }
            CVPixelBufferLockBaseAddress(pixel, [])
            defer { CVPixelBufferUnlockBaseAddress(pixel, []) }
            guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { throw CaptureError.message("The image video buffer could not be created.") }
            let image = try decodedImage(imageFile, maximumDimension: Int(max(size.width, size.height)))
            let scale = max(size.width / CGFloat(image.width), size.height / CGFloat(image.height))
            context.draw(image, in: CGRect(x: (size.width - CGFloat(image.width) * scale) / 2, y: (size.height - CGFloat(image.height) * scale) / 2, width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale))
            let deadline = Date().addingTimeInterval(30)
            for frame in 0..<2 {
                while !input.isReadyForMoreMediaData {
                    try Task.checkCancellation()
                    guard writer.status == .writing, Date() < deadline else { throw writer.error ?? CaptureError.message("The image video encoder stopped responding.") }
                    try await Task.sleep(for: .milliseconds(10))
                }
                guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 1)) else { throw writer.error ?? CaptureError.message("A still image could not be added to the video.") }
            }
            writer.endSession(atSourceTime: CMTime(value: 1, timescale: 1))
            input.markAsFinished()
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? CaptureError.message("The image video could not be saved.") }
        } catch { writer.cancelWriting(); try? FileManager.default.removeItem(at: output); throw error }
    }
}
