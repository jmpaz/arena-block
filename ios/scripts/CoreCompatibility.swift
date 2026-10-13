import Foundation
import JavaScriptCore
import CryptoKit
guard CommandLine.arguments.count == 2 else { fatalError("Provide the compatibility bundle directory") }
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let context = JSContext()!
context.exceptionHandler = { _, error in
    fputs("JavaScript error: \(error?.toString() ?? "unknown")\n", stderr)
}
let hash: @convention(block) (String) -> String = { input in
    SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
}
context.setObject(hash, forKeyedSubscript: "nativeSHA256" as NSString)
context.evaluateScript(try String(contentsOf: root.appendingPathComponent("core-compatibility-entry.js"), encoding: .utf8))
let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("cases.json"))) as! [Any]
let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("expected.json"))) as! [NSDictionary]
for (index, input) in cases.enumerated() {
    let json = String(data: try JSONSerialization.data(withJSONObject: input), encoding: .utf8)!
    guard let result = context.objectForKeyedSubscript("captureCompose")?.call(withArguments: [json])?.toString(),
          let data = result.data(using: .utf8),
          let actual = try JSONSerialization.jsonObject(with: data) as? NSDictionary,
          actual.isEqual(to: expected[index] as! [AnyHashable: Any]) else {
        fatalError("Composition mismatch in case \(index)")
    }
    print("Case \(index + 1): full plan, hash and publication fields identical")
}
