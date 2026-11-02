import CaptureCore
import CaptureRuntime
import Foundation
import XCTest

final class MosaicLayoutTests: XCTestCase {
    private func json(_ value: JSONValue) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }

    private var sources: JSONValue {
        .array([.object([
            "provider": .string("x"), "id": .string("1"),
            "canonicalUrl": .string("https://x.com/fixture/status/1"),
            "author": .object(["handle": .string("fixture")]), "text": .string("Original writing"),
            "media": .array([(946, 2048), (1105, 814), (1005, 909)].enumerated().map { index, size in
                .object(["ref": .string("1.\(index + 1)"), "kind": .string("image"),
                    "url": .string("https://media.example.test/\(index).jpg"), "alt": .string(""),
                    "width": .number(Double(size.0)), "height": .number(Double(size.1))])
            })
        ])])
    }

    func testLayoutChoicePersistsAndFreezesWithoutDefaultingOldDrafts() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://x.com/fixture/status/1")
        XCTAssertNil(draft.mosaicLayout)
        XCTAssertNil(draft.compositionPolicy["mosaicLayout"])
        draft.mosaicLayout = .sourceOrder
        let frozen = try CaptureSubmissionSnapshot(draft: draft)
        draft.mosaicLayout = .compact
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(restored.mosaicLayout, .compact)
        XCTAssertEqual(restored.compositionPolicy["mosaicLayout"]?.string, "compact")
        XCTAssertEqual(frozen.policy["mosaicLayout"]?.string, "source-order")
        var old = try JSONSerialization.jsonObject(with: JSONEncoder().encode(restored)) as! [String: Any]
        old.removeValue(forKey: "mosaicLayout")
        let legacy = try JSONDecoder().decode(CaptureDraft.self, from: JSONSerialization.data(withJSONObject: old))
        XCTAssertNil(legacy.mosaicLayout)
        XCTAssertNil(legacy.compositionPolicy["mosaicLayout"])
    }

    @MainActor func testNativeLayoutRevisionAndPosterGeometryUseSharedCoreWithoutChangingContent() throws {
        let runtime = try CaptureRuntime()
        let response = try runtime.compose(postsJSON: json(sources), policyJSON: "{\"media\":\"all\"}")
        let plan = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(response.utf8))["plan"])
        let raw = try runtime.mosaicLayout(planJSON: json(plan), mode: "source-order")
        let revised = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
        XCTAssertEqual(revised["sources"], plan["sources"])
        XCTAssertNotEqual(revised["block"]?["layout"], plan["block"]?["layout"])
        var a = revised["block"]!.object, b = plan["block"]!.object
        a.removeValue(forKey: "layout"); b.removeValue(forKey: "layout")
        XCTAssertEqual(a, b)
        XCTAssertEqual(revised["policy"]?["mosaicLayout"]?.string, "source-order")
        XCTAssertNotEqual(revised["hash"], plan["hash"])
        let preview = try JSONDecoder().decode(JSONValue.self, from: Data(runtime.layoutPreview(planJSON: raw).utf8))
        XCTAssertEqual(preview["tiles"]?.array.compactMap { $0["ref"]?.string }, ["1.1", "1.2", "1.3"])
        XCTAssertEqual(preview["width"]?.int, 4096)
        XCTAssertTrue((preview["height"]?.int ?? 0) > 0)
        XCTAssertThrowsError(try runtime.mosaicLayout(planJSON: raw, mode: "model"))
    }
}
