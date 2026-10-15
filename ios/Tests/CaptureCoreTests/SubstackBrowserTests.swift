import CaptureCore
@testable import CaptureRuntime
import Foundation
import XCTest

final class SubstackBrowserTests: XCTestCase {
    private let source = "https://substack.com/@norvidstudies/note/c-360829302"
    private func fixture(_ name: String) throws -> String {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/\(name).json").standardizedFileURL
        return try String(contentsOf: file, encoding: .utf8)
    }

    func testNativeBridgeRefusesErrorAndManualRedirectsBeforeFollowing() throws {
        let delegate = CaptureRedirectDelegate()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let sourceURL = URL(string: source)!
        let response = HTTPURLResponse(url: sourceURL, statusCode: 302, httpVersion: nil, headerFields: nil)!
        for policy in ["error", "manual", "follow"] {
            let task = session.dataTask(with: sourceURL); task.taskDescription = policy
            for target in ["https://substack.com/note/c-359890078", "http://substack.com/note/c-359890078", "https://user:pass@substack.com/note/c-359890078"] {
                let request = URLRequest(url: URL(string: target)!)
                var called = false, result: URLRequest?
                delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: request) { value in called = true; result = value }
                XCTAssertTrue(called)
                XCTAssertEqual(result != nil, policy == "follow" && target == "https://substack.com/note/c-359890078")
            }
        }
    }

    @MainActor
    func testGeneratedNativeCoreImportsAndResolvesExactSharedPlanOffline() async throws {
        let runtime = try CaptureRuntime()
        let normalized = try runtime.importSubstackCapture(fixture("substack-browser-capture"))
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: source)
        draft.substackCapturesJSON = "[" + normalized + "]"
        let result = try await runtime.resolve(draft: draft, refs: [source], extraRefs: [], policyJSON: #"{"media":"none"}"#)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any])
        let actual = try XCTUnwrap(object["plan"] as? NSDictionary)
        let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture("substack-browser-plan").utf8)) as? NSDictionary)
        XCTAssertEqual(actual, expected)
        let edited = try runtime.edit(planJSON: String(decoding: JSONSerialization.data(withJSONObject: actual), as: UTF8.self),
                                      editsJSON: #"{"title":"Authored title","markdown":"Authored writing"}"#)
        let editedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(edited.utf8)) as? [String: Any])
        let editedPlan = try XCTUnwrap(editedObject["plan"] as? [String: Any])
        XCTAssertEqual(editedPlan["sources"] as? NSArray, actual["sources"] as? NSArray)
    }

    func testDraftSubmissionAndCacheIdentityRetainNotesWithoutChangingSourceRolesOrDestinations() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: source)
        draft.substackCapturesJSON = "[" + (try fixture("substack-browser-capture")) + "]"
        draft.titleOverride = "Keep title"
        let loaded = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(loaded.substackCapturesJSON, draft.substackCapturesJSON)
        let snapshot = try CaptureSubmissionSnapshot(draft: loaded)
        XCTAssertEqual(snapshot.substackCapturesJSON, draft.substackCapturesJSON)
        XCTAssertEqual(snapshot.title, "Keep title")
        let identity = draft.sourceReadIdentity(primary: [source], extra: [])
        draft.substackCapturesJSON = "[]"
        XCTAssertNotEqual(draft.sourceReadIdentity(primary: [source], extra: []), identity)
        draft.originalLinkOnly = true
        XCTAssertNil(try CaptureSubmissionSnapshot(draft: draft).substackCapturesJSON)
        XCTAssertEqual(CaptureInput.canonicalSourceIdentity(URL(string: source + "?utm_source=share")!), "substack:360829302")
        XCTAssertEqual(CaptureInput.canonicalSourceIdentity(URL(string: "https://substack.com/note/c-360829302")!), "substack:360829302")
    }

    @MainActor
    func testSubstackIntakeCommitsWithDraftAndWorkspaceAndSurvivesReload() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CaptureStore(url: directory.appendingPathComponent("capture.sqlite"))
        let raw = try fixture("substack-browser-capture")
        let incoming = PendingShare(id: UUID(), urls: [source], substackCaptureJSON: raw)
        try store.save(incoming, account: 0, kind: "incoming", id: incoming.id.uuidString)
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: source)
        draft.titleOverride = "Keep title"
        var workspace = CaptureWorkspace(); workspace.activeDraftID = draft.id
        let result = try store.commitNewCapture(draft, workspace: workspace, workspaceID: "main", consumingIncoming: true)
        XCTAssertEqual(result.draft.substackCapturesJSON, "[" + raw + "]")
        XCTAssertEqual(result.incoming, [])
        XCTAssertNil(result.draft.redditCapturesJSON)
        let replaced = try store.replaceBrowserSnapshot(in: result.draft, recordsJSON: "[]", workspaceID: "main", substack: true)
        XCTAssertEqual(replaced.titleOverride, "Keep title")
        XCTAssertEqual(try store.value(CaptureDraft.self, account: 1, kind: "draft", id: draft.id.uuidString)?.substackCapturesJSON, "[]")
    }

    @MainActor
    func testNativeImportRejectsSubstitutionAndOversize() throws {
        let runtime = try CaptureRuntime()
        let invalid = try fixture("substack-browser-capture").replacingOccurrences(of: "https://substack.com/@norvidstudies/note/c-360829302\",\n  \"observedAt", with: "https://substack.com/note/c-999\",\n  \"observedAt")
        XCTAssertThrowsError(try runtime.importSubstackCapture(invalid))
        XCTAssertThrowsError(try runtime.importSubstackCapture(String(repeating: "x", count: 2 * 1024 * 1024 + 1)))
    }
}
