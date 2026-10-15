import CaptureRuntime
import Foundation
import XCTest

final class RuntimeTests: XCTestCase {
    func testPublicFacetSnapshotsComposeIdenticallyInJavaScriptCore() async throws {
        try await MainActor.run {
            let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .appendingPathComponent("../../../tests/fixtures/atproto-facet-plans.json").standardizedFileURL
            let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [[String: Any]])
            let runtime = try CaptureRuntime()
            for item in cases {
                let expected = try XCTUnwrap(item["plan"] as? [String: Any])
                let sources = try XCTUnwrap(expected["sources"] as? [[String: Any]])
                let policy = try XCTUnwrap(expected["policy"] as? [String: Any])
                let postsJSON = String(decoding: try JSONSerialization.data(withJSONObject: sources), as: UTF8.self)
                let policyJSON = String(decoding: try JSONSerialization.data(withJSONObject: policy), as: UTF8.self)
                let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(runtime.compose(postsJSON: postsJSON, policyJSON: policyJSON).utf8)) as? [String: Any])
                let plan = try XCTUnwrap(result["plan"] as? [String: Any])
                XCTAssertEqual(plan as NSDictionary, expected as NSDictionary, item["case"] as? String ?? "")
                XCTAssertEqual(plan["sources"] as? NSArray, sources as NSArray)
                let fields = try XCTUnwrap(result["fields"] as? [String: Any])
                let block = try XCTUnwrap(expected["block"] as? [String: Any])
                XCTAssertEqual(fields["content"] as? String, block["markdown"] as? String)
            }
        }
    }

    func testBundledCorePreservesCLIPlanHashAndUnicode() async throws {
        try await MainActor.run {
            let runtime = try CaptureRuntime()
            let posts = #"[{"provider":"x","id":"123","canonicalUrl":"https://x.com/person/status/123","author":{"handle":"person"},"text":"A paragraph.\n\n日本語 — café 👋","media":[]}]"#
            let result = try runtime.compose(postsJSON: posts)
            let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any])
            let plan = try XCTUnwrap(parsed["plan"] as? [String: Any])
            XCTAssertEqual(plan["hash"] as? String, "5a4589f3edb389e96f3943a703ca8cb29490719b41a562924ca7fe4b36fb5232")
            let fields = try XCTUnwrap(parsed["fields"] as? [String: Any])
            XCTAssertEqual(fields["content"] as? String, "A paragraph.\n\n日本語 — café 👋")
            XCTAssertEqual(try runtime.source("https://twitter.com/person/status/123?s=20"), #"{"kind":"social","url":"https://x.com/person/status/123"}"#)
            XCTAssertThrowsError(try runtime.source("https://user:pass@x.com/person/status/123"))
        }
    }

    func testBundledCoreRetainsExpandedThreadAndForumComment() async throws {
        try await MainActor.run {
            let runtime = try CaptureRuntime()
            var posts: [[String: Any]] = (1...21).map { index in
                ["provider": "x", "id": String(index), "canonicalUrl": "https://x.com/author/status/\(index)",
                 "author": ["handle": "author"], "text": "Part \(index)", "media": []]
            }
            posts.append(["provider": "forum_magnum", "id": "7C9iqsDCdxC2PfKDf",
                          "canonicalUrl": "https://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK/?commentId=7C9iqsDCdxC2PfKDf",
                          "author": ["handle": "smitop"], "text": "A public comment", "media": []])
            let encoded = String(decoding: try JSONSerialization.data(withJSONObject: posts), as: UTF8.self)
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(runtime.compose(postsJSON: encoded).utf8)) as? [String: Any])
            let plan = try XCTUnwrap(result["plan"] as? [String: Any])
            let retained = try XCTUnwrap(plan["sources"] as? [[String: Any]])
            XCTAssertEqual(retained.count, 22)
            XCTAssertEqual(retained.last?["provider"] as? String, "forum_magnum")
            XCTAssertEqual(retained.last?["id"] as? String, "7C9iqsDCdxC2PfKDf")
            XCTAssertEqual(try runtime.source("https://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK/loops-s-shortform#comment-7C9iqsDCdxC2PfKDf"),
                           #"{"kind":"social","url":"https://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK/?commentId=7C9iqsDCdxC2PfKDf"}"#)
        }
    }

    func testDelveProtocolMetadataSurvivesNativeEditAndPayload() async throws {
        try await MainActor.run {
            let runtime = try CaptureRuntime()
            let posts = #"[{"provider":"delve","id":"a","canonicalUrl":"https://delve.town/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/post/a","author":{"handle":"example.delve.town"},"text":"Read link","media":[],"atproto":{"uri":"at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/town.delve.feed.post/a","cid":"cid-a","authorDid":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa","record":{"$type":"town.delve.feed.post","text":"Read link","createdAt":"2026-10-11T00:00:00Z","retained":{"value":"café 👋"}}},"facets":[{"index":{"byteStart":5,"byteEnd":9},"features":[{"$type":"town.delve.richtext.facet#link","uri":"https://example.com/full"}]}],"external":{"url":"https://example.com/card","title":"Card","description":"Description"}}]"#
            let composed = try JSONSerialization.jsonObject(with: Data(runtime.compose(postsJSON: posts).utf8)) as! [String: Any]
            let plan = try XCTUnwrap(composed["plan"] as? [String: Any])
            let encoded = String(data: try JSONSerialization.data(withJSONObject: plan), encoding: .utf8)!
            let edited = try JSONSerialization.jsonObject(with: Data(runtime.edit(planJSON: encoded, editsJSON: #"{"title":"My title","markdown":"Kept body"}"#).utf8)) as! [String: Any]
            let updated = try XCTUnwrap(edited["plan"] as? [String: Any])
            XCTAssertEqual(plan["sources"] as? NSArray, updated["sources"] as? NSArray)
            let newJSON = String(data: try JSONSerialization.data(withJSONObject: updated), encoding: .utf8)!
            let payload = try JSONSerialization.jsonObject(with: Data(runtime.localPayload(planJSON: newJSON).utf8)) as! [String: Any]
            XCTAssertEqual(payload["title"] as? String, "My title")
            let hash = try XCTUnwrap(updated["hash"] as? String)
            XCTAssertEqual(payload["value"] as? String, "arena-block text \(hash)")
            XCTAssertEqual(payload["description"] as? String, "arena-block description \(hash)")
            let fields = try JSONSerialization.jsonObject(with: Data(runtime.fields(planJSON: newJSON).utf8)) as! [String: Any]
            XCTAssertEqual(fields["content"] as? String, "Kept body")
            XCTAssertEqual(fields["description"] as? String, "")
            XCTAssertEqual(payload["original_source_url"] as? String, "https://delve.town/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/post/a")
            XCTAssertEqual(try runtime.source("at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/town.delve.feed.post/a"), #"{"kind":"social","url":"https://delve.town/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/post/a"}"#)
        }
    }

    func testInstagramReelTitlesSurviveNativeRecompositionAndCanonicalAliases() async throws {
        try await MainActor.run {
            let runtime = try CaptureRuntime()
            for (route, retainedTitle, expected) in [("reel", nil, "Reel"), ("p", "Reel by @alice", "Reel"), ("p", nil, "Post")] as [(String, String?, String)] {
                var post: [String: Any] = ["provider": "instagram", "id": "Ab_c-123", "canonicalUrl": "https://www.instagram.com/\(route)/Ab_c-123/",
                    "author": ["handle": "alice"], "text": "Authored caption", "media": []]
                if let retainedTitle { post["postTitle"] = retainedTitle }
                let posts = String(decoding: try JSONSerialization.data(withJSONObject: [post]), as: UTF8.self)
                let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(runtime.compose(postsJSON: posts).utf8)) as? [String: Any])
                let fields = try XCTUnwrap(envelope["fields"] as? [String: Any])
                XCTAssertEqual(fields["title"] as? String, "\(expected) by @alice")
                XCTAssertEqual(fields["content"] as? String, "Authored caption")
            }
        }
    }

    func testCopiedCoverRequiresAnActualResourceURL() async throws {
        try await MainActor.run {
            let runtime = try CaptureRuntime()
            XCTAssertEqual(try runtime.copiedCover(blockJSON: #"{"image":{}}"#), "")
            XCTAssertEqual(try runtime.copiedCover(blockJSON: #"{"attachment":{"image":{"original":{"url":"https://images.are.na/cover.jpg"}}}}"#), "https://images.are.na/cover.jpg")
        }
    }
}
