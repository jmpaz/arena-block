import CaptureCore
import CaptureRuntime
import Foundation
import XCTest
import SQLite3

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
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: source)
        draft.redditCapturesJSON = "[" + normalized + "]"
        let resolved = try await runtime.resolve(draft: draft, refs: [source], extraRefs: [], policyJSON: #"{"media":"all"}"#)
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

    func testSourceCacheIdentityIncludesRecordContentAndObservation() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://www.reddit.com/comments/abc1234/")
        draft.redditCapturesJSON = "[" + (try fixture("reddit-browser-capture")) + "]"
        let primary = [draft.input]
        let identity = draft.sourceReadIdentity(primary: primary, extra: [])
        draft.titleOverride = "Authored edit"
        XCTAssertEqual(draft.sourceReadIdentity(primary: primary, extra: []), identity)
        draft.redditCapturesJSON = draft.redditCapturesJSON?.replacingOccurrences(of: "2026-10-01", with: "2026-10-02")
        XCTAssertNotEqual(draft.sourceReadIdentity(primary: primary, extra: []), identity)
        XCTAssertNotEqual(draft.sourceReadIdentity(primary: ["https://www.reddit.com/comments/other/"], extra: []), identity)
    }

    @MainActor
    func testSnapshotReplacementCommitsBeforeReturningAndRollsBackOnWorkspaceFailure() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("capture.sqlite")
        let store = try CaptureStore(url: url)
        var current = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://www.reddit.com/comments/abc1234/")
        current.titleOverride = "Keep this writing"; current.redditCapturesJSON = "[]"
        try store.save(current, account: 1, kind: "draft", id: current.id.uuidString)
        var connection: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &connection), SQLITE_OK)
        defer { sqlite3_close(connection) }
        XCTAssertEqual(sqlite3_exec(connection, "CREATE TRIGGER reject_workspace BEFORE INSERT ON records WHEN NEW.kind='workspace' BEGIN SELECT RAISE(ABORT,'injected disk failure'); END", nil, nil, nil), SQLITE_OK)
        let records = "[" + (try fixture("reddit-browser-capture")) + "]"
        XCTAssertThrowsError(try store.replaceBrowserSnapshot(in: current, recordsJSON: records, workspaceID: "main"))
        let unchanged = try XCTUnwrap(store.value(CaptureDraft.self, account: 1, kind: "draft", id: current.id.uuidString))
        XCTAssertEqual(unchanged.redditCapturesJSON, "[]"); XCTAssertEqual(unchanged.titleOverride, "Keep this writing")
        XCTAssertEqual(sqlite3_exec(connection, "DROP TRIGGER reject_workspace", nil, nil, nil), SQLITE_OK)
        let committed = try store.replaceBrowserSnapshot(in: current, recordsJSON: records, workspaceID: "main")
        XCTAssertEqual(committed.redditCapturesJSON, records); XCTAssertEqual(committed.titleOverride, current.titleOverride)
        XCTAssertEqual(try store.value(CaptureDraft.self, account: 1, kind: "draft", id: current.id.uuidString)?.redditCapturesJSON, records)
    }

    @MainActor
    func testQueuedSnapshotSelectionAndConsumptionShareTheDraftTransaction() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("capture.sqlite")
        let store = try CaptureStore(url: url)
        let source = "https://www.reddit.com/comments/abc1234/"
        let older = PendingShare(id: UUID(), urls: [source], redditCaptureJSON: try fixture("reddit-browser-capture"))
        let newerRecord = try fixture("reddit-browser-capture").replacingOccurrences(of: "2026-10-01", with: "2026-10-02")
        let newer = PendingShare(id: UUID(), urls: [source], redditCaptureJSON: newerRecord)
        for item in [older, newer] { try store.save(item, account: 0, kind: "incoming", id: item.id.uuidString) }
        let draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: source)
        var workspace = CaptureWorkspace(); workspace.activeDraftID = draft.id
        var connection: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &connection), SQLITE_OK)
        defer { sqlite3_close(connection) }
        XCTAssertEqual(sqlite3_exec(connection, "CREATE TRIGGER reject_workspace BEFORE INSERT ON records WHEN NEW.kind='workspace' BEGIN SELECT RAISE(ABORT,'injected disk failure'); END", nil, nil, nil), SQLITE_OK)
        XCTAssertThrowsError(try store.commitNewCapture(draft, workspace: workspace, workspaceID: "main", consumingIncoming: true))
        XCTAssertEqual(try store.values(PendingShare.self, account: 0, kind: "incoming").count, 2)
        XCTAssertNil(try store.value(CaptureDraft.self, account: 1, kind: "draft", id: draft.id.uuidString))
        XCTAssertEqual(sqlite3_exec(connection, "DROP TRIGGER reject_workspace", nil, nil, nil), SQLITE_OK)
        let committed = try store.commitNewCapture(draft, workspace: workspace, workspaceID: "main", consumingIncoming: true)
        XCTAssertEqual(committed.draft.redditCapturesJSON, "[" + newerRecord + "]")
        XCTAssertEqual(committed.incoming, [])
        XCTAssertEqual(try store.values(PendingShare.self, account: 0, kind: "incoming").count, 0)
        XCTAssertEqual(try store.value(CaptureDraft.self, account: 1, kind: "draft", id: draft.id.uuidString)?.redditCapturesJSON, committed.draft.redditCapturesJSON)
    }

}
