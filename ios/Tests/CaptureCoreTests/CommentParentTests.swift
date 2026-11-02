import CaptureCore
import CaptureRuntime
import Foundation
import XCTest
@testable import CaptureUI

final class CommentParentTests: XCTestCase {
    private func fixtures() throws -> [JSONValue] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/comment-parent-public-plans.json").standardizedFileURL
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)).array
    }
    private func json(_ value: JSONValue) throws -> String { String(decoding: try JSONEncoder().encode(value), as: UTF8.self) }

    func testParentOptionsPersistAndFreezeWithoutAddingDefaultsToLegacyDrafts() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://news.ycombinator.com/item?id=50341020")
        XCTAssertNil(draft.parentDepth); XCTAssertNil(draft.parentStyle)
        XCTAssertNil(draft.compositionPolicy["parentDepth"])
        draft.parentDepth = .levels(2); draft.parentStyle = .quote
        let frozen = try CaptureSubmissionSnapshot(draft: draft)
        draft.parentDepth = .levels(0); draft.parentStyle = .flat
        XCTAssertEqual(frozen.policy["parentDepth"]?.int, 2)
        XCTAssertEqual(frozen.policy["parentStyle"]?.string, "quote")
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(restored.parentDepth, .levels(0)); XCTAssertEqual(restored.parentStyle, .flat)
    }

    @MainActor func testPublicExamplesRecomposeInNativeRuntimeWithFlatSoftBreaksAndRealNestedQuoteBlocks() throws {
        let runtime = try CaptureRuntime()
        for fixture in try fixtures() {
            let plan = try XCTUnwrap(fixture["plan"]), source = try XCTUnwrap(plan["sources"]?.array.first)
            let preview = CapturePreview(kind: "social", url: plan["block"]!["canonicalSource"]!.string!, plan: plan)
            XCTAssertTrue(preview.hasParentContext); XCTAssertFalse(preview.hasQuotes)
            XCTAssertFalse(preview.needsParentContextAcquisition)
            for style in ["flat", "quote"] {
                let raw = try runtime.compose(postsJSON: json(plan["sources"]!), policyJSON: "{\"parentDepth\":\"full\",\"parentStyle\":\"\(style)\"}")
                let composed = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))["plan"]!
                XCTAssertEqual(composed["sources"], plan["sources"])
                XCTAssertEqual(composed["block"]?["canonicalSource"], plan["block"]?["canonicalSource"])
                let blocks = CaptureMarkdownPreview.blocks(composed["block"]!["markdown"]!.string!)
                if style == "flat" {
                    XCTAssertTrue(blocks.contains( where: { $0.isRule }))
                    let name = source["parentContext"]!["parents"]!.array.last!["author"]!["handle"]!.string!
                    XCTAssertTrue(String(blocks[0].text.characters).hasPrefix(name + "\n"))
                    XCTAssertEqual(blocks[0].quoteDepth, 0)
                    XCTAssertTrue(blocks[0].text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
                } else {
                    XCTAssertGreaterThan(blocks[0].quoteDepth, 0)
                    XCTAssertEqual(blocks.last?.quoteDepth, 0)
                }
            }
        }
    }

    @MainActor func testRetainedPreparationChangesContextWithoutNetworkAndPreservesEdits() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let runtime = try CaptureRuntime(), preparation = CapturePreparation(runtime: runtime, container: root)
        for fixture in try fixtures() {
            let plan = try XCTUnwrap(fixture["plan"])
            var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: plan["block"]!["canonicalSource"]!.string!)
            draft.previewSnapshot = CapturePreview(kind: "social", url: draft.input, plan: plan)
            draft.parentDepth = .levels(1); draft.parentStyle = .flat
            draft.titleOverride = "My title"; draft.descriptionOverride = "My edited description"
            let result = try await preparation.read(CaptureSubmissionSnapshot(draft: draft))
            XCTAssertEqual(result.preview.plan?["sources"], plan["sources"])
            XCTAssertEqual(result.preview.plan?["policy"]?["parentDepth"]?.int, 1)
            XCTAssertEqual(result.preview.plan?["block"]?["title"]?.string, "My title")
            XCTAssertEqual(result.preview.plan?["block"]?["description"]?.string, "My edited description")
            XCTAssertEqual(result.prepared.payload["original_source_url"]?.string, draft.input)
        }
    }
}
