import CaptureCore
import CaptureRuntime
import Foundation
import XCTest

final class ResolvedSourceCacheTests: XCTestCase {
    @MainActor func testColdWarmAndStyleToggleComposeWithoutReadingAgain() async throws {
        let cache = ResolvedSourceCache()
        let runtime = try CaptureRuntime()
        let posts = #"[{"provider":"instagram","id":"fixture","canonicalUrl":"https://www.instagram.com/p/fixture/","author":{"handle":"fixture"},"text":"Fixture caption","media":[{"ref":"0.0","kind":"image","url":"https://example.com/fixture.jpg","width":800,"height":600}]}]"#
        var reads = 0
        let clock = ContinuousClock()
        let started = clock.now
        let load: @MainActor () async throws -> String = {
            reads += 1
            try await Task.sleep(for: .milliseconds(80))
            return posts
        }
        let cold = try await cache.value(identity: "draft:instagram:fixture", load: load)
        let coldTime = started.duration(to: clock.now)
        let warmStarted = clock.now
        for style in ["none", "all", "auto", "none"] {
            let snapshot = try await cache.value(identity: "draft:instagram:fixture", load: load)
            XCTAssertEqual(snapshot, cold)
            let response = try runtime.compose(postsJSON: snapshot, policyJSON: "{\"media\":\"\(style)\"}")
            let json = try JSONSerialization.jsonObject(with: Data(response.utf8)) as! [String: Any]
            let plan = json["plan"] as! [String: Any]
            let block = plan["block"] as! [String: Any]
            XCTAssertEqual((block["selectedMedia"] as! [String]).count, style == "none" ? 0 : 1)
        }
        XCTAssertEqual(reads, 1)
        print("source-cache fixture cold=\(coldTime), four warm style toggles=\(warmStarted.duration(to: clock.now)), provider reads=\(reads)")
    }

    @MainActor func testExpiryFailureAndIdentityInvalidation() async throws {
        let cache = ResolvedSourceCache()
        let now = Date()
        var reads = 0
        let load: @MainActor () async throws -> String = { reads += 1; return "snapshot-\(reads)" }
        _ = try await cache.value(identity: "a", now: now, load: load)
        _ = try await cache.value(identity: "a", now: now.addingTimeInterval(301), load: load)
        _ = try await cache.value(identity: "b", now: now, load: load)
        cache.invalidate()
        do { _ = try await cache.value(identity: "b") { throw NSError(domain: "fixture", code: 1) }; XCTFail("failure expected") }
        catch { }
        _ = try await cache.value(identity: "b", load: load)
        XCTAssertEqual(reads, 4)
    }

    @MainActor func testVerifiedShortURLRekeyKeepsSnapshotForMediaChanges() async throws {
        let cache = ResolvedSourceCache()
        var reads = 0
        let original = try await cache.value(identity: "draft:short") { reads += 1; return "verified post and video" }
        cache.rekey(from: "draft:short", to: "draft:canonical")
        let toggled = try await cache.value(identity: "draft:canonical") { reads += 1; return "unexpected second fetch" }
        XCTAssertEqual(toggled, original)
        XCTAssertEqual(reads, 1)
    }

    @MainActor func testConcurrentStyleChangesShareReadAndLateSourceCannotOverwrite() async throws {
        let cache = ResolvedSourceCache()
        var reads = 0
        var continuation: CheckedContinuation<String, Never>?
        let first = Task { try await cache.value(identity: "old") {
            reads += 1
            return await withCheckedContinuation { continuation = $0 }
        } }
        while continuation == nil { await Task.yield() }
        var secondStarted = false
        let second = Task {
            secondStarted = true
            return try await cache.value(identity: "old") { reads += 1; return "unexpected" }
        }
        while !secondStarted { await Task.yield() }
        let fresh = try await cache.value(identity: "new") { "fresh" }
        continuation?.resume(returning: "late")
        for task in [first, second] {
            do { _ = try await task.value; XCTFail("stale source should be rejected") }
            catch is CancellationError { }
        }
        XCTAssertEqual(fresh, "fresh")
        let warm = try await cache.value(identity: "new") { "wrong" }
        XCTAssertEqual(warm, "fresh")
        XCTAssertEqual(reads, 1)
    }
}
