import Foundation
import CryptoKit
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime
@testable import CaptureUI

final class SubstackPodcastNoteTests: XCTestCase {
    private let source = "https://substack.com/@evadmartain/note/c-311363713"
    private func fixture(_ name: String) throws -> JSONValue {
        let file = URL(fileURLWithPath:#filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/\(name).json").standardizedFileURL
        return try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:file))
    }
    private func json(_ value: JSONValue) throws -> String { String(decoding:try JSONEncoder().encode(value),as:UTF8.self) }

    @MainActor func testActualPodcastNoteKeepsNoteProseAndArticleAudioSeparateThroughNativePreparationAndDraftReplay() throws {
        let plan = try fixture("substack-podcast-note-public-plan"), runtime = try CaptureRuntime()
        var draft = CaptureDraft(accountID:1,defaultChannel:nil,input:source)
        draft.media = .selected; draft.selectedMedia = ["1.1"]
        let result = try CapturePreparation(runtime:runtime,container:.init(fileURLWithPath:"/tmp"))
            .compose(.init(draft:draft),sources:try XCTUnwrap(plan["sources"]))
        XCTAssertEqual(result.preview.plan?["block"]?["kind"]?.string,"audio")
        XCTAssertEqual(result.preview.selectedMedia,["1.1"])
        XCTAssertEqual(result.preview.plan?["block"]?["title"]?.string,"Note by @evadmartain")
        XCTAssertEqual(result.preview.media.first?["sourceAttribution"]?["authors"]?.array.compactMap(\.string),["Hamish McKenzie"])
        XCTAssertEqual(result.preview.media.first?["sourceAttribution"]?["url"]?.string,"https://on.substack.com/p/transcription")
        XCTAssertTrue((result.preview.plan?["block"]?["markdown"]?.string ?? "").contains("AUDIO GRAM"))
        XCTAssertTrue((result.preview.plan?["block"]?["markdown"]?.string ?? "").contains("Audio from [Introducing new audio transcription tools"))
        XCTAssertEqual(result.prepared.payload["original_source_url"]?.string,source)
        draft.previewSnapshot = result.preview
        let restored = try JSONDecoder().decode(CaptureDraft.self,from:JSONEncoder().encode(draft))
        XCTAssertEqual(restored.previewSnapshot?.plan,result.preview.plan)
        let edited = try runtime.edit(planJSON:json(result.preview.plan!),editsJSON:#"{"title":"My title"}"#)
        let output = try JSONDecoder().decode(JSONValue.self,from:Data(edited.utf8))
        XCTAssertEqual(output["plan"]?["sources"],result.preview.plan?["sources"])
    }

    @MainActor func testNativeLegacyCardOnlyPlanRemainsExactAndStrippedPodcastEvidenceIsRejected() throws {
        let runtime = try CaptureRuntime(), old = try fixture("substack-podcast-note-legacy-plan")
        let composed = try runtime.compose(postsJSON:json(try XCTUnwrap(old["sources"])),policyJSON:json(try XCTUnwrap(old["policy"])))
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self,from:Data(composed.utf8))["plan"],old)
        var current = try fixture("substack-podcast-note-public-plan").object
        var sources = try XCTUnwrap(current["sources"]).array, root = sources[0].object
        root["media"] = .array([]); sources[0] = .object(root); current["sources"] = .array(sources)
        XCTAssertThrowsError(try runtime.compose(postsJSON:json(.array(sources)),policyJSON:#"{"media":"audio"}"#))
    }

    @MainActor func testLiveActualPodcastNoteStagesOriginalAudioWithoutSaveOrConversion() async throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SUBSTACK_PODCAST_AUDIO"] == "1" else {
            throw XCTSkip("Opt-in actual public Note acquisition and original audio staging; no save.")
        }
        let runtime = try CaptureRuntime()
        let resolved = try await runtime.resolve(refs:[source],policyJSON:#"{"media":"audio"}"#)
        let plan = try XCTUnwrap(JSONDecoder().decode(JSONValue.self,from:Data(resolved.utf8))["plan"])
        XCTAssertEqual(plan["block"]?["kind"]?.string,"audio")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:dir) }
        let output = try await CapturePreparation(runtime:runtime,container:dir).render(plan:plan,draftID:UUID())
        let file = try XCTUnwrap(output?.fileURL)
        let data = try Data(contentsOf:file)
        XCTAssertEqual(data.count,2_897_676)
        XCTAssertEqual(SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined(),"b2e7e828ba6d5bf78d5fd535d3559f383c12d069142480fe401906062b4ae039")
        XCTAssertEqual(file.pathExtension,"mp3")
        XCTAssertEqual(plan["sources"]?.array.first?["author"]?["handle"]?.string,"evadmartain")
        XCTAssertEqual(plan["sources"]?.array.first?["media"]?.array.first?["sourceAttribution"]?["authors"]?.array.compactMap(\.string),["Hamish McKenzie"])
    }
}
