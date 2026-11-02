import CaptureCore
import CaptureRuntime
import Foundation
import XCTest
@testable import CaptureUI
final class VideoRepresentationTests: XCTestCase {
    private func json(_ v: JSONValue) throws -> String { String(decoding: try JSONEncoder().encode(v),as:UTF8.self) }
    private func source(_ duration: Double) -> JSONValue {
        .array([.object(["provider":.string("tiktok"),"id":.string("707"),"canonicalUrl":.string("https://www.tiktok.com/@author/video/707"),"author":.object(["handle":.string("author")]),"text":.string("Original video"),"media":.array([.object(["ref":.string("1.1"),"kind":.string("video"),"url":.string("https://media.example/video.mp4"),"posterUrl":.string("https://media.example/frame.jpg"),"durationSeconds":.number(duration),"width":.number(720),"height":.number(1280),"alt":.string("")])])])])
    }
    @MainActor private func plan(_ runtime: CaptureRuntime,_ sources: JSONValue,_ policy: JSONValue = .object([:])) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self,from:Data(runtime.compose(postsJSON:json(sources),policyJSON:json(policy)).utf8))["plan"]!
    }
    @MainActor func testDefaultBoundaryAndMovingChoiceSurviveDraftAndFrozenSubmission() throws {
        let runtime=try CaptureRuntime()
        XCTAssertEqual(CaptureVideoDefaults.frameThresholdSeconds,1500)
        for duration in [707.0,1500.0] { XCTAssertEqual(try plan(runtime,source(duration))["block"]?["kind"]?.string,"video") }
        let automatic=try plan(runtime,source(1501))
        XCTAssertEqual(automatic["block"]?["kind"]?.string,"link")
        var draft=CaptureDraft(accountID:1,defaultChannel:nil,input:"https://www.tiktok.com/@author/video/707")
        draft.videoFrameThresholdSeconds=1500;draft.videoMotion=["1.1"]
        draft.previewSnapshot=CapturePreview(kind:"social",url:draft.input,plan:automatic)
        let frozen=try CaptureSubmissionSnapshot(draft:draft)
        XCTAssertEqual(frozen.policy["videoMotion"]?.array.compactMap(\.string),["1.1"])
        let restored=try JSONDecoder().decode(CaptureDraft.self,from:JSONEncoder().encode(draft))
        XCTAssertEqual(restored.videoMotion,["1.1"])
        let moving=try plan(runtime,source(1501),restored.compositionPolicy)
        XCTAssertEqual(moving["block"]?["kind"]?.string,"video")
        draft.videoMotion=[];draft.videoFrames=["1.1"]
        XCTAssertEqual(try plan(runtime,source(707),draft.compositionPolicy)["block"]?["kind"]?.string,"link")
        draft.videoMotion=["1.1"];draft.videoFrames=[]
        XCTAssertEqual(try plan(runtime,source(1501),draft.compositionPolicy)["block"]?["kind"]?.string,"video")
        XCTAssertEqual(frozen.policy["videoMotion"]?.array.compactMap(\.string),["1.1"])
        let anchors=try CaptureMediaChoiceAnchors.capture(preview:restored.previewSnapshot!,selected:["1.1"],frames:nil,motion:["1.1"])
        XCTAssertEqual(try anchors.applying(to:restored.compositionPolicy,sources:source(1501))["videoMotion"]?.array.compactMap(\.string),["1.1"])
    }
}
