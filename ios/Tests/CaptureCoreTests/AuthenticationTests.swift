import Foundation
import XCTest
@testable import CaptureCore

private final class AuthenticationProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let accepted = request.url?.absoluteString == "https://api.are.na/v3/me"
            && request.httpMethod == "GET"
            && request.value(forHTTPHeaderField: "Authorization") == "Bearer test-access-token"
        let body = accepted
            ? #"{"id":1,"name":"Test account","slug":"test-account","tier":"free"}"#
            : #"{"error":"Unauthorized"}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: accepted ? 200 : 401, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

final class AuthenticationTests: XCTestCase {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthenticationProtocol.self]
        return URLSession(configuration: configuration)
    }

    func testAccountCheckSendsBearerTokenToV3Me() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let account = try await ArenaAPI(token: "test-access-token", session: session).me()
        XCTAssertEqual(account.id, 1)
    }

    func testRejectedInitialTokenDoesNotClaimAnExpiredSessionOrSavedDraft() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        do {
            _ = try await ArenaAPI(token: "rejected-token", session: session).me()
            XCTFail("A rejected token must not connect an account")
        } catch let error as CaptureError {
            guard case .http(401, _) = error else { return XCTFail("Expected HTTP 401") }
            XCTAssertTrue(error.localizedDescription.contains("HTTP 401"))
            XCTAssertFalse(error.localizedDescription.contains("expired"))
            XCTAssertFalse(error.localizedDescription.contains("draft"))
            XCTAssertFalse(error.localizedDescription.contains("rejected-token"))
        }
    }
}
