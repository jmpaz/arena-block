import CaptureCore
import CaptureRuntime
import Foundation
import XCTest

final class RedditBrowserTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/\(name).json").standardizedFileURL
        return try String(contentsOf: path, encoding: .utf8)
    }

    @MainActor
    func testBrowserRecordResolvesOfflineWithBodyMediaAndMatchingSharedPlan() async throws {
        let runtime = try CaptureRuntime()
        let normalized = try runtime.importRedditCapture(fixture("reddit-browser-capture"))
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(normalized.utf8)) as? [String: Any])
        let source = try XCTUnwrap(record["sourceUrl"] as? String)
        let resolved = try await runtime.resolve(refs: [source], policyJSON: #"{"media":"all"}"#, redditCapturesJSON: "[" + normalized + "]")
        let response = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(resolved.utf8)) as? [String: Any])
        let plan = try XCTUnwrap(response["plan"] as? [String: Any])
        let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture("reddit-browser-plan").utf8)) as? [String: Any])
        XCTAssertEqual(plan as NSDictionary, expected as NSDictionary)
        let edited = try runtime.edit(planJSON: String(decoding: JSONSerialization.data(withJSONObject: plan), as: UTF8.self),
                                      editsJSON: #"{"title":"Authored title","markdown":"Authored writing","description":"Authored description"}"#)
        let editedResponse = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(edited.utf8)) as? [String: Any])
        let editedPlan = try XCTUnwrap(editedResponse["plan"] as? [String: Any])
        XCTAssertEqual((editedPlan["block"] as? [String: Any])?["markdown"] as? String, "Authored writing")
        XCTAssertEqual((editedPlan["sources"] as? NSArray), plan["sources"] as? NSArray)
    }

    @MainActor
    func testNativeImportRejectsMismatchedRecordsAndOversizeBeforeReading() throws {
        let runtime = try CaptureRuntime()
        var record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture("reddit-browser-capture").utf8)) as? [String: Any])
        record["sourceUrl"] = "https://www.reddit.com/comments/wrong/"
        XCTAssertThrowsError(try runtime.importRedditCapture(String(decoding: JSONSerialization.data(withJSONObject: record), as: UTF8.self)))
        XCTAssertThrowsError(try runtime.importRedditCapture(String(repeating: "x", count: 2 * 1024 * 1024 + 1)))
    }

    func testDraftAndFrozenSubmissionRetainBrowserRecordWhileOriginalLinkChoiceOmitsIt() throws {
        let record = try fixture("reddit-browser-capture")
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://www.reddit.com/comments/abc1234/")
        draft.redditCapturesJSON = "[" + record + "]"
        draft.titleOverride = "Authored title"
        let reloaded = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(reloaded.redditCapturesJSON, draft.redditCapturesJSON)
        let snapshot = try CaptureSubmissionSnapshot(draft: reloaded)
        XCTAssertEqual(snapshot.redditCapturesJSON, draft.redditCapturesJSON)
        XCTAssertEqual(snapshot.title, "Authored title")
        draft.originalLinkOnly = true
        XCTAssertNil(try CaptureSubmissionSnapshot(draft: draft).redditCapturesJSON)
        XCTAssertEqual(CaptureInput.canonicalSourceIdentity(URL(string: "https://www.reddit.com/r/test/comments/abc1234/title/def4567/?context=3")!), "reddit:abc1234:def4567")
        XCTAssertEqual(CaptureInput.canonicalSourceIdentity(URL(string: "https://reddit.com/comments/abc1234/comment/def4567/")!), "reddit:abc1234:def4567")
        XCTAssertNotEqual(CaptureInput.canonicalSourceIdentity(URL(string: "https://redd.it/abc1234")!), "reddit:abc1234:def4567")
    }
    @MainActor
    func testRetainedPublicBrowserRecordsMatchCLIPlans() async throws {
        guard let directory = ProcessInfo.processInfo.environment["ARENA_REDDIT_BROWSER_LIVE_EVIDENCE"] else {
            throw XCTSkip("Set the retained public browser evidence directory explicitly.")
        }
        let runtime = try CaptureRuntime()
        for (recordName, planName) in [("browser-capture-claude.json", "browser-claude-plan.json"),
                                       ("browser-capture-comment.json", "browser-comment-plan.json")] {
            let root = URL(fileURLWithPath: directory)
            let normalized = try runtime.importRedditCapture(String(contentsOf: root.appendingPathComponent(recordName), encoding: .utf8))
            let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(normalized.utf8)) as? [String: Any])
            let source = try XCTUnwrap(record["sourceUrl"] as? String)
            let result = try await runtime.resolve(refs: [source], policyJSON: #"{"media":"all"}"#, redditCapturesJSON: "[" + normalized + "]")
            let response = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any])
            let plan = try XCTUnwrap(response["plan"] as? [String: Any])
            let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(planName))) as? [String: Any])
            XCTAssertEqual(plan as NSDictionary, expected as NSDictionary)
        }
    }

}
