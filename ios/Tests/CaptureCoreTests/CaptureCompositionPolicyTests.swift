import CaptureCore
import CaptureRuntime
import Foundation
import XCTest

final class CaptureCompositionPolicyTests: XCTestCase {
    private let posts = #"[{"provider":"x","id":"one","canonicalUrl":"https://x.com/example/status/1","author":{"handle":"example"},"text":"First source","media":[{"ref":"1.1","kind":"image","url":"https://example.com/one.jpg","width":800,"height":600},{"ref":"1.2","kind":"image","url":"https://example.com/two.jpg","width":800,"height":600}]},{"provider":"x","id":"two","canonicalUrl":"https://x.com/example/status/2","author":{"handle":"example"},"text":"Second source","media":[{"ref":"2.1","kind":"image","url":"https://example.com/three.jpg","width":800,"height":600}]}]"#

    @MainActor private func composed(_ runtime: CaptureRuntime, posts: String, policy: JSONValue = .object([:])) throws -> CapturePreview {
        let policyJSON = String(decoding: try JSONEncoder().encode(policy), as: UTF8.self)
        let result = try JSONDecoder().decode(JSONValue.self, from: Data(runtime.compose(postsJSON: posts, policyJSON: policyJSON).utf8))
        return .init(kind: "social", url: "https://x.com/example/status/1", plan: result["plan"])
    }

    @MainActor func testSpecificSelectionComposesOriginalReferencesInSourceOrder() throws {
        let runtime = try CaptureRuntime()
        let preview = try composed(runtime, posts: posts, policy: .object(["media": .string("all")]))
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: preview.url)
        draft.selectMedia(["2.1", "1.2", "2.1", "9.1"], in: preview)
        XCTAssertEqual(draft.selectedMedia, ["1.2", "2.1"])
        let snapshot = String(decoding: try JSONEncoder().encode(preview.plan!["sources"]!), as: UTF8.self)
        let selected = try composed(runtime, posts: snapshot, policy: draft.compositionPolicy)
        XCTAssertEqual(selected.selectedMedia, ["1.2", "2.1"])
        XCTAssertEqual(selected.plan?["sources"], preview.plan?["sources"])
        XCTAssertEqual(selected.mediaRefs, ["1.1", "1.2", "2.1"])
        draft.previewSnapshot = selected
        let recovered = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(recovered.selectedMedia, ["1.2", "2.1"])
        XCTAssertEqual(recovered.previewSnapshot?.selectedMedia, ["1.2", "2.1"])
    }

    @MainActor func testNoneIndividualAllAndAutomaticUseActualComposedSelection() throws {
        let runtime = try CaptureRuntime()
        let automatic = try composed(runtime, posts: posts)
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil)
        XCTAssertEqual(draft.includedMedia(in: automatic), automatic.selectedMedia)
        draft.media = .none
        draft.toggleMedia("2.1", in: automatic)
        XCTAssertEqual(draft.selectedMedia, ["2.1"])
        draft.toggleMedia("1.1", in: automatic)
        XCTAssertEqual(draft.selectedMedia, ["1.1", "2.1"])
        draft.toggleMedia("2.1", in: automatic)
        draft.toggleMedia("unknown", in: automatic)
        XCTAssertEqual(draft.selectedMedia, ["1.1"])
        draft.media = .all
        XCTAssertEqual(draft.includedMedia(in: automatic), ["1.1", "1.2", "2.1"])
        draft.selectMedia([], in: automatic)
        let empty = try composed(runtime, posts: posts, policy: draft.compositionPolicy)
        XCTAssertEqual(empty.selectedMedia, [])
        XCTAssertEqual(empty.plan?["block"]?["kind"]?.string, "text")
    }

    func testOldDraftDecodesWithoutSelectionOrDepthAndDepthPersistsAsSharedPolicy() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil)
        draft.quoteDepth = .full
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
        XCTAssertEqual(json["quoteDepth"] as? String, "full")
        XCTAssertEqual(draft.compositionPolicy["quoteDepth"]?.string, "full")
        json.removeValue(forKey: "quoteDepth"); json.removeValue(forKey: "selectedMedia")
        let old = try JSONDecoder().decode(CaptureDraft.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(old.selectedMedia); XCTAssertNil(old.quoteDepth)
        XCTAssertNil(old.compositionPolicy["quoteDepth"])
        draft.quoteDepth = .levels(2)
        XCTAssertEqual(draft.compositionPolicy["quoteDepth"]?.int, 2)
        XCTAssertThrowsError(try JSONDecoder().decode(CaptureQuoteDepth.self, from: Data("9".utf8)))
    }

    func testOptInXThreadModePersistsIntoDurableCompositionPolicy() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://x.com/example/status/1")
        draft.threadExpansion = .on
        XCTAssertEqual(draft.compositionPolicy["threadExpansion"]?.string, "on")
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(restored.threadExpansion, .on)
        XCTAssertEqual(restored.compositionPolicy["threadExpansion"]?.string, "on")
    }

    func testFrameChoiceAndThresholdPersistWithTheFrozenMediaPolicy() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: "https://x.com/example/status/1")
        draft.media = .selected; draft.selectedMedia = ["1.1"]
        draft.videoFrames = ["1.1"]; draft.videoFrameThresholdSeconds = 300
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(restored.compositionPolicy["videoFrames"]?.array.compactMap(\.string), ["1.1"])
        XCTAssertEqual(restored.compositionPolicy["videoFrameThresholdSeconds"]?.int, 300)
        XCTAssertEqual(restored.compositionPolicy["selectedMedia"]?.array.compactMap(\.string), ["1.1"])
    }

    func testDepthControlRequiresActualQuotedEdgeAndUsesAvailableCoverage() {
        let plain = CapturePreview(kind: "social", url: "https://x.com/example/status/1", plan: .object(["sources": .array([.object(["quote": .null])])]))
        XCTAssertFalse(plain.hasQuotes)
        let unavailable = CapturePreview(kind: "social", url: plain.url, plan: .object(["sources": .array([.object(["quoteCoverage": .object(["actualDepth": .number(0), "stopped": .string("unavailable")])])])]))
        XCTAssertFalse(unavailable.hasQuotes); XCTAssertEqual(unavailable.availableQuoteDepth, 0)
        let expandable = CapturePreview(kind: "social", url: plain.url, plan: .object(["sources": .array([.object(["quoteCoverage": .object(["actualDepth": .number(0), "mayExpand": .bool(true)])])])]))
        XCTAssertTrue(expandable.hasQuotes)
        let nested = CapturePreview(kind: "social", url: plain.url, plan: .object(["sources": .array([.object(["quote": .object(["id": .string("a"), "quote": .object(["id": .string("b")])])])])]))
        XCTAssertTrue(nested.hasQuotes); XCTAssertEqual(nested.availableQuoteDepth, 2)
        let identified = CapturePreview(kind: "social", url: "https://delve.town/profile/example.town/post/a", plan: .object(["sources": .array([.object(["embeddedRecord": .object(["uri": .string("at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/town.delve.feed.post/b"), "status": .string("not-found")])])])]))
        XCTAssertTrue(identified.hasQuotes, "A retained embedded identity can be omitted with the native quote control")
        XCTAssertEqual(identified.availableQuoteDepth, 0, "Unavailable content must not claim an acquired quoted post")
    }
}
