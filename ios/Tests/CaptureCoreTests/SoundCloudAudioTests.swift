import CryptoKit
import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime
@testable import CaptureUI

private final class SoundCloudAudioProtocol: URLProtocol {
    static let lock = NSLock()
    nonisolated(unsafe) static var replies: [String: Data] = [:]
    nonisolated(unsafe) static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool {
        ["service.fixture.invalid", "media.fixture.invalid"].contains(request.url?.host ?? "")
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let data = Self.lock.withLock {
            Self.requests.append(request)
            return Self.replies[request.url!.path]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: data == nil ? 404 : 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Length": String(data?.count ?? 0)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let data { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class SoundCloudAudioTests: XCTestCase {
    @MainActor
    private func plan() throws -> JSONValue {
        let posts = #"[{"provider":"soundcloud","id":"1001","canonicalUrl":"https://soundcloud.com/fixture/track","author":{"handle":"fixture"},"postTitle":"Track","text":"Track description","media":[{"ref":"1.1","id":"1001","kind":"audio","url":"https://soundcloud.com/fixture/track","mimeType":"audio/mpeg","acquisition":"soundcloud-mp3","durationSeconds":1,"alt":""}],"soundcloud":{"kind":"track","trackId":"1001","artists":["Fixture"],"description":"Track description","durationSeconds":1,"originalDownloadAvailable":false}}]"#
        let result = try CaptureRuntime().compose(postsJSON: posts, policyJSON: "{}")
        return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(result.utf8))["plan"])
    }

    @MainActor
    private func fixture(hashOverride: String? = nil, capabilities: [String] = ["soundcloud-mp3-v1"],
                         run: (URL, URLSession, SoundCloudAudioService, JSONValue, Data) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("soundcloud-audio-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("tests/fixtures/soundcloud-tone.mp3")
        let audio = try Data(contentsOf: file)
        let hash = hashOverride ?? SHA256.hash(data: audio).map { String(format: "%02x", $0) }.joined()
        let source = try plan(), mediaPath = "/media/\(hash).mp3"
        let response: JSONValue = .object(["plan": source, "media": .object([
            "url": .string("https://media.fixture.invalid" + mediaPath), "hash": .string(hash),
            "extension": .string("mp3"), "mimeType": .string("audio/mpeg"), "size": .number(Double(audio.count))])])
        let replies = ["/v1/version": try JSONEncoder().encode(JSONValue.object(["planCapabilities": .array(capabilities.map(JSONValue.string))])),
                       "/v1/render": try JSONEncoder().encode(response), mediaPath: audio]
        SoundCloudAudioProtocol.lock.withLock { SoundCloudAudioProtocol.replies = replies; SoundCloudAudioProtocol.requests = [] }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SoundCloudAudioProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = try SoundCloudAudioService(endpoint: URL(string: "https://service.fixture.invalid")!, token: "service-token", session: session)
        try await run(root, session, service, source, audio)
    }

    @MainActor
    func testPreparationReturnsVerifiedMP3ForTheExistingUploadFlow() async throws {
        try await fixture { root, session, service, plan, audio in
            let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: root,
                                                 soundCloudService: { service }, mediaSession: session)
            let rendered = try await preparation.render(plan: plan, draftID: UUID())
            let result = try XCTUnwrap(rendered)
            XCTAssertEqual(result.contentType, "audio/mpeg")
            XCTAssertEqual(result.fileURL.pathExtension, "mp3")
            XCTAssertEqual(result.byteCount, audio.count)
            XCTAssertEqual(try Data(contentsOf: result.fileURL), audio)
            let requests = SoundCloudAudioProtocol.lock.withLock { SoundCloudAudioProtocol.requests }
            XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST", "GET"])
            XCTAssertEqual(requests.prefix(2).map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer service-token", "Bearer service-token"])
            XCTAssertNil(requests.last?.value(forHTTPHeaderField: "Authorization"))
        }
    }

    @MainActor
    func testDifferentDownloadedBytesStopPreparation() async throws {
        try await fixture(hashOverride: String(repeating: "f", count: 64)) { root, session, service, plan, _ in
            let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: root,
                                                 soundCloudService: { service }, mediaSession: session)
            do {
                _ = try await preparation.render(plan: plan, draftID: UUID())
                XCTFail("Expected verification failure")
            } catch { XCTAssertTrue(error.localizedDescription.contains("could not be verified")) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders").path))
        }
    }

    @MainActor
    func testOlderServiceStopsBeforeRequestingAudio() async throws {
        try await fixture(capabilities: []) { _, _, service, plan, _ in
            do { _ = try await service.render(plan: plan); XCTFail("Expected an unsupported-service error") }
            catch { XCTAssertTrue(error.localizedDescription.contains("Update the media service")) }
            let requests = SoundCloudAudioProtocol.lock.withLock { SoundCloudAudioProtocol.requests }
            XCTAssertEqual(requests.map { $0.url!.path }, ["/v1/version"])
        }
    }

    @MainActor
    func testMissingServiceKeepsTheAudioChoiceAndStopsPreparation() async throws {
        try await fixture { root, session, _, plan, _ in
            let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: root, mediaSession: session)
            do { _ = try await preparation.render(plan: plan, draftID: UUID()); XCTFail("Expected service configuration") }
            catch { XCTAssertTrue(error.localizedDescription.contains("Configure the SoundCloud media service")) }
            XCTAssertEqual(plan["block"]?["kind"], .string("audio"))
            XCTAssertEqual(SoundCloudAudioProtocol.lock.withLock { SoundCloudAudioProtocol.requests.count }, 0)
        }
    }

    func testServiceConfigurationRequiresHTTPSAndAnAccessToken() {
        XCTAssertThrowsError(try SoundCloudAudioService(endpoint: URL(string: "http://service.fixture.invalid")!, token: "token"))
        XCTAssertThrowsError(try SoundCloudAudioService(endpoint: URL(string: "https://user@service.fixture.invalid")!, token: "token"))
        XCTAssertThrowsError(try SoundCloudAudioService(endpoint: URL(string: "https://service.fixture.invalid")!, token: ""))
    }
}
