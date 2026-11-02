import Foundation
import XCTest
@testable import CaptureCore

final class CaptureShareInputTests: XCTestCase {
    private let source = "https://www.tiktok.com/@kylemakesshortfilms/video/7696537875722013983"

    func testSubstackShareTrackingIsCleanedBeforeReadingTheSource() {
        let canonical = "https://substack.com/@norvidstudies/note/c-362104813"
        let tracked = canonical + "?r=1ir8aw&utm_medium=ios&utm_source=notes-share-#shared"
        for value: Any in [URL(string: tracked)!, tracked, Data(tracked.utf8), NSAttributedString(string: "Read " + tracked)] {
            XCTAssertEqual(CaptureShareInput.urls(in: value).map(\.absoluteString), [canonical])
        }
        XCTAssertEqual(CaptureInput.canonicalSourceText(" \(tracked) \nhttps://example.com/?q=kept"), canonical + "\nhttps://example.com/?q=kept")
        XCTAssertEqual(CaptureInput.pasteableSourceText("\(tracked)\n\(canonical)"), canonical)
        for value in ["https://www.lesswrong.com/posts/post/?commentId=comment#comment-comment",
                      "https://substack.com/p/article?r=kept", "https://substack.com/@person/note/c-0?r=kept",
                      "https://substack.com:443/@person/note/c-1?r=kept", "https://substack.com/%40person/note/c-1?r=kept",
                      "https://substack.com.example.org/@person/note/c-1?r=kept"] {
            XCTAssertEqual(CaptureInput.canonicalSourceURL(URL(string: value)!).absoluteString, value)
        }
    }

    func testBrowserOnlyPropertyListCarriesExactSharedPageWithoutURLAttachment() throws {
        let wrapped = ["NSExtensionJavaScriptPreprocessingResultsKey": ["sourceUrl": source]]
        for format in [PropertyListSerialization.PropertyListFormat.xml, .binary] {
            let data = try PropertyListSerialization.data(fromPropertyList: wrapped, format: format, options: 0)
            let decoded = try XCTUnwrap(CaptureShareInput.propertyList(data))
            let result = try XCTUnwrap(decoded["NSExtensionJavaScriptPreprocessingResultsKey"] as? [String: Any])
            XCTAssertEqual(CaptureShareInput.browserResult(result), .url(URL(string: source)!))
        }
    }

    func testNativeAndBrowserRepresentationsPreserveTheSameURL() {
        for value: Any in [URL(string: source)!, source, Data(source.utf8), NSAttributedString(string: "Watch " + source)] {
            XCTAssertEqual(CaptureShareInput.urls(in: value).map(\.absoluteString), [source])
        }
        XCTAssertEqual(CaptureShareInput.urls(in: "Watch \(source) \(source)").count, 1)
        XCTAssertEqual(CaptureShareInput.urls(in: "https://example.com/a https://example.com/b").count, 2)
    }

    func testUnsafeURLsAndUnrelatedPageFieldsAreNotCaptured() {
        for value in ["file:///private/data", "javascript:alert(1)", "ftp://bsky.app/profile/test/post/a", "custom://delve.town/profile/test/post/a", "https://user:password@example.com/a"] {
            XCTAssertEqual(CaptureShareInput.urls(in: URL(string: value)!), [])
            XCTAssertEqual(CaptureShareInput.urls(in: value), [])
        }
        XCTAssertEqual(CaptureShareInput.urls(in: URL(string: "at://example.test/app.bsky.feed.post/a")!).count, 1)
        XCTAssertNil(CaptureShareInput.browserResult(["title": source, "image": source]))
        XCTAssertNil(CaptureShareInput.browserResult(["sourceUrl": "javascript:alert(1)"]))
        XCTAssertEqual(CaptureShareInput.urls(in: Data(repeating: 32, count: CaptureShareInput.maximumBytes + 1)), [])
    }

    func testTypedRecordsAndFailuresPrecedeGenericURLAndReddit403StillHandsOff() {
        for key in ["redditError", "substackError"] {
            XCTAssertEqual(CaptureShareInput.browserResult([key: "Denied", "sourceUrl": source, "redditSourceUrl": "https://www.reddit.com/comments/test/"]), .failure("Denied"))
        }
        XCTAssertEqual(CaptureShareInput.browserResult(["substackCapture": "record", "sourceUrl": source]), .capture("record"))
        XCTAssertEqual(CaptureShareInput.browserResult(["redditCapture": "record", "sourceUrl": source]), .capture("record"))
        let reddit = "https://www.reddit.com/comments/test/"
        XCTAssertEqual(CaptureShareInput.browserResult(["redditSourceUrl": reddit]), .url(URL(string: reddit)!))
        XCTAssertEqual(CaptureShareInput.browserResult(["redditCapture": NSNull(), "sourceUrl": source]), .failure("Couldn’t read the shared page."))
    }

    @MainActor func testAdvertisedURLFailureAndNilFallBackToTextWithoutManualPaste() async throws {
        enum Failed: Error { case unavailable }
        var loaded: [String] = []
        let result = try await CaptureShareInput.sourceRepresentation(types: ["url", "plain", "utf8", "text"]) { type in
            loaded.append(type)
            if type == "url" { throw Failed.unavailable }
            if type == "plain" { return nil }
            return Data(self.source.utf8)
        }
        XCTAssertEqual(result, .links([URL(string: source)!]))
        XCTAssertEqual(loaded, ["url", "plain", "utf8"])
    }

    @MainActor func testCancelledProviderCannotFallBackOrPublishLateValue() async throws {
        let task = Task { @MainActor in
            try await CaptureShareInput.sourceRepresentation(types: ["url", "text"]) { _ in
                withUnsafeCurrentTask { $0?.cancel() }
                return self.source
            }
        }
        do { _ = try await task.value; XCTFail("A cancelled provider was accepted") }
        catch is CancellationError { }
    }

    @MainActor func testSharedThumbnailDoesNotMaskTheSameProvidersLink() async throws {
        let result = try await CaptureShareInput.sourceRepresentation(types: ["url", "text"]) { type in
            if type == "url" { return URL(fileURLWithPath: "/tmp/shared-thumbnail.jpg") }
            return self.source
        }
        XCTAssertEqual(result, .links([URL(string: source)!]))
        let thumbnailOnly = try await CaptureShareInput.sourceRepresentation(types: ["url"]) { _ in
            URL(fileURLWithPath: "/tmp/shared-movie.mp4")
        }
        XCTAssertNil(thumbnailOnly)
    }
}
