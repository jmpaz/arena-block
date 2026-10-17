import CaptureCore
import CaptureRuntime
import Foundation
import XCTest
@testable import CaptureUI

final class QuoteAuthorLinkTests: XCTestCase {
    private func json(_ value: JSONValue) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }

    private func fixtures() throws -> [JSONValue] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/quote-author-links-legacy-plans.json").standardizedFileURL
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)).array
    }

    @MainActor private func composed(_ runtime: CaptureRuntime, _ plan: JSONValue, style: CaptureQuoteAuthorLink?) throws -> JSONValue {
        var policy = plan["policy"]!.object
        if let style { policy["quoteAuthorLink"] = .string(style.rawValue) }
        let response = try runtime.compose(postsJSON: json(plan["sources"]!), policyJSON: json(.object(policy)))
        return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(response.utf8))["plan"])
    }

    func testChoicePersistsInDraftAndFrozenSubmissionWhileOldDraftHasNoNewDefault() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://x.com/root/status/3")
        XCTAssertNil(draft.quoteAuthorLink)
        XCTAssertNil(draft.compositionPolicy["quoteAuthorLink"])
        XCTAssertNil(draft.threadExpansion, "The native thread default is unchanged")
        draft.quoteAuthorLink = .source
        draft.titleOverride = "My title"; draft.descriptionOverride = "My edited writing"
        let frozen = try CaptureSubmissionSnapshot(draft: draft)
        draft.quoteAuthorLink = .plain
        XCTAssertEqual(frozen.policy["quoteAuthorLink"]?.string, "source")
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(restored.quoteAuthorLink, .plain)
        XCTAssertEqual(restored.compositionPolicy["quoteAuthorLink"]?.string, "plain")
        XCTAssertEqual(restored.titleOverride, "My title")
        XCTAssertEqual(restored.descriptionOverride, "My edited writing")
        var old = try JSONSerialization.jsonObject(with: JSONEncoder().encode(restored)) as! [String: Any]
        old.removeValue(forKey: "quoteAuthorLink")
        let legacy = try JSONDecoder().decode(CaptureDraft.self, from: JSONSerialization.data(withJSONObject: old))
        XCTAssertNil(legacy.quoteAuthorLink)
        XCTAssertNil(legacy.compositionPolicy["quoteAuthorLink"])
    }

    @MainActor func testNativeRuntimeMatchesAllFrozenLegacyPlansWithoutRewritingTheirHashes() throws {
        let runtime = try CaptureRuntime()
        for item in try fixtures() {
            let plan = try XCTUnwrap(item["plan"])
            XCTAssertEqual(try composed(runtime, plan, style: nil), plan, item["provider"]?.string ?? "")
        }
    }

    @MainActor func testBothPresentationsRenderIdenticalWritingWithPostTargetsAcrossPlatforms() throws {
        let runtime = try CaptureRuntime()
        for item in try fixtures() {
            let plan = try XCTUnwrap(item["plan"]), quote = try XCTUnwrap(plan["sources"]?.array.first?["quote"])
            let prior = try XCTUnwrap(quote["quote"])
            let linked = try composed(runtime, plan, style: .source), plain = try composed(runtime, plan, style: .plain)
            XCTAssertEqual(linked["sources"], plan["sources"])
            XCTAssertEqual(plain["sources"], plan["sources"])
            XCTAssertEqual(linked["block"]?["canonicalSource"], plan["block"]?["canonicalSource"])
            let linkedMarkdown = try XCTUnwrap(linked["block"]?["markdown"]?.string)
            let plainMarkdown = try XCTUnwrap(plain["block"]?["markdown"]?.string)
            let linkedPreview = CaptureMarkdownPreview.render(linkedMarkdown), plainPreview = CaptureMarkdownPreview.render(plainMarkdown)
            XCTAssertEqual(String(linkedPreview.characters), String(plainPreview.characters))
            XCTAssertTrue(String(linkedPreview.characters).contains("Complete quoted prose."))
            XCTAssertTrue(String(linkedPreview.characters).contains("Earlier quoted prose."))
            XCTAssertTrue(String(linkedPreview.characters).contains("Authored root prose."))
            XCTAssertEqual(linkedPreview.runs.compactMap(\.link), [
                URL(string: try XCTUnwrap(prior["canonicalUrl"]?.string))!,
                URL(string: try XCTUnwrap(quote["canonicalUrl"]?.string))!
            ])
            XCTAssertEqual(plainPreview.runs.compactMap(\.link), [])
            XCTAssertEqual(linked["block"]?["selectedMedia"], plain["block"]?["selectedMedia"])
            XCTAssertNotEqual(linked["hash"], plain["hash"])
        }
    }

    @MainActor func testReopenedRetainedSourceCanChangePresentationWithoutSourceReadsOrSavedRecordMutation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let plan = try XCTUnwrap(fixtures().first?["plan"])
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: plan["block"]!["canonicalSource"]!.string!)
        draft.previewSnapshot = CapturePreview(kind: "social", url: draft.input, plan: plan)
        draft.quoteAuthorLink = .source
        draft.titleOverride = "Kept title"; draft.descriptionOverride = "Kept edited description"
        try store.save(draft, account: 1, kind: "draft", id: draft.id.uuidString)
        let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        var loaded = try XCTUnwrap(reopened.value(CaptureDraft.self, account: 1, kind: "draft", id: draft.id.uuidString))
        let retainedBefore = try JSONEncoder().encode(loaded)
        let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: root)
        let source = try await preparation.read(CaptureSubmissionSnapshot(draft: loaded))
        XCTAssertEqual(source.preview.plan?["policy"]?["quoteAuthorLink"]?.string, "source")
        loaded.quoteAuthorLink = .plain
        let plain = try await preparation.read(CaptureSubmissionSnapshot(draft: loaded))
        XCTAssertEqual(plain.preview.plan?["policy"]?["quoteAuthorLink"]?.string, "plain")
        XCTAssertEqual(plain.preview.plan?["sources"], plan["sources"])
        XCTAssertEqual(plain.preview.plan?["block"]?["title"]?.string, "Kept title")
        XCTAssertEqual(plain.preview.plan?["block"]?["description"]?.string, "Kept edited description")
        let unchanged = try XCTUnwrap(reopened.value(CaptureDraft.self, account: 1, kind: "draft", id: draft.id.uuidString))
        // Recomposition itself never writes back into existing saved or queued records.
        XCTAssertEqual(unchanged.quoteAuthorLink, .source)
        XCTAssertEqual(try JSONDecoder().decode(CaptureDraft.self, from: retainedBefore).previewSnapshot?.plan, unchanged.previewSnapshot?.plan)
    }
}
