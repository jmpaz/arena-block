import CryptoKit
import Foundation
import JavaScriptCore
import XCTest

final class ExcerptRuntimeTests: XCTestCase {
    @MainActor func testSharedExcerptDocumentBridgeRunsInJavaScriptCoreWithoutBrowserGlobals() throws {
        let context = try XCTUnwrap(JSContext())
        let hash: @convention(block) (String) -> String = { value in SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
        context.setObject(hash, forKeyedSubscript: "nativeSHA256" as NSString)
        context.evaluateScript("globalThis.setTimeout=function(){return 0};globalThis.clearTimeout=function(){};globalThis.nativeHTTP=function(){throw new Error('No HTTP expected')};globalThis.nativeCancelHTTP=function(){};globalThis.nativeResolveComplete=function(){};")
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bundle = package.appendingPathComponent("Sources/CaptureRuntime/Resources/capture-core.js")
        context.evaluateScript(try String(contentsOf: bundle, encoding: .utf8))
        XCTAssertNil(context.exception, context.exception?.toString() ?? "")
        let input: [String: Any] = ["input": ["url": "https://example.com/#:~:text=First%20words,last%20words."],
            "document": ["body": "<title>Source</title><p><b>First words</b> café 日本語 👋 last words.</p>", "responseURL": "https://example.com/", "contentType": "text/html"]]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
        let result = context.objectForKeyedSubscript("captureExcerptDocumentPlan")?.call(withArguments: [json])
        XCTAssertNil(context.exception, context.exception?.toString() ?? "")
        let response = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(XCTUnwrap(result?.toString()).utf8)) as? [String: Any])
        let plan = try XCTUnwrap(response["plan"] as? [String: Any]), block = try XCTUnwrap(plan["block"] as? [String: Any])
        XCTAssertEqual(block["kind"] as? String, "text")
        XCTAssertEqual(block["markdown"] as? String, "**First words** café 日本語 👋 last words.")
        XCTAssertEqual((block["excerpt"] as? [String: Any])?["method"] as? String, "provided-html")
        XCTAssertEqual(block["canonicalSource"] as? String, "https://example.com/#:~:text=First%20words,last%20words.")
    }
}
