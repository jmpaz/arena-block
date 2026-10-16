import Foundation
import XCTest
@testable import CaptureCore

private final class SubstackAudioProtocol: URLProtocol {
    static let lock = NSLock()
    nonisolated(unsafe) static var payload = Data()
    nonisolated(unsafe) static var declared: Int?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "audio.fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (data, length) = Self.lock.withLock { (Self.payload, Self.declared) }
        let headers = length.map { ["Content-Length": String($0)] } ?? [:]
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if request.url?.path == "/stall" { return }
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class SubstackMediaTests: XCTestCase {
    private func wav() -> Data {
        var data = Data()
        func text(_ value: String) { data.append(contentsOf: value.utf8) }
        func u16(_ value: UInt16) { var v=value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var v=value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(16036); text("WAVEfmt "); u32(16); u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16); text("data"); u32(16000); data.append(Data(repeating: 0, count: 16000)); return data
    }
    private func fixture(payload: Data, declared: Int? = nil, run: (URL, URLSession) async throws -> Void) async throws {
        let dir=FileManager.default.temporaryDirectory.appendingPathComponent("substack-audio-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        SubstackAudioProtocol.lock.withLock { SubstackAudioProtocol.payload=payload; SubstackAudioProtocol.declared=declared }
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[SubstackAudioProtocol.self]
        let session=URLSession(configuration: config); defer { session.invalidateAndCancel() }
        try await run(dir,session)
    }
    func testOriginalAudioUsesActualContainerAndPreservesBytes() async throws {
        let original=wav()
        try await fixture(payload: original) { dir, session in
            // The delivery URL intentionally lies about its container.
            let staged=try await NativeMediaRenderer.stageOriginalAudio(ref: "1.2", source: URL(string:"https://audio.fixture.invalid/original.mp3")!, directory: dir, session: session)
            XCTAssertEqual(staged.fileURL.pathExtension,"wav"); XCTAssertEqual(staged.duration,1,accuracy:0.01)
            try NativeMediaRenderer.verifyOriginalDuration(expected:1,actual:staged.duration)
            let output=try NativeMediaRenderer.originalAudio(staged,directory:dir)
            XCTAssertEqual(output.contentType,"audio/wav"); XCTAssertEqual(try Data(contentsOf: output.fileURL),original)
            XCTAssertNotEqual(output.fileURL, staged.fileURL)
            XCTAssertEqual(try Data(contentsOf: staged.fileURL), original)
            XCTAssertThrowsError(try NativeMediaRenderer.verifyOriginalDuration(expected:1460,actual:staged.duration))
        }
    }
    func testOwnedAudioWorkingDownloadPromotesWithoutASecondFullSizeCopy() async throws {
        let original = wav()
        try await fixture(payload: original) { root, session in
            let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs")
            defer { workspace.discard() }
            let staged = try await NativeMediaRenderer.stageOriginalAudio(ref: "1.1", source: URL(string: "https://audio.fixture.invalid/original")!, directory: workspace.directory, session: session)
            let output = try NativeMediaRenderer.originalAudio(staged, directory: workspace.directory)
            XCTAssertEqual(output.fileURL, staged.fileURL)
            let files = try FileManager.default.contentsOfDirectory(at: workspace.directory, includingPropertiesForKeys: nil)
                .filter { !$0.lastPathComponent.hasPrefix(".") }
            XCTAssertEqual(files.map { $0.resolvingSymlinksInPath() }, [staged.fileURL.resolvingSymlinksInPath()])
            let promoted = try workspace.promote(output, to: root.appendingPathComponent("renders/pending/attempt"))
            workspace.discard()
            XCTAssertEqual(try Data(contentsOf: promoted.fileURL), original)
            XCTAssertFalse(FileManager.default.fileExists(atPath: staged.fileURL.path))
        }
    }
    func testDeclaredAndStreamedOverflowCleanPartialFiles() async throws {
        for declared in [100000, nil] as [Int?] {
            try await fixture(payload: wav(),declared:declared) { dir,session in
                do { _ = try await NativeMediaRenderer.stageOriginalAudio(ref:"1.2",source:URL(string:"https://audio.fixture.invalid/a.wav")!,directory:dir,session:session,maximumBytes:100); XCTFail("Oversized original was accepted") } catch {}
                XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:dir.path),[])
            }
        }
    }
    func testInvalidOriginalAudioCleansPartialFile() async throws {
        try await fixture(payload:Data("<html>no audio</html>".utf8)) { dir,session in
            do { _ = try await NativeMediaRenderer.stageOriginalAudio(ref:"1.2",source:URL(string:"https://audio.fixture.invalid/a.mp3")!,directory:dir,session:session); XCTFail("Invalid audio was accepted") } catch {}
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:dir.path),[])
        }
    }
    func testStalledOriginalAudioCancellationCleansPartialFile() async throws {
        try await fixture(payload: Data()) { dir, session in
            let task = Task { try await NativeMediaRenderer.stageOriginalAudio(ref:"1.2",source:URL(string:"https://audio.fixture.invalid/stall")!,directory:dir,session:session) }
            try await Task.sleep(nanoseconds: 30_000_000); task.cancel()
            do { _ = try await task.value; XCTFail("Cancelled original was accepted") } catch {}
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:dir.path),[])
        }
    }
}
