"""Exercise production submit methods against real SQLite/Delivery with a local UI adapter.

Uses existing macOS SwiftPM test products; no simulator, Keychain, provider or network.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
def declaration(text, marker):
    at = text.index(marker)
    start = text.rfind("\n", 0, at) + 1
    opening = text.index("{", at)
    depth, end = 1, opening + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end]



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--products", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--module-cache", type=Path, required=True)
    args = parser.parse_args()
    ios = Path(__file__).resolve().parents[1]
    source = ios / "Sources/CaptureUI/CaptureSession.swift"
    text = source.read_text()
    markers = ["var actualDestinations:", "var canSaveToDestinations:", "var canSubmitCapture:",
               "func hasDurableSubmission(", "func commitSubmission(", "func continueSubmittedWork(", "func save(", "func submitLink("]
    methods = {marker: declaration(text, marker) for marker in markers}
    host = '''import Foundation
import CaptureCore
@testable import CaptureUI

@MainActor final class SessionSubmitHarness {
    var account: Account?
    var draft: CaptureDraft?
    var defaultChannel: Channel?
    var defaultPolicy = DefaultChannelPolicy(mode: .always)
    var recent: [Channel] = [], cached: [Channel] = []
    var busy = false, isPreviewFixture = true
    var problem: String?
    var generation = UUID()
    var resolution: Task<Void, Never>?
    var scheduleRecovery: (() -> Void)?
    var beginSubmission: (() -> Void)?
    var startContinuedProcessing: ((UUID) -> Void)?
    let store: CaptureStore
    let delivery: CaptureDelivery
    init(root: URL) throws {
        store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        account = try JSONDecoder().decode(Account.self, from: Data(#"{"id":42,"name":"Fixture","slug":"fixture","tier":"premium"}"#.utf8))
    }
    func adoptPlacementSubmission() {}
    func refreshDelivery() {
        if let value = draft { draft = try? store.value(CaptureDraft.self, account: value.accountID, kind: "draft", id: value.id.uuidString) }
    }
'''
    host += "\n\n".join(methods.values()) + "\n}\n"
    host += '''
@main struct SubmitCases {
    @MainActor static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let session = try SessionSubmitHarness(root: root)
        func channel(_ id: Int) -> Channel { .init(id: id, title: "Channel", slug: "channel-\\(id)", visibility: "private", owner: .init(id: 42, name: "Fixture", slug: "fixture", type: "User")) }
        func expect(_ ok: Bool, _ message: String) throws { if !ok { throw CaptureError.message(message) }; print("PASS: " + message) }
        session.defaultChannel = channel(101)
        var source = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://x.com/person/status/123")
        source.phase = .preparing; source.selection.toggle(channel(102)); source.selection.toggle(channel(101))
        source.media = .selected; source.selectedMedia = ["1.1"]
        source.titleOverride = "Frozen title"; source.descriptionOverride = "Frozen writing"
        session.draft = source
        var reads = 0
        session.delivery.readSource = { _ in reads += 1; throw CaptureError.message("offline") }
        var began = 0, recoveryBeforeBegin = false
        session.beginSubmission = { began += 1 }
        session.scheduleRecovery = { if began == 0 { recoveryBeforeBegin = true } }
        let ticket = session.generation
        let previewTask = Task<Void, Never> { try? await Task.sleep(for: .seconds(20)) }
        session.resolution = previewTask
        try expect(session.canSubmitCapture, "Save/Connect accepts unresolved valid URL")
        let accepted = await session.save()
        try expect(accepted && reads == 0, "submit commits before any provider read")
        try expect(began == 1 && !recoveryBeforeBegin, "background time begins synchronously before scheduling recovery")
        try expect(previewTask.isCancelled && session.generation != ticket, "late optional preview cannot override submit")
        try expect(session.draft?.id == source.id && session.draft?.phase == .queued, "same composer UUID becomes queued")
        let job = try session.store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString)!
        try expect(job.draft.selection.channels.map(\\.id) == [101, 102], "default is first; explicit remainder retains order")
        try expect(job.submission?.title == "Frozen title" && job.submission?.policy["selectedMedia"] == .array([.string("1.1")]), "selected media and writing intent are frozen")
        for _ in 0..<10 { let repeated = await session.save(); try expect(repeated, "repeat submit recognizes same operation") }
        try expect(try session.store.recordIDs(account: 0, kind: "delivery").count == 1, "repeat creates one job")
        try expect(try session.store.recordIDs(account: 42, kind: "draft").count == 1, "repeat creates one history row")
        session.draft?.input = "later edit"; session.draft?.media = .none
        let retained = try session.store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString)!
        try expect(retained.submission?.url == source.input && retained.submission?.policy["media"] == .string("selected"), "UI mutation cannot alter queued intent")
        // A separate Shortcut request never takes over the user's selected composer.
        let activeID = session.draft?.id
        session.cached = [channel(102)]
        let shortcutID = try session.submitLink(URL(string: "https://example.com/link")!, title: "Shortcut title", media: .none, channelIDs: [102])
        try expect(session.draft?.id == activeID && shortcutID != activeID, "Shortcut queues its request without replacing composer")
        let shortcut = try session.store.value(DeliveryJob.self, account: 0, kind: "delivery", id: shortcutID.uuidString)!
        try expect(shortcut.draft.selection.channels.map(\\.id) == [101, 102] && shortcut.submission?.policy["media"] == .string("none"), "Shortcut uses same routing and durable options")
    }
}
'''
    args.scratch.mkdir(parents=True, exist_ok=True)
    generated = args.scratch / "submit-session.swift"
    generated.write_text(host)
    objects = [obj for target in ["CaptureCore", "CaptureRuntime", "CaptureUI"] for obj in (args.products / (target + ".build")).glob("*.swift.o")]
    exe = args.scratch / "submit-session"
    command = ["xcrun", "swiftc", "-parse-as-library", "-swift-version", "5", "-module-cache-path", str(args.module_cache), "-I", str(args.products / "Modules"), str(generated), *map(str, objects), "-lsqlite3", "-framework", "JavaScriptCore", "-framework", "AVFoundation", "-framework", "CoreGraphics", "-framework", "ImageIO", "-framework", "Security", "-o", str(exe)]
    compile = subprocess.run(command, capture_output=True, text=True, timeout=60)
    (args.scratch / "compile.log").write_text(compile.stdout + compile.stderr)
    if compile.returncode: print(compile.stderr); return compile.returncode
    result = subprocess.run([str(exe)], capture_output=True, text=True, timeout=30)
    (args.scratch / "cases.log").write_text(result.stdout + result.stderr)
    print(result.stdout + result.stderr)
    (args.scratch / "receipt.json").write_text(json.dumps({"sourceSHA256": hashlib.sha256(source.read_bytes()).hexdigest(), "methodsSHA256": {k: hashlib.sha256(v.encode()).hexdigest() for k, v in methods.items()}, "compileExit": compile.returncode, "fixtureExit": result.returncode, "limits": "Exact production submit method bodies and real SQLite/Delivery; local UI adapter. No UIKit, AppIntent invocation, provider/network, device interruption or OS scheduling coverage."}, indent=2) + "\n")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
