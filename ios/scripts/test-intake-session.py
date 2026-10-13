"""Run unchanged CaptureSession intake methods with SQLite and local host adapters.

Requires previously built macOS CaptureCore/CaptureRuntime products. This does
not run xcodebuild, a simulator, native presentation, Keychain or networking.
"""
import argparse
import hashlib
import json
import shutil
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
    parser.add_argument("--products", type=Path, required=True, help="Existing SwiftPM macOS debug products")
    parser.add_argument("--scratch", type=Path, required=True, help="Task-owned writable fixture output")
    parser.add_argument("--module-cache", type=Path, required=True, help="Existing task-owned Clang cache")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--view", type=Path)
    args = parser.parse_args()
    ios = Path(__file__).resolve().parents[1]
    source = args.source or ios / "Sources/CaptureUI/CaptureSession.swift"
    view = args.view or ios / "Sources/CaptureUI/CaptureView.swift"
    if shutil.disk_usage(args.scratch.parent).free < 512 * 1024 * 1024:
        raise SystemExit("Insufficient headroom for the bounded host fixture")
    args.scratch.mkdir(parents=True, exist_ok=True)
    text = source.read_text()
    names = ["reloadAccount", "connect", "persist", "persistOrReport", "newCapture", "useIncoming", "receive", "refreshIncoming", "refreshSharedIntake", "readIncomingLinks", "setInput", "addPlacements", "cancelPlacements", "resumeFromHistory", "cancelHistoryResume", "restore", "savedDrafts", "canDeleteDraft", "deleteDrafts", "clearDrafts", "restoreDeletedDrafts", "deletedDrafts"]
    methods, missing = {}, []
    for name in names:
        try: methods[name] = declaration(text, "func " + name + "(")
        except ValueError:
            if name not in ["refreshSharedIntake", "readIncomingLinks"]: raise
            missing.append(name)
    host = '''import Foundation
import CaptureCore

// The following adapters are fictional. Production persistence/intake method
// bodies below are copied byte-for-byte. No Keychain or network is contacted.
@MainActor final class FixtureCredentials {
    var writes = 0
    func read(_ key: String) throws -> String? { "fictional-token" }
    func write(_ value: String, key: String) throws { writes += 1 }
}
struct FixtureDefaults { func bool(forKey key: String) -> Bool { false } }
@MainActor final class ArenaAPI {
    static var rejectConnection = false
    init(token: String) {}
    static func identity() throws -> Account {
        try JSONDecoder().decode(Account.self, from: Data(#"{"id":42,"name":"Fixture","slug":"fixture","tier":"premium"}"#.utf8))
    }
    func me() async throws -> Account {
        if Self.rejectConnection { throw FixtureFailure(description: "fictional account rejection") }
        return try Self.identity()
    }
}
struct DeliveryJob: Codable {
    enum Stage: String, Codable { case attention }
    var id: UUID
    var draft: CaptureDraft
    var stage: Stage
    var problem: String?
}
@MainActor final class FixtureDelivery {
    func retry(_ id: UUID) async {}
    func resume() async {}
}
@MainActor final class SessionIntakeHarness {
    var account: Account?
    var draft: CaptureDraft?
    var retainedResult: CaptureDraft?
    var preview: CapturePreview?
    var defaultChannel: Channel?
    var recent: [Channel] = []
    var cached: [Channel] = []
    var automaticPaste = false
    var incomingLinks: [String] = []
    var busy = false
    var problem: String?
    var progress = ""
    var isPreviewFixture = false
    let store: CaptureStore
    let workspaceID: String
    let allowsLegacyWorkspaceMigration = true
    let credentials = FixtureCredentials()
    let defaults = FixtureDefaults()
    let delivery = FixtureDelivery()
    var api: ArenaAPI?
    let resolvedSources = ResolvedSourceCache()
    var renderedSources: [String: String] = [:]
    var renderedIdentity: String?
    private var placementReturnDraft: CaptureDraft?
    var isAddingPlacements: Bool { placementReturnDraft != nil }
    private var historyReturnDraft: CaptureDraft?
    var isResumingHistory: Bool { historyReturnDraft != nil }
    var deliveryRevision = 0
    var generation = UUID()
    var resolution: Task<Void, Never>?
    var resolveCount = 0
    init(store: CaptureStore, workspaceID: String) throws {
        self.store = store; self.workspaceID = workspaceID
        try reloadAccount(); try refreshIncoming()
    }
    func resolve() { resolveCount += 1 }
'''
    host += "\n\n".join(methods.values())
    if "refreshSharedIntake" in missing:
        host += "\nfunc refreshSharedIntake() {} // Baseline has no foreground intake hook.\n"
    host += "\n}\n" + declaration(text, "struct PendingShare:") + "\n"
    output = args.scratch / "SessionIntakeHarness.swift"
    output.write_text(host)
    objects = sorted((args.products / "CaptureCore.build").glob("*.swift.o")) + sorted((args.products / "CaptureRuntime.build").glob("*.swift.o"))
    if not objects or not (args.products / "Modules/CaptureCore.swiftmodule").exists():
        raise SystemExit("Supply existing compiled macOS core products; this runner does not build them")
    executable = args.scratch / "intake-fixture"
    command = [shutil.which("swiftc") or "swiftc", "-parse-as-library", "-swift-version", "5", "-module-cache-path", str(args.module_cache), "-I", str(args.products / "Modules"), str(output), str(ios / "scripts/fixtures/intake-session-cases.swift"), *map(str, objects), "-lsqlite3", "-framework", "JavaScriptCore", "-framework", "AVFoundation", "-framework", "CoreGraphics", "-framework", "ImageIO", "-o", str(executable)]
    compile = subprocess.run(command, capture_output=True, text=True, timeout=60)
    (args.scratch / "compile.log").write_text(compile.stdout + compile.stderr)
    if compile.returncode:
        print(compile.stderr)
        return compile.returncode
    result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=30)
    (args.scratch / "cases.log").write_text(result.stdout + result.stderr)
    print(result.stdout, end="")
    active = view.read_text().split("if phase == .active {", 1)[1].split("} else { session.persistOrReport() }", 1)[0]
    foreground_hook = "session.refreshSharedIntake()" in active and active.index("session.refreshSharedIntake()") < active.index("offerClipboard()")
    print("FOREGROUND HOOK BEFORE CLIPBOARD:", foreground_hook)
    receipt = {"source": str(source), "sourceSHA256": hashlib.sha256(source.read_bytes()).hexdigest(), "viewSHA256": hashlib.sha256(view.read_bytes()).hexdigest(), "methodSHA256": {name: hashlib.sha256(value.encode()).hexdigest() for name, value in methods.items()}, "methodBytesUnchanged": True, "baselineMissingMethods": missing, "foregroundHookBeforeClipboard": foreground_hook, "compileExit": compile.returncode, "fixtureExit": result.returncode, "fixtureSourceSHA256": hashlib.sha256((ios / "scripts/fixtures/intake-session-cases.swift").read_bytes()).hexdigest(), "cachedCoreObjects": [{"name": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in objects], "generatedBytes": sum(p.stat().st_size for p in args.scratch.rglob("*") if p.is_file()), "limits": "Host methods and real SQLite only. Account/credentials/delivery/resolution are fictional adapters. No UIKit, Share host, signed grants, network, provider or OS scheduling coverage."}
    (args.scratch / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if receipt["generatedBytes"] > 32 * 1024 * 1024:
        raise SystemExit("Host fixture exceeded its 32 MiB output budget")
    return result.returncode or (0 if foreground_hook else 1)


if __name__ == "__main__":
    raise SystemExit(main())
