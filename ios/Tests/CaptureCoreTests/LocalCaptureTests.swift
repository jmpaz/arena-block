import CaptureRuntime
import Foundation
import XCTest
@testable import CaptureCore

final class LocalCaptureTests: XCTestCase {
    func testOrdinaryLinkCanBePreparedWithoutCredentials() throws {
        let url = try XCTUnwrap(URL(string: "https://example.com/article?source=reader#section"))
        let preview = CapturePreview.originalLink(url)
        let prepared = try XCTUnwrap(preview.localPreparation)
        XCTAssertEqual(prepared.payload["value"], .string(url.absoluteString))
        XCTAssertEqual(prepared.payload["original_source_url"], .string(url.absoluteString))
        XCTAssertTrue(prepared.update.isEmpty)
    }

    func testSupportedSocialSourcesUseTheSharedRuntimeClassifier() async throws {
        try await MainActor.run {
            let runtime = try CaptureRuntime()
            let sources = [
                "https://x.com/person/status/123", "https://www.fxtwitter.com/person/status/123",
                "https://bsky.app/profile/person/post/abc", "at://person.bsky.social/app.bsky.feed.post/xyz",
                "https://vm.tiktok.com/abc/", "https://www.instagram.com/reel/abc/",
                "https://old.reddit.com/r/test/comments/abc/title", "https://redd.it/abc",
                "https://news.ycombinator.com/item?id=1", "https://lobste.rs/c/abc",
                "https://social.example/@person/123", "https://social.example/users/person/statuses/123",
                "https://social.example/ap/users/person/statuses/123", "https://social.example/web/statuses/123"
            ]
            for source in sources {
                let parsed = try JSONDecoder().decode(JSONValue.self, from: Data(runtime.source(source).utf8))
                XCTAssertEqual(parsed["kind"]?.string, "social", source)
            }
            for source in ["https://x.com/person", "https://instagram.com/not-a-post", "https://news.ycombinator.com/"] {
                XCTAssertThrowsError(try runtime.source(source), source)
            }
        }
    }

    func testUnrelatedDomainsAndPathsRemainOrdinaryLinks() async throws {
        try await MainActor.run {
            let runtime = try CaptureRuntime()
            for source in ["https://x.com.example/article", "https://example.com/status/123", "https://example.com/@person/about"] {
                let parsed = try JSONDecoder().decode(JSONValue.self, from: Data(runtime.source(source).utf8))
                XCTAssertEqual(parsed["kind"]?.string, "url", source)
            }
        }
    }
}
