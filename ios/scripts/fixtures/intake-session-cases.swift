import Foundation
import CaptureCore
import SQLite3

struct FixtureFailure: Error, CustomStringConvertible {
    let description: String
}

func require(_ value: Bool, _ message: String) throws {
    if !value { throw FixtureFailure(description: message) }
}

@MainActor
final class IntakeFixture {
    let directory: URL
    let database: URL
    let store: CaptureStore
    let session: SessionIntakeHarness

    init(signedIn: Bool = true) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("capture-intake-" + UUID().uuidString)
        database = directory.appendingPathComponent("capture.sqlite")
        store = try CaptureStore(url: database)
        ArenaAPI.rejectConnection = false
        if signedIn { try store.save(try ArenaAPI.identity(), account: 0, kind: "account", id: "current") }
        session = try SessionIntakeHarness(store: store, workspaceID: "main")
        if signedIn {
            session.draft?.input = "https://example.invalid/main-writing"
            session.draft?.titleOverride = "Main writing remains"
            try session.persist()
        }
    }

    func queue(_ urls: [String]) {
        session.busy = true
        session.receive(urls: urls.map { URL(string: $0)! })
        session.busy = false
    }

    func execute(_ sql: String) throws {
        var connection: OpaquePointer?
        guard sqlite3_open(database.path, &connection) == SQLITE_OK else { throw FixtureFailure(description: "fixture SQLite open") }
        defer { sqlite3_close(connection) }
        guard sqlite3_exec(connection, sql, nil, nil, nil) == SQLITE_OK else { throw FixtureFailure(description: "fixture SQLite statement") }
    }

    func oldDraftPreserved(_ id: UUID, count: Int) throws {
        try require(session.draft?.id == id, "active draft changed after a failed transaction")
        try require(session.draft?.input == "https://example.invalid/main-writing", "original input was overwritten")
        try require(session.draft?.titleOverride == "Main writing remains", "original writing was overwritten")
        let pointer = try store.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "main")
        try require(pointer?.activeDraftID == id, "workspace pointer changed after failure")
        try require(try store.recordIDs(account: 42, kind: "draft").count == count, "failed intake left an extra draft")
        try require(session.resolveCount == 0, "resolution started before replacement committed")
        try require(session.problem != nil, "storage failure was hidden")
    }
}

@main
struct IntakeSessionCases {
    @MainActor static func main() async {
        var failures = 0
        var cases = 0
        func run(_ name: String, signedIn: Bool = true, _ body: (IntakeFixture) async throws -> Void) async {
            cases += 1
            do {
                let fixture = try IntakeFixture(signedIn: signedIn)
                defer { try? FileManager.default.removeItem(at: fixture.directory) }
                try await body(fixture)
                print("PASS " + name)
            } catch {
                failures += 1
                print("FAIL " + name + ": " + String(describing: error))
            }
        }

        await run("foreground reads another host's intake without replacing main writing") { f in
            let old = f.session.draft!.id
            let other = try CaptureStore(url: f.database)
            let share = try other.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false)
            let url = "https://example.invalid/shared"
            let pending = PendingShare(id: UUID(), urls: [url, url])
            try other.save(pending, account: 0, kind: "incoming", id: pending.id.uuidString)
            f.session.refreshSharedIntake()
            try require(f.session.incomingLinks == [url], "new shared intake was not refreshed/deduplicated")
            try require(f.session.draft?.id == old && f.session.draft?.titleOverride == "Main writing remains", "foreground refresh replaced main writing")
            let pointer = try other.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "share")
            try require(pointer?.activeDraftID == nil, "main refresh changed empty share workspace state")
            try require(try other.value(CaptureDraft.self, account: 42, kind: "draft", id: share.draft.id.uuidString) == nil, "main refresh created a blank share draft")
        }
        await run("single queued input is handed off after successful connection", signedIn: false) { f in
            let url = "https://example.invalid/after-connect"
            f.queue([url])
            await f.session.connect(token: "fictional-token")
            try require(!f.session.busy && f.session.account?.id == 42, "connection did not leave ready state")
            try require(f.session.draft?.input == url, "connect busy guard prevented handoff")
            try require(f.session.incomingLinks.isEmpty, "accepted input stayed queued")
            try require(f.session.resolveCount == 1, "handoff did not start exactly one resolution")
            let stored = try f.store.value(CaptureDraft.self, account: 42, kind: "draft", id: f.session.draft!.id.uuidString)
            try require(stored?.input == url, "handoff input was not committed")
        }
        await run("connection discovers intake written after main initialization", signedIn: false) { f in
            let url = "https://example.invalid/other-host-before-connect"
            let other = try CaptureStore(url: f.database)
            let pending = PendingShare(id: UUID(), urls: [url])
            try other.save(pending, account: 0, kind: "incoming", id: pending.id.uuidString)
            try require(f.session.incomingLinks.isEmpty, "fixture unexpectedly refreshed main's intake")
            await f.session.connect(token: "fictional-token")
            try require(f.session.draft?.input == url && f.session.incomingLinks.isEmpty, "connection did not refresh/hand off another host's queued input")
            try require(f.session.resolveCount == 1, "discovered handoff did not start exactly one resolution")
        }
        await run("failed account connection retains intake", signedIn: false) { f in
            let url = "https://example.invalid/failed-connect"
            f.queue([url]); ArenaAPI.rejectConnection = true
            await f.session.connect(token: "fictional-token")
            try require(!f.session.busy && f.session.account == nil, "failed connection left busy/authenticated state")
            try require(f.session.incomingLinks == [url], "failed connection discarded input")
            try require(f.session.resolveCount == 0 && f.session.credentials.writes == 0, "failed connection changed credential or intake")
        }
        await run("new draft write failure preserves writing and queue") { f in
            let url = "https://example.invalid/replacement-failure"
            f.queue([url]); let old = f.session.draft!.id
            let count = try f.store.recordIDs(account: 42, kind: "draft").count
            try f.execute("CREATE TRIGGER reject_new BEFORE INSERT ON records WHEN NEW.kind='draft' AND NOT EXISTS(SELECT 1 FROM records WHERE account=NEW.account AND kind=NEW.kind AND id=NEW.id) BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
            f.session.useIncoming(url)
            try f.oldDraftPreserved(old, count: count)
            try require(f.session.incomingLinks == [url], "failed replacement consumed queued input")
        }
        await run("queue deletion failure rolls back draft and pointer") { f in
            let url = "https://example.invalid/delete-failure"
            f.queue([url]); let old = f.session.draft!.id
            let count = try f.store.recordIDs(account: 42, kind: "draft").count
            try f.execute("CREATE TRIGGER reject_delete BEFORE DELETE ON records WHEN OLD.kind='incoming' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
            f.session.useIncoming(url)
            try f.oldDraftPreserved(old, count: count)
            try require(f.session.incomingLinks == [url], "failed deletion changed visible queue")
            try require(try f.store.values(PendingShare.self, account: 0, kind: "incoming").flatMap(\.urls) == [url], "failed deletion changed persisted queue")
        }
        await run("queue update failure rolls back a multi-link handoff") { f in
            let a = "https://example.invalid/update-failure", b = "https://example.invalid/remaining"
            f.queue([a, b]); let old = f.session.draft!.id
            let count = try f.store.recordIDs(account: 42, kind: "draft").count
            try f.execute("CREATE TRIGGER reject_update BEFORE UPDATE ON records WHEN OLD.kind='incoming' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
            f.session.useIncoming(a)
            try f.oldDraftPreserved(old, count: count)
            try require(f.session.incomingLinks == [a, b], "failed queue update changed available choices")
        }
        await run("corrupt queued record cannot commit a replacement") { f in
            let url = "https://example.invalid/corrupt"
            f.queue([url]); let old = f.session.draft!.id
            let count = try f.store.recordIDs(account: 42, kind: "draft").count
            try f.store.save("corrupt fixture", account: 0, kind: "incoming", id: "corrupt")
            f.session.useIncoming(url)
            try f.oldDraftPreserved(old, count: count)
            try require(f.session.incomingLinks == [url], "failed queue read erased visible intake")
        }
        await run("foreground queue read failure retains the prior visible list") { f in
            let url = "https://example.invalid/read-failure"
            f.queue([url])
            try f.store.save("corrupt fixture", account: 0, kind: "incoming", id: "corrupt")
            f.session.refreshSharedIntake()
            try require(f.session.incomingLinks == [url] && f.session.problem != nil, "refresh hid the read failure or erased visible intake")
            try require(f.session.draft?.titleOverride == "Main writing remains", "failed refresh replaced writing")
        }
        await run("multiple shared URLs remain a choice after connection", signedIn: false) { f in
            let urls = ["https://example.invalid/first", "https://example.invalid/second"]
            f.queue(urls); await f.session.connect(token: "fictional-token")
            try require(!f.session.busy && f.session.incomingLinks == urls, "multi-link connection lost its choices")
            try require(f.session.draft?.input.isEmpty == true && f.session.resolveCount == 0, "multi-link connection silently chose a source")
        }
        await run("successful intake retains the submitted result") { f in
            f.session.draft?.phase = .saved; f.session.draft?.blockID = 9001
            try f.session.persist(); let previous = f.session.draft!.id
            let url = "https://example.invalid/after-result"
            f.queue([url]); f.session.useIncoming(url)
            try require(f.session.draft?.input == url && f.session.retainedResult?.id == previous, "intake lost the prior submitted result")
            let workspace = try f.store.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "main")
            try require(workspace?.retainedResultID == previous && workspace?.activeDraftID == f.session.draft?.id, "result and new draft ownership were not committed together")
        }
        await run("successful selection preserves the remaining shared URL") { f in
            let a = "https://example.invalid/chosen", b = "https://example.invalid/next"
            f.queue([a, b]); f.session.useIncoming(a)
            try require(f.session.draft?.input == a && f.session.incomingLinks == [b], "selection lost or auto-opened remaining intake")
            try require(try f.store.values(PendingShare.self, account: 0, kind: "incoming").flatMap(\.urls) == [b], "remaining input was not persisted")
        }
        await run("ordinary New action stays Void-compatible and preserves pending intake") { f in
            let url = "https://example.invalid/pending-choice"
            f.queue([url]); let previous = f.session.draft!.id
            let action: () -> Void = { f.session.newCapture() }
            action()
            try require(f.session.draft?.id != previous && f.session.draft?.input.isEmpty == true, "New did not open a fresh draft")
            try require(f.session.incomingLinks == [url] && f.session.resolveCount == 0, "ordinary New consumed or resolved pending intake")
        }
        await run("opening and cancelling placements never creates a persisted draft") { f in
            let active = f.session.draft!.id
            var result = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/saved-result")
            result.phase = .saved; result.blockID = 9001
            try f.store.save(result, account: 42, kind: "draft", id: result.id.uuidString)
            let count = try f.store.recordIDs(account: 42, kind: "draft").count
            f.session.addPlacements(to: result)
            try require(f.session.isAddingPlacements && f.session.draft?.isPlacementOnly == true, "placements did not open transiently")
            let temporary = f.session.draft!.id
            try f.session.persist()
            try require(try f.store.value(CaptureDraft.self, account: 42, kind: "draft", id: temporary.uuidString) == nil, "opening placements wrote a draft")
            try require(try f.store.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "main")?.activeDraftID == active, "temporary placements changed persisted composer ownership")
            f.session.cancelPlacements()
            try require(!f.session.isAddingPlacements && f.session.draft?.id == active, "Cancel did not restore the active capture")
            try require(f.session.draft?.titleOverride == "Main writing remains", "Cancel lost original writing")
            try require(try f.store.recordIDs(account: 42, kind: "draft").count == count, "Cancel left an extra draft")
        }
        await run("abandoned placements relaunch to original composer") { f in
            f.session.draft?.phase = .saved; f.session.draft?.blockID = 9001
            try f.session.persist(); let result = f.session.draft!
            f.session.addPlacements(to: result)
            let temporary = f.session.draft!.id
            f.session.persistOrReport()
            let reopened = try CaptureStore(url: f.database)
            try require(try reopened.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true).draft.id == result.id, "relaunch adopted abandoned placements")
            try require(try reopened.value(CaptureDraft.self, account: 42, kind: "draft", id: temporary.uuidString) == nil, "background persistence created an abandoned draft")
        }
        await run("clear drafts and Undo preserve writing without replacing fresh composer") { f in
            let original = f.session.draft!.id
            let removed = try f.session.clearDrafts()
            try require(removed == [original] && f.session.draft?.input.isEmpty == true, "Clear Drafts did not reset active composer")
            let fresh = f.session.draft!.id
            try require(try f.session.savedDrafts().isEmpty, "deleted draft remained in History")
            try require(try f.session.deletedDrafts().first?.draft.titleOverride == "Main writing remains", "recoverable draft lost writing")
            try f.session.restoreDeletedDrafts(removed)
            try require(try f.session.savedDrafts().first?.titleOverride == "Main writing remains", "Undo did not restore writing")
            try require(f.session.draft?.id == fresh, "Undo replaced the new composer")
        }
        await run("History pagination skips empty composer records") { f in
            for _ in 0..<110 {
                let empty = CaptureDraft(accountID: 42, defaultChannel: nil)
                try f.store.save(empty, account: 42, kind: "draft", id: empty.id.uuidString)
            }
            try require(try f.session.savedDrafts(limit: 1).first?.titleOverride == "Main writing remains", "empty composer records hid older captures")
        }
        await run("New preserves old draft identity and repeated reset creates no blank drafts") { f in
            let old = f.session.draft!.id
            let count = try f.store.recordIDs(account: 42, kind: "draft").count
            try require(f.session.newCapture(), "New did not reset")
            let empty = f.session.draft!.id
            try require(try f.store.recordIDs(account: 42, kind: "draft").count == count, "New silently created a blank draft")
            try require(try f.store.value(CaptureDraft.self, account: 42, kind: "draft", id: old.uuidString)?.titleOverride == "Main writing remains", "New destroyed old draft writing/identity")
            for _ in 0..<20 { try require(f.session.newCapture(), "repeated New failed") }
            f.session.persistOrReport()
            try require(f.session.draft?.id == empty, "repeated New minted another blank identity")
            try require(try f.store.recordIDs(account: 42, kind: "draft").count == count, "repeated New wrote blank drafts")
            try require(try f.store.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "main")?.activeDraftID == nil, "blank state points at a History draft")
            let relaunched = try SessionIntakeHarness(store: CaptureStore(url: f.database), workspaceID: "main")
            try require(relaunched.draft?.input.isEmpty == true && relaunched.draft?.id != old, "relaunch reopened retained old draft")
        }
        await run("History edit Cancel then New preserves both captures") { f in
            let active = f.session.draft!.id
            var other = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/history-edit")
            other.titleOverride = "History writing"
            try f.store.save(other, account: 42, kind: "draft", id: other.id.uuidString)
            f.session.resumeFromHistory(other)
            try require(f.session.isResumingHistory && f.session.draft?.id == other.id, "History resume was not deliberate")
            f.session.draft?.titleOverride = "Edited History writing"; try f.session.persist()
            f.session.cancelHistoryResume()
            try require(!f.session.isResumingHistory && f.session.draft?.id == active, "Cancel did not return to original composer")
            try require(f.session.newCapture(), "New after Cancel failed")
            try require(try f.store.value(CaptureDraft.self, account: 42, kind: "draft", id: other.id.uuidString)?.titleOverride == "Edited History writing", "Cancel or New lost History edits")
            try require(try f.store.value(CaptureDraft.self, account: 42, kind: "draft", id: active.uuidString)?.titleOverride == "Main writing remains", "Cancel or New lost original composer")
            try require(try f.session.savedDrafts().count == 2, "Cancel/New added or removed a History draft")
        }
        await run("completed capture placements Cancel then New keeps only submitted result") { f in
            f.session.draft?.phase = .saved; f.session.draft?.blockID = 9001
            try f.session.persist(); let saved = f.session.draft!
            f.session.addPlacements(to: saved); f.session.cancelPlacements()
            try require(f.session.newCapture(), "New after placements Cancel failed")
            try require(f.session.draft?.input.isEmpty == true && !f.session.isAddingPlacements, "New reopened placement editor")
            let history = try f.session.savedDrafts()
            try require(history.count == 1 && history[0].id == saved.id && history[0].phase == .saved, "placements Cancel/New changed saved History")
        }
        await run("external share arrival after New preserves old draft and consumes only chosen input") { f in
            let old = f.session.draft!.id
            try require(f.session.newCapture(), "New before share failed")
            let url = "https://example.invalid/new-external-share"
            f.session.receive(urls: [URL(string: url)!])
            try require(f.session.draft?.input == url && f.session.incomingLinks.isEmpty, "new external share did not enter composer")
            try require(try f.store.value(CaptureDraft.self, account: 42, kind: "draft", id: old.uuidString)?.titleOverride == "Main writing remains", "external share destroyed old draft")
            try require(try f.session.savedDrafts().count == 2, "external share left blank or duplicate drafts")
        }
        await run("interrupted History editing can reset after relaunch without extra draft") { f in
            var history = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/interrupted-history")
            history.titleOverride = "Interrupted writing"
            try f.store.save(history, account: 42, kind: "draft", id: history.id.uuidString)
            f.session.resumeFromHistory(history); f.session.persistOrReport()
            let relaunched = try SessionIntakeHarness(store: CaptureStore(url: f.database), workspaceID: "main")
            try require(relaunched.draft?.id == history.id, "interrupted editing was lost")
            try require(relaunched.newCapture(), "New could not escape restored editing")
            let reopened = try CaptureStore(url: f.database)
            try require(try reopened.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true).draft.input.isEmpty, "second relaunch trapped the user in old editing")
            try require(try reopened.recordIDs(account: 42, kind: "draft").count == 2, "interrupted New created extra drafts")
        }
        await run("empty destination selection survives relaunch as workspace state") { f in
            try require(f.session.newCapture(), "New before destination choice failed")
            let channel = try JSONDecoder().decode(Channel.self, from: Data(#"{"id":101,"title":"Chosen destination","slug":"chosen","visibility":"private","owner":{"id":42,"name":"Fixture","slug":"fixture","type":"User"},"can":{"add_to":true}}"#.utf8))
            f.session.draft?.selection.toggle(channel)
            try f.session.persist()
            let empty = f.session.draft!.id
            try require(try f.store.value(CaptureDraft.self, account: 42, kind: "draft", id: empty.uuidString) == nil, "choosing a destination wrote a blank draft")
            let reopened = try CaptureStore(url: f.database)
            let workspace = try reopened.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
            try require(workspace.draft.selection.channels.map(\.id) == [101], "empty destination choice was lost on relaunch")
            try require(workspace.draft.input.isEmpty, "destination choice reopened old editing")
        }
        await run("New cannot mutate a submission while handoff is busy") { f in
            let old = f.session.draft!.id
            f.session.busy = true
            try require(!f.session.newCapture(), "New changed a busy submission")
            f.session.busy = false
            try require(f.session.draft?.id == old && f.session.draft?.titleOverride == "Main writing remains", "busy New altered retained writing")
        }
        print("INTAKE CASES \(cases), FAILURES \(failures)")
        if failures > 0 { exit(1) }
    }
}
