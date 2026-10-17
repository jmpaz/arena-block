import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime
@testable import CaptureUI

final class QuotedAVMediaTests: XCTestCase {
    private var sources: JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(#"""
        [{"provider":"x","id":"100","canonicalUrl":"https://x.com/outer/status/100","author":{"handle":"outer"},"text":"Outer writing","media":[{"ref":"1.1","kind":"image","url":"https://image.example/outer.png","width":640,"height":480,"alt":""}],"quote":{"provider":"x","id":"200","canonicalUrl":"https://x.com/inner/status/200","author":{"handle":"inner"},"text":"Quoted writing","media":[{"ref":"1.2","kind":"video","url":"https://video.example/inner.mp4","posterUrl":"https://image.example/inner.png","durationSeconds":5,"width":640,"height":480,"alt":""}]}}]
        """#.utf8))
    }

    @MainActor private func plan(_ policy: JSONValue) throws -> JSONValue {
        let output = try CaptureRuntime().compose(postsJSON: String(decoding: JSONEncoder().encode(sources), as: UTF8.self), policyJSON: String(decoding: JSONEncoder().encode(policy), as: UTF8.self))
        return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(output.utf8))["plan"])
    }

    @MainActor func testQuotedVideoHasItsOwnerAndFrameChoiceInTheSharedRecipe() throws {
        let value = try plan(.object(["videoFrames":.array([.string("1.2")])]))
        let preview = CapturePreview(kind:"social",url:"https://x.com/outer/status/100",plan:value)
        XCTAssertEqual(preview.mediaRefs,["1.1","1.2"])
        XCTAssertEqual(preview.selectedMedia,["1.1","1.2"])
        XCTAssertEqual(value["block"]?["kind"]?.string,"link")
        XCTAssertEqual(CaptureMediaTree.sources(inPlan:value).last?.ownershipLabel,"Quoted from @inner")
        let recipe = try CaptureRuntime().renderRecipe(planJSON:String(decoding:JSONEncoder().encode(value),as:UTF8.self))
        let decoded = try JSONDecoder().decode(JSONValue.self,from:Data(recipe.utf8))
        XCTAssertEqual(decoded["tiles"]?.array.compactMap{$0["kind"]?.string},["image","image"])
    }

    @MainActor func testPreparationRetainsHiddenQuoteChoicesWithoutTryingToRenderThem() throws {
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:"https://x.com/outer/status/100")
        draft.media = .selected; draft.selectedMedia = ["1.1","1.2"]
        draft.videoFrames = ["1.2"]; draft.quoteDepth = .levels(0)
        let prepared = try CapturePreparation(runtime:CaptureRuntime(),container:.init(fileURLWithPath:"/tmp"))
            .compose(.init(draft:draft),sources:sources)
        XCTAssertEqual(prepared.preview.selectedMedia,["1.1"])
        XCTAssertEqual(prepared.preview.plan?["policy"]?["selectedMedia"]?.array.compactMap(\.string),["1.1","1.2"])
        XCTAssertEqual(prepared.preview.plan?["policy"]?["videoFrames"]?.array.compactMap(\.string),["1.2"])
        XCTAssertNil(prepared.preview.plan?["block"]?["frameMedia"])
    }

    @MainActor func testQuotedVideoSoundtrackUsesItsOwnRefAndRestoresAfterDepthChanges() throws {
        let value = try plan(.object(["audio":.string("1.2")]))
        XCTAssertEqual(value["block"]?["kind"]?.string,"video")
        let probe = #"{"1.2":{"width":640,"height":480,"duration":5,"fps":30,"audio":true}}"#
        let recipe = try CaptureRuntime().renderRecipe(planJSON:String(decoding:JSONEncoder().encode(value),as:UTF8.self),probesJSON:probe)
        let decoded = try JSONDecoder().decode(JSONValue.self,from:Data(recipe.utf8))
        XCTAssertEqual(decoded["audio"]?.array.compactMap(\.string),["1.2"])
        XCTAssertTrue((value["block"]?["markdown"]?.string ?? "").contains("@inner"))
    }
}

extension QuotedAVMediaTests {
    private func fixture(_ name: String) throws -> JSONValue {
        let url = URL(fileURLWithPath:#filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/\(name).json").standardizedFileURL
        return try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:url))
    }

    @MainActor func testActualQuotedVideosKeepSeparateAuthorsAndNativeFrameOwnership() throws {
        for name in ["substack-quoted-video-public-plan","substack-quoted-mixed-public-plan"] {
            let frozen = try fixture(name), runtime = try CaptureRuntime()
            let input = try XCTUnwrap(frozen["sources"])
            let encoded = String(decoding:try JSONEncoder().encode(input),as:UTF8.self)
            let output = try runtime.compose(postsJSON:encoded,policyJSON:#"{"media":"all","videoFrameThresholdSeconds":60,"threadExpansion":"off"}"#)
            let plan = try XCTUnwrap(JSONDecoder().decode(JSONValue.self,from:Data(output.utf8))["plan"])
            XCTAssertEqual(plan["block"]?["kind"]?.string,"link")
            let owners = CaptureMediaTree.sources(inPlan:plan)
            XCTAssertEqual(owners.last?.ownershipLabel,"Quoted from @substack")
            XCTAssertNotEqual(owners.first?.source["author"]?["handle"],owners.last?.source["author"]?["handle"])
            XCTAssertEqual(owners.last?.media.first?["sourceRole"]?.string,"original")
            XCTAssertEqual(plan["block"]?["frameMedia"]?.array.first?["ref"],owners.last?.media.first?["ref"])
            let payload = try runtime.localPayload(planJSON:String(decoding:try JSONEncoder().encode(plan),as:UTF8.self),mediaURL:"https://media.fixture.invalid/frame.jpg",ingestURL:plan["block"]?["canonicalSource"]?.string ?? "")
            let data = try JSONDecoder().decode(JSONValue.self,from:Data(payload.utf8))
            XCTAssertEqual(data["original_source_url"],plan["block"]?["canonicalSource"])
        }
    }

    @MainActor func testQuotedOriginalAudioIsSelectableInNativePreparation() throws {
        let frozen = try fixture("quoted-av-legacy-plans").array[1]
        var input = try XCTUnwrap(frozen["sources"]).array
        var root = input[0].object, quote = try XCTUnwrap(root["quote"]).object
        var media = try XCTUnwrap(quote["media"]).array
        var asset = media[0].object; asset["ref"] = .string("1.1"); media[0] = .object(asset)
        quote["media"] = .array(media); root["quote"] = .object(quote); input[0] = .object(root)
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:"https://x.com/outer/status/200")
        draft.media = .selected; draft.selectedMedia = ["1.1"]
        let prepared = try CapturePreparation(runtime:CaptureRuntime(),container:.init(fileURLWithPath:"/tmp"))
            .compose(.init(draft:draft),sources:.array(input))
        XCTAssertEqual(prepared.preview.plan?["block"]?["kind"]?.string,"audio")
        XCTAssertEqual(prepared.preview.selectedMedia,["1.1"])
        XCTAssertEqual(prepared.preview.media.first?["kind"]?.string,"audio")
        XCTAssertEqual(CaptureMediaTree.sources(inPlan:prepared.preview.plan!).last?.source["canonicalUrl"],quote["canonicalUrl"])
    }
}

extension QuotedAVMediaTests {
    @MainActor func testSoundtrackChoiceFollowsItsOwningQuoteWhenSourcesMove() throws {
        let original = try plan(.object([:]))
        let preview = CapturePreview(kind:"social",url:"https://x.com/outer/status/100",plan:original)
        let anchored = try CaptureMediaChoiceAnchors.capture(preview:preview,selected:nil,frames:nil,audio:"1.2")
        var movedRoot = sources.array[0].object
        var rootMedia = movedRoot["media"]!.array[0].object; rootMedia["ref"] = .string("2.1")
        movedRoot["media"] = .array([.object(rootMedia)])
        var child = movedRoot["quote"]!.object, childMedia = movedRoot["quote"]!["media"]!.array[0].object
        childMedia["ref"] = .string("2.2"); child["media"] = .array([.object(childMedia)]); movedRoot["quote"] = .object(child)
        let other: JSONValue = .object(["provider":.string("x"),"id":.string("999"),"canonicalUrl":.string("https://x.com/other/status/999"),"media":.array([])])
        let remapped = try anchored.applying(to:.object(["audio":.string("1.2")]),sources:.array([other,.object(movedRoot)]))
        XCTAssertEqual(remapped["audio"],.string("2.2"))
        let legacy = try JSONDecoder().decode(CaptureMediaChoiceAnchors.self,from:Data(#"{"selected":null,"frames":null}"#.utf8))
        XCTAssertNil(legacy.soundtrack)
    }

    @MainActor func testHiddenExplicitSoundtrackSurvivesRootMediaEditsAndDraftRoundTrip() throws {
        let hidden = try plan(.object(["quoteDepth":.number(0),"audio":.string("1.2")]))
        let preview = CapturePreview(kind:"social",url:"https://x.com/outer/status/100",plan:hidden)
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:"https://x.com/outer/status/100")
        draft.audio = "1.2"; draft.toggleMedia("1.1",in:preview)
        XCTAssertEqual(draft.selectedMedia,["1.2"]); XCTAssertEqual(draft.audio,"1.2")
        let restored = try JSONDecoder().decode(CaptureDraft.self,from:JSONEncoder().encode(draft))
        XCTAssertEqual(restored.audio,"1.2"); XCTAssertEqual(restored.compositionPolicy["audio"],.string("1.2"))
        let sources = CaptureMediaTree.videoSoundtrackSources(in:try plan(.object([:])))
        XCTAssertEqual(sources.flatMap(\.media).compactMap { $0["ref"]?.string },["1.2"])
        XCTAssertEqual(sources.first?.ownershipLabel,"Quoted from @inner")
    }
}

extension QuotedAVMediaTests {
    @MainActor func testChoosingOriginalAudioReplacesVisualMediaAndTheReverseIsExplicit() throws {
        var input = try XCTUnwrap(fixture("quoted-av-legacy-plans").array[1]["sources"]).array
        var root = input[0].object, quote = root["quote"]!.object, audio = quote["media"]!.array[0].object
        audio["ref"] = .string("1.2"); quote["media"] = .array([.object(audio)]); root["quote"] = .object(quote)
        root["media"] = sources.array[0]["media"]; input[0] = .object(root)
        let runtime = try CaptureRuntime()
        let output = try runtime.compose(postsJSON:String(decoding:JSONEncoder().encode(JSONValue.array(input)),as:UTF8.self),policyJSON:"{}")
        let plan = try XCTUnwrap(JSONDecoder().decode(JSONValue.self,from:Data(output.utf8))["plan"])
        let preview = CapturePreview(kind:"social",url:root["canonicalUrl"]!.string!,plan:plan)
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:preview.url)
        draft.toggleMedia("1.2",in:preview)
        XCTAssertEqual(draft.selectedMedia,["1.2"])
        let selected = try CapturePreparation(runtime:runtime,container:.init(fileURLWithPath:"/tmp"))
            .compose(.init(draft:draft),sources:.array(input))
        XCTAssertEqual(selected.preview.plan?["block"]?["kind"]?.string,"audio")
        draft.toggleMedia("1.1",in:selected.preview)
        XCTAssertEqual(draft.selectedMedia,["1.1"])
        XCTAssertEqual(draft.compositionPolicy["audio"],nil)
    }
}

extension QuotedAVMediaTests {
    @MainActor func testChangedSoundtrackCannotReuseAnEarlierRenderWithTheSameGeometry() throws {
        var input = sources.array, root = sources.array[0].object
        var moving = root["media"]!.array[0].object
        moving["kind"] = .string("video"); moving["url"] = .string("https://video.example/outer.mp4"); moving["durationSeconds"] = .number(5)
        root["media"] = .array([.object(moving)]); input[0] = .object(root)
        let runtime = try CaptureRuntime(), encoded = String(decoding:try JSONEncoder().encode(JSONValue.array(input)),as:UTF8.self)
        let output = try runtime.compose(postsJSON:encoded,policyJSON:#"{"audio":"1.1"}"#)
        let original = try XCTUnwrap(JSONDecoder().decode(JSONValue.self,from:Data(output.utf8))["plan"])
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:"https://x.com/outer/status/100")
        draft.audio = "1.1"; draft.phase = .ready; draft.renderPath = "/tmp/earlier-soundtrack.mp4"
        draft.previewSnapshot = CapturePreview(kind:"social",url:draft.input,plan:original)
        let preparation = CapturePreparation(runtime:runtime,container:.init(fileURLWithPath:"/tmp"))
        XCTAssertEqual(try preparation.compose(.init(draft:draft),sources:.array(input)).reusableRenderPath,draft.renderPath)
        draft.audio = "1.2"
        XCTAssertNil(try preparation.compose(.init(draft:draft),sources:.array(input)).reusableRenderPath)
    }
}
