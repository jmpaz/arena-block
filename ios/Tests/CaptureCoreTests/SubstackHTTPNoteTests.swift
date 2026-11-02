import CryptoKit
import Foundation
import JavaScriptCore
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime

@MainActor
private final class HTTPNoteTimers {
    private var timers: [Int: Timer] = [:]
    private var callbacks: [Int: JSValue] = [:]
    private var next = 0
    func schedule(_ callback: JSValue, delay: Double) -> Int {
        next += 1; let id = next
        callbacks[id] = callback
        timers[id] = Timer.scheduledTimer(withTimeInterval: max(0.001, delay / 1000), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.timers.removeValue(forKey: id)
                self?.callbacks.removeValue(forKey: id)?.call(withArguments: [])
            }
        }
        return id
    }
    func cancel(_ id: Int) { timers.removeValue(forKey: id)?.invalidate(); callbacks.removeValue(forKey: id) }
    func stop() { timers.values.forEach { $0.invalidate() }; timers.removeAll(); callbacks.removeAll() }
}

final class SubstackHTTPNoteTests: XCTestCase {
    @MainActor func testActualPublicResponseResolvesInJavaScriptCoreWithFullHTTPLinkAndQuote() async throws {
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../..").standardizedFileURL
        let rootURL = "https://substack.com/@joodaloop/note/c-360337718"
        let quoteURL = "https://substack.com/@joodaloop/note/c-357819575"
        let responses = [
            rootURL: try String(contentsOf: repository.appendingPathComponent("tests/fixtures/substack-contracts/360337718.html"), encoding: .utf8),
            quoteURL: try String(contentsOf: repository.appendingPathComponent("tests/fixtures/substack-contracts/357819575.html"), encoding: .utf8)
        ]
        let context = try XCTUnwrap(JSContext())
        let timers = HTTPNoteTimers()
        var requested: [String] = []
        var result: String?, failure: String?
        let complete = expectation(description: "native resolution completed")
        defer { timers.stop(); context.setObject(NSNull(), forKeyedSubscript: "nativeHTTP" as NSString) }
        let hash: @convention(block) (String) -> String = { value in
            SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        let http: @convention(block) (Int, String) -> Void = { id, raw in
            do {
                let request = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
                let url = try XCTUnwrap(request["url"]?.string)
                requested.append(url)
                let body = try XCTUnwrap(responses[url], "Unexpected network request: \(url)")
                let response: [String: Any] = ["status": 200, "url": url, "headers": ["content-type": "text/html"], "body": body]
                let json = String(decoding: try JSONSerialization.data(withJSONObject: response), as: UTF8.self)
                context.objectForKeyedSubscript("captureHTTPComplete")?.call(withArguments: [id, json])
            } catch { failure = error.localizedDescription; complete.fulfill() }
        }
        let finish: @convention(block) (String, JSValue, JSValue) -> Void = { _, value, error in
            result = value.isNull || value.isUndefined ? nil : value.toString()
            if !error.isNull && !error.isUndefined { failure = error.toString() }
            complete.fulfill()
        }
        let setTimer: @convention(block) (JSValue, Double) -> Int = { callback, delay in
            timers.schedule(callback, delay: delay)
        }
        let clearTimer: @convention(block) (Int) -> Void = { timers.cancel($0) }
        let cancel: @convention(block) (Int) -> Void = { _ in }
        for (name, block) in ["nativeSHA256": hash as Any, "nativeHTTP": http as Any,
                              "nativeResolveComplete": finish as Any, "setTimeout": setTimer as Any,
                              "clearTimeout": clearTimer as Any, "nativeCancelHTTP": cancel as Any] {
            context.setObject(block, forKeyedSubscript: name as NSString)
        }
        context.evaluateScript(try String(contentsOf: repository.appendingPathComponent("ios/Sources/CaptureRuntime/Resources/capture-core.js"), encoding: .utf8))
        XCTAssertNil(context.exception)
        let refs = String(decoding: try JSONEncoder().encode([rootURL]), as: UTF8.self)
        context.objectForKeyedSubscript("captureResolve")?.call(withArguments: ["http-note-fixture", refs, #"{"threadExpansion":"off"}"#])
        await fulfillment(of: [complete], timeout: 10)
        XCTAssertNil(failure)
        let plan = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(try XCTUnwrap(result).utf8))["plan"])
        let source = try XCTUnwrap(plan["sources"]?.array.first)
        XCTAssertEqual(source["id"]?.string, "360337718")
        XCTAssertEqual(source["author"]?["handle"]?.string, "joodaloop")
        XCTAssertTrue((source["text"]?.string ?? "").contains("http://nicochilla.com"))
        XCTAssertTrue((source["text"]?.string ?? "").contains("and a themed grid at that!"))
        XCTAssertEqual(source["quote"]?["id"]?.string, "357819575")
        XCTAssertEqual(source["media"]?.array.count, 4)
        XCTAssertEqual(plan["block"]?["selectedMedia"]?.array.compactMap(\.string), ["1.1", "1.2", "1.3", "1.4"])
        XCTAssertEqual(source["quote"]?["media"]?.array.count, 1)
        let optedIn = try CaptureRuntime().compose(postsJSON: String(decoding: JSONEncoder().encode(plan["sources"]!), as: UTF8.self),
                                                  policyJSON: #"{"media":"all","threadExpansion":"off"}"#)
        let explicitPlan = try JSONDecoder().decode(JSONValue.self, from: Data(optedIn.utf8))["plan"]
        XCTAssertEqual(explicitPlan?["block"]?["selectedMedia"]?.array.count, 5)
        XCTAssertEqual(requested, [rootURL, quoteURL])
        let runtime = try CaptureRuntime()
        let encoded = String(decoding: try JSONEncoder().encode(plan), as: UTF8.self)
        let fields = try JSONDecoder().decode(JSONValue.self, from: Data(runtime.fields(planJSON: encoded).utf8))
        XCTAssertTrue((fields["description"]?.string ?? "").contains("http://nicochilla.com"))
    }
}
