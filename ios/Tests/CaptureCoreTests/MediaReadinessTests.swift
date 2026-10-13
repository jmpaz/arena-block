import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CaptureCore

private final class MediaFixtureProtocol: URLProtocol {
    static let lock = NSLock()
    nonisolated(unsafe) static var responses: [String: (Int, Data)] = [:]
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.lock.withLock { Self.responses[request.url!.path] ?? (404, Data()) }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Length": String(body.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class MediaReadinessTests: XCTestCase {
    private func fixture(_ body: (URL) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("media-readiness-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await body(directory)
    }
    private func image(_ directory: URL, orientation: Int = 1) throws -> URL {
        let context = try XCTUnwrap(CGContext(data: nil, width: 32, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 32, height: 64))
        let output = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("jpg")
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(output as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), [kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination)); return output
    }
    private func audio(_ directory: URL) throws -> URL {
        let output = directory.appendingPathComponent("audio.m4a")
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48000)); buffer.frameLength = 48000
        let samples = try XCTUnwrap(buffer.floatChannelData)[0]
        for index in 0..<48000 { samples[index] = Float(sin(Double(index) * 2 * .pi * 440 / 48000) * 0.25) }
        let file = try AVAudioFile(forWriting: output, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000])
        try file.write(from: buffer); return output
    }
    private func session(_ assets: [String: (Int, Data)]) -> URLSession {
        MediaFixtureProtocol.lock.withLock { MediaFixtureProtocol.responses = assets }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MediaFixtureProtocol.self]
        return URLSession(configuration: config)
    }
    func testEXIFOrientationSurvivesStagingAndRecipe() async throws {
        try await fixture { root in
            let file = try image(root, orientation: 6)
            let source = try await NativeMediaRenderer.inspect(ref: "0.0", kind: "image", file: file)
            XCTAssertEqual(source.width, 64); XCTAssertEqual(source.height, 32)
            let output = try await NativeMediaRenderer.render(recipe: .init(kind: "link", width: 64, height: 32, tiles: [.init(ref: "0.0", rect: CGRect(x: 0, y: 0, width: 64, height: 32))], maximumBytes: 1024 * 1024), media: [source], directory: root)
            let inspected = try await NativeMediaRenderer.inspect(ref: "output", kind: "image", file: output.fileURL)
            XCTAssertEqual(inspected.width, 64); XCTAssertEqual(inspected.height, 32)
        }
    }
    func testPreparedVideoAndAACKeepAudioThroughMixedRecipe() async throws {
        try await fixture { root in
            let still = try await NativeMediaRenderer.inspect(ref: "still", kind: "image", file: image(root))
            let movie = try await NativeMediaRenderer.render(recipe: .init(kind: "video", width: 32, height: 64, tiles: [.init(ref: "still", rect: CGRect(x: 0, y: 0, width: 32, height: 64))], duration: 2, fps: 24, maximumBytes: 1024 * 1024), media: [still], directory: root)
            let sound = try audio(root)
            let local = session(["/video.mp4": (200, try Data(contentsOf: movie.fileURL)), "/audio.m4a": (200, try Data(contentsOf: sound))])
            defer { local.invalidateAndCancel() }
            let staged = try await NativeMediaRenderer.stage(ref: "video", kind: "video", source: URL(string: "https://fixture.invalid/video.mp4")!, directory: root.appendingPathComponent("staged"), audioSource: URL(string: "https://fixture.invalid/audio.m4a")!, session: local)
            XCTAssertTrue(staged.hasAudio)
            let recipe = NativeMediaRecipe(kind: "video", width: 64, height: 64, tiles: [.init(ref: "still", rect: CGRect(x: 0, y: 0, width: 32, height: 64)), .init(ref: "video", rect: CGRect(x: 32, y: 0, width: 32, height: 64))], duration: 3, fps: 24, audioRefs: ["video"], maximumBytes: 2 * 1024 * 1024)
            let output = try await NativeMediaRenderer.render(recipe: recipe, media: [still, staged], directory: root)
            let inspected = try await NativeMediaRenderer.inspect(ref: "result", kind: "video", file: output.fileURL)
            XCTAssertTrue(inspected.hasAudio); XCTAssertEqual(inspected.duration, 3, accuracy: 0.05)
            XCTAssertEqual(inspected.width, 64); XCTAssertEqual(inspected.height, 64)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("staged"), includingPropertiesForKeys: nil).count, 1)
        }
    }
    func testFailedDownloadDoesNotLeaveAStagedSubstitute() async throws {
        try await fixture { root in
            let local = session([:]); defer { local.invalidateAndCancel() }
            do {
                _ = try await NativeMediaRenderer.stage(ref: "missing", kind: "image", source: URL(string: "https://fixture.invalid/missing")!, directory: root, session: local)
                XCTFail("Missing media was accepted")
            } catch { XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).count, 0) }
        }
    }
    func testCancelledRenderKeepsSourceAndRemovesOutput() async throws {
        try await fixture { root in
            let source = try await NativeMediaRenderer.inspect(ref: "still", kind: "image", file: image(root))
            let task = Task {
                try await NativeMediaRenderer.render(recipe: .init(kind: "video", width: 640, height: 640, tiles: [.init(ref: "still", rect: CGRect(x: 0, y: 0, width: 640, height: 640))], duration: 300, maximumBytes: 2 * 1024 * 1024), media: [source], directory: root)
            }
            var started = false
            for _ in 0..<1000 {
                if try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).contains(where: { $0.pathExtension == "mp4" }) { started = true; break }
                try await Task.sleep(for: .milliseconds(1))
            }
            XCTAssertTrue(started, "Cancel only after the native encoder has created its work file")
            task.cancel()
            do { _ = try await task.value; XCTFail("Cancelled work produced media") }
            catch is CancellationError { }
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).map { $0.resolvingSymlinksInPath() }, [source.fileURL.resolvingSymlinksInPath()])
        }
    }
}
