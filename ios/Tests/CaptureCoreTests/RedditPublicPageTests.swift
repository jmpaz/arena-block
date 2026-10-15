import CaptureRuntime
import Foundation
import XCTest

final class RedditPublicPageTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/\(name).json").standardizedFileURL
        return try String(contentsOf: url, encoding: .utf8)
    }
    @MainActor func testPublicHTMLRecordsResolveToExactSharedPlansOffline() async throws {
        let runtime = try CaptureRuntime()
        for kind in ["post", "comment"] {
            let record = try runtime.importRedditCapture(fixture("reddit-public-page-\(kind)"))
            let source = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])?["sourceUrl"] as? String)
            let raw = try await runtime.resolve(refs: [source], policyJSON: #"{"media":"all"}"#, redditCapturesJSON: "[" + record + "]")
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
            let actual = try XCTUnwrap(result["plan"] as? NSDictionary)
            let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture("reddit-public-page-\(kind)-plan").utf8)) as? NSDictionary)
            XCTAssertEqual(actual, expected)
            let edited = try runtime.edit(planJSON: String(decoding: JSONSerialization.data(withJSONObject: actual), as: UTF8.self), editsJSON: #"{"title":"Authored title","markdown":"Authored writing"}"#)
            let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(edited.utf8)) as? [String: Any])
            XCTAssertEqual((value["plan"] as? [String: Any])?["sources"] as? NSArray, actual["sources"] as? NSArray)
        }
    }
    @MainActor func testPublicBrowserRejectsForeignSchemesBeforeLoading() async throws {
        let reader = RedditPublicPageAcquirer(readerScript: "throw new Error('must not run')")
        for url in ["file:///tmp/source", "https://example.com/post", "https://name:secret@www.reddit.com/comments/abc/"] {
            do { _ = try await reader.acquire(url: url); XCTFail("Accepted a nonpublic source") }
            catch { XCTAssertTrue(error.localizedDescription.contains("HTTPS Reddit")) }
        }
    }
    @MainActor func testCancelledPublicReadDoesNotStartNavigation() async throws {
        let task = Task { @MainActor in
            try Task.checkCancellation()
            return try await RedditPublicPageAcquirer(readerScript: "throw new Error('must not run')").acquire(url: "https://www.reddit.com/comments/abc/")
        }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled read completed") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
}
