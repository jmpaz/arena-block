import CaptureCore
import CaptureRuntime
import Foundation
import XCTest

final class QuotedImageMediaTests: XCTestCase {
    private func source(_ id: Int, prefix: Int, parent: Int = 300) -> JSONValue {
        .object(["provider":.string("x"),"id":.string(String(id)),"canonicalUrl":.string("https://x.com/root/status/\(id)"),"author":.object(["handle":.string("root\(id)")]),"text":.string("Root writing \(id)"),
            "media":.array([.object(["ref":.string("\(prefix).1"),"kind":.string("image"),"url":.string("https://images.example/root\(id).png"),"alt":.string("Root"),"sourceRole":.string("original")])]),
            "quote":.object(["provider":.string("x"),"id":.string(String(parent)),"canonicalUrl":.string("https://x.com/parent/status/\(parent)"),"author":.object(["handle":.string("parent")]),"text":.string("Parent writing"),
                "media":.array([.object(["ref":.string("\(prefix).2"),"kind":.string("image"),"url":.string("https://images.example/parent.png"),"alt":.string("Parent"),"sourceRole":.string("original")])])])])
    }
    @MainActor private func preview(_ sources: JSONValue, depth: Int = 2, selected: [String]? = nil) throws -> CapturePreview {
        let runtime = try CaptureRuntime()
        var policy: [String:JSONValue] = ["quoteDepth":.number(Double(depth))]
        if let selected { policy["media"] = .string("selected"); policy["selectedMedia"] = .array(selected.map(JSONValue.string)) }
        let output = try runtime.compose(postsJSON:String(decoding:try JSONEncoder().encode(sources),as:UTF8.self), policyJSON:String(decoding:try JSONEncoder().encode(JSONValue.object(policy)),as:UTF8.self))
        let envelope = try JSONDecoder().decode(JSONValue.self,from:Data(output.utf8))
        return .init(kind:"social",url:"https://x.com/root/status/100",plan:envelope["plan"])
    }
    @MainActor func testQuotedImageOwnershipSelectionAndDepthMatchTheSharedRecipe() throws {
        let sources = JSONValue.array([source(100,prefix:1)])
        let visible = try preview(sources)
        XCTAssertEqual(visible.mediaRefs,["1.1","1.2"])
        XCTAssertEqual(visible.selectedMedia,["1.1"])
        let owners = CaptureMediaTree.sources(inPlan:try XCTUnwrap(visible.plan))
        XCTAssertEqual(owners.map(\.ownershipLabel),[nil,"Quoted from @parent"])
        XCTAssertEqual(owners.last?.source["canonicalUrl"]?.string,"https://x.com/parent/status/300")
        XCTAssertEqual(owners.last?.media.first?["sourceRole"]?.string,"original")
        let hidden = try preview(sources,depth:0,selected:["1.1","1.2"])
        XCTAssertEqual(hidden.mediaRefs,["1.1"]); XCTAssertEqual(hidden.selectedMedia,["1.1"])
        let restored = try preview(sources,depth:2,selected:["1.2"])
        XCTAssertEqual(restored.selectedMedia,["1.2"])
        let recipe = try CaptureRuntime().renderRecipe(planJSON:String(decoding:try JSONEncoder().encode(visible.plan!),as:UTF8.self))
        let parsed = try JSONDecoder().decode(JSONValue.self,from:Data(recipe.utf8))
        XCTAssertEqual(parsed["tiles"]?.array.compactMap{$0["ref"]?.string},["1.1"])
    }
    @MainActor func testFreshDraftOptsIntoQuotedMediaAndRetainsItsExplicitChoice() throws {
        let sources = JSONValue.array([source(100,prefix:1)])
        let automatic = try preview(sources)
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:"https://x.com/root/status/100")
        XCTAssertEqual(draft.includedMedia(in:automatic),["1.1"])
        draft.toggleMedia("1.2",in:automatic)
        let restored = try JSONDecoder().decode(CaptureDraft.self,from:JSONEncoder().encode(draft))
        XCTAssertEqual(restored.media,.selected)
        XCTAssertEqual(restored.selectedMedia,["1.1","1.2"])
        let included = try preview(sources,selected:restored.selectedMedia)
        XCTAssertEqual(restored.includedMedia(in:included),["1.1","1.2"])
    }
    @MainActor func testQuoteChoicesStayWithTheirRootWhenTheSameQuotedImageAppearsTwice() throws {
        let before = try preview(.array([source(100,prefix:1),source(200,prefix:2)]))
        let anchors = try CaptureMediaChoiceAnchors.capture(preview:before,selected:["1.2"],frames:nil)
        let after = JSONValue.array([source(200,prefix:1),source(100,prefix:2)])
        let remapped = try anchors.applying(to:.object(["media":.string("selected")]),sources:after)
        XCTAssertEqual(remapped["selectedMedia"]?.array.compactMap(\.string),["2.2"])
    }
    @MainActor func testEditingRootMediaWhileQuotesAreHiddenPreservesQuotedChoices() throws {
        let sources = JSONValue.array([source(100,prefix:1)])
        let hidden = try preview(sources,depth:0,selected:["1.1","1.2"])
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:"https://x.com/root/status/100")
        draft.media = .selected; draft.selectedMedia = ["1.1","1.2"]
        draft.toggleMedia("1.1",in:hidden)
        XCTAssertEqual(draft.selectedMedia,["1.2"])
        let restored = try preview(sources,depth:2,selected:draft.selectedMedia)
        XCTAssertEqual(draft.includedMedia(in:restored),["1.2"])
    }
    func testLegacyQuoteReferencesRemainOutsideTheNewSelectableMediaContract() {
        let legacy = #"{"sources":[{"media":[{"ref":"1.1","kind":"image"}],"quote":{"media":[{"ref":"quote.1","kind":"image"}]}}],"policy":{"quoteDepth":2}}"#
        let plan = try! JSONDecoder().decode(JSONValue.self,from:Data(legacy.utf8))
        XCTAssertEqual(CaptureMediaTree.media(in:plan).compactMap{$0["ref"]?.string},["1.1"])
    }
}
