import Foundation
import XCTest
@testable import CaptureCore

private final class HeaderFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: request.allHTTPHeaderFields)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private actor CallbackGate {
    var waiting: [CheckedContinuation<Void, Never>] = []
    var opened = false
    func wait() async { if !opened { await withCheckedContinuation { waiting.append($0) } } }
    func open() { opened = true; waiting.forEach { $0.resume() }; waiting = [] }
}
private final class DrainObservation: @unchecked Sendable {
    let lock = NSLock()
    private var completed = false
    var isCompleted: Bool { lock.withLock { completed } }
    func finish() { lock.withLock { completed = true } }
}

final class BackgroundReadinessTests: XCTestCase {
    private func completedTask(_ headers: [String: String], id: String) async throws -> (URLSession, URLSessionDataTask) {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [HeaderFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        var request = URLRequest(url: URL(string: "https://fixture.invalid/upload")!)
        headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
        var task: URLSessionDataTask!
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task = session.dataTask(with: request) { _, _, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
            task.taskDescription = id; task.resume()
        }
        return (session, task)
    }
    private func result(_ headers: [String: String]) async throws -> BackgroundHTTPResult {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("background-readiness-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = try BackgroundHTTP(identifier: "offline.fixture", group: "fixture-background", directory: directory)
        let (session, task) = try await completedTask(headers, id: "operation")
        defer { session.invalidateAndCancel() }
        transport.urlSession(session, task: task, didCompleteWithError: nil)
        return try XCTUnwrap(transport.result("operation"))
    }
    func testRFC850CutoffUsesStrictlyMoreThanFiftyYears() throws {
        let clock = ISO8601DateFormatter().date(from: "2026-10-02T12:00:00Z")!
        let cases = [
            ("Friday, 02-Oct-76 11:59:59 GMT", "2076-10-02T11:59:59Z"),
            ("Friday, 02-Oct-76 12:00:00 GMT", "2076-10-02T12:00:00Z"),
            ("Friday, 02-Oct-76 12:00:01 GMT", "1976-10-02T12:00:01Z")
        ]
        for (header, expected) in cases {
            let response = HTTPURLResponse(url: URL(string: "https://fixture.invalid")!, statusCode: 429, httpVersion: nil, headerFields: ["Retry-After": header])!
            XCTAssertEqual(BackgroundHTTP.retryDate(response, now: clock), ISO8601DateFormatter().date(from: expected), header)
        }
    }
    func testNumericRetryDelayIsPersistedBeforeRecovery() async throws {
        let now = Date(); let value = try await result(["Retry-After": "120"])
        XCTAssertEqual(try XCTUnwrap(value.retryAfter).timeIntervalSince(now), 120, accuracy: 1)
        XCTAssertEqual(value.status, 429)
    }
    func testHTTPDateRetryDelayIsPersistedBeforeRecovery() async throws {
        let expected = Date(timeIntervalSince1970: 1900000000)
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        for format in ["EEE, dd MMM yyyy HH:mm:ss 'GMT'", "EEEE, dd-MMM-yy HH:mm:ss 'GMT'", "EEE MMM d HH:mm:ss yyyy"] {
            formatter.dateFormat = format
            let value = try await result(["Retry-After": formatter.string(from: expected)])
            XCTAssertEqual(value.retryAfter, expected, format)
        }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let year = calendar.component(.year, from: Date())
        formatter.dateFormat = "EEEE, dd-MMM-yy HH:mm:ss 'GMT'"
        for offset in [44, 60] {
            let sent = calendar.date(from: DateComponents(year: year + offset, month: 1, day: 1))!
            let interpreted = calendar.date(from: DateComponents(year: year + (offset > 50 ? offset - 100 : offset), month: 1, day: 1))!
            let value = try await result(["Retry-After": formatter.string(from: sent)])
            XCTAssertEqual(value.retryAfter, interpreted, "RFC 850 two-digit years use the 50-year future window")
        }
    }
    func testRateLimitResetTakesPrecedenceOverRetryDelay() async throws {
        let value = try await result(["X-RateLimit-Reset": "1900000000", "Retry-After": "120"])
        XCTAssertEqual(value.retryAfter, Date(timeIntervalSince1970: 1900000000))
    }
    func testInvalidResetDoesNotDiscardValidRetryDelay() async throws {
        let now = Date(); let value = try await result(["X-RateLimit-Reset": "invalid", "Retry-After": "120"])
        XCTAssertEqual(try XCTUnwrap(value.retryAfter).timeIntervalSince(now), 120, accuracy: 1)
    }
    func testNonFiniteAndNegativeDelaysDoNotBecomeInvalidPersistedDates() async throws {
        for raw in ["nan", "inf", "-5", "invalid"] {
            let value = try await result(["Retry-After": raw]); XCTAssertNil(value.retryAfter)
        }
    }
    func testFinishedEventsWaitsForPersistedResultsAndEveryCallback() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("event-drain-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let transport = try BackgroundHTTP(identifier: "offline.fixture", group: "fixture-background", directory: root)
        let started = expectation(description: "Both recovery callbacks began"); started.expectedFulfillmentCount = 2
        let finished = expectation(description: "System completion waits for recovery")
        let gate = CallbackGate(); let observed = DrainObservation()
        transport.onResult = { id in
            XCTAssertNotNil(try? transport.result(id), "Persist the result before its recovery callback")
            started.fulfill(); await gate.wait()
        }
        transport.onFinishedEvents = { observed.finish(); finished.fulfill() }
        let first = try await completedTask([:], id: "first"), second = try await completedTask([:], id: "second")
        defer { first.0.invalidateAndCancel(); second.0.invalidateAndCancel() }
        transport.urlSession(first.0, task: first.1, didCompleteWithError: nil)
        transport.urlSession(second.0, task: second.1, didCompleteWithError: nil)
        transport.urlSessionDidFinishEvents(forBackgroundURLSession: first.0)
        await fulfillment(of: [started], timeout: 5)
        XCTAssertFalse(observed.isCompleted)
        await gate.open(); await fulfillment(of: [finished], timeout: 5)
        XCTAssertTrue(observed.isCompleted)
    }
}
