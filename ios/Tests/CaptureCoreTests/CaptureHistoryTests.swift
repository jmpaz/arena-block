import Foundation
import SQLite3
import XCTest
@testable import CaptureCore

final class CaptureHistoryTests: XCTestCase {
    @MainActor
    func testReleasedStoreReopensAfterAnotherSharedWriter() throws {
        try fixture { appStore, url in
            try appStore.save("app", account: 42, kind: "probe", id: "shared")
            let shareStore = try CaptureStore(url: url)
            XCTAssertTrue(appStore.releaseIdleConnection())
            try shareStore.save("share", account: 42, kind: "probe", id: "shared")
            XCTAssertEqual(try appStore.value(String.self, account: 42, kind: "probe", id: "shared"), "share")
        }
    }

    @MainActor
    func testLockSnapshotShowsWriteTransactionAndReleasedState() throws {
        enum ProbeAbort: Error { case requested }
        try fixture { store, _ in
            let idle = store.diagnosticLockSnapshot()
            XCTAssertTrue(idle.isOpen)
            XCTAssertEqual(idle.transactionState, 0)
            XCTAssertTrue(idle.autocommit)
            XCTAssertEqual(idle.preparedStatements, 0)

            try store.transaction {
                let writing = store.diagnosticLockSnapshot()
                XCTAssertEqual(writing.transactionState, 2)
                XCTAssertFalse(writing.autocommit)
                XCTAssertEqual(writing.preparedStatements, 0)
                XCTAssertFalse(store.releaseIdleConnection())
                try store.save("retained", account: 42, kind: "probe", id: "committed")
            }
            let committed = store.diagnosticLockSnapshot()
            XCTAssertEqual(committed.transactionState, 0)
            XCTAssertTrue(committed.autocommit)
            XCTAssertEqual(committed.preparedStatements, 0)

            XCTAssertThrowsError(try store.transaction { throw ProbeAbort.requested })
            let rolledBack = store.diagnosticLockSnapshot()
            XCTAssertEqual(rolledBack.transactionState, 0)
            XCTAssertTrue(rolledBack.autocommit)
            XCTAssertEqual(rolledBack.preparedStatements, 0)

            XCTAssertTrue(store.releaseIdleConnection())
            let suspended = store.diagnosticLockSnapshot()
            XCTAssertFalse(suspended.isOpen)
            XCTAssertNil(suspended.mainFileLockState)
            XCTAssertEqual(try store.value(String.self, account: 42, kind: "probe", id: "committed"), "retained")
            XCTAssertTrue(store.diagnosticLockSnapshot().isOpen)
        }
    }

    @MainActor
    private func fixture(_ body: (CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-history-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("capture.sqlite")
        try body(CaptureStore(url: url), url)
    }

    @MainActor
    func testDeletedDraftReopensInRecoveryWithoutTakingOverComposer() throws {
        try fixture { store, url in
            var draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/writing")
            draft.titleOverride = "Keep this title"; draft.descriptionOverride = "Keep this writing"
            try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            try store.save(CaptureWorkspace(activeDraftID: draft.id), account: 42, kind: "workspace", id: "main")
            try store.save(CaptureWorkspace(retainedResultID: draft.id), account: 42, kind: "workspace", id: "share")
            XCTAssertEqual(try store.deleteDrafts([draft.id], account: 42), [draft.id])
            let reopened = try CaptureStore(url: url)
            XCTAssertNil(try reopened.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString))
            XCTAssertEqual(try reopened.value(DeletedCapture.self, account: 42, kind: "deletedDraft", id: draft.id.uuidString)?.draft.descriptionOverride, "Keep this writing")
            let fresh = try reopened.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
            XCTAssertNotEqual(fresh.draft.id, draft.id)
            XCTAssertNil(try reopened.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "share")?.retainedResultID)
            try reopened.restoreDeletedDrafts([draft.id], account: 42)
            XCTAssertEqual(try reopened.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString)?.titleOverride, "Keep this title")
            XCTAssertNil(try reopened.value(DeletedCapture.self, account: 42, kind: "deletedDraft", id: draft.id.uuidString))
            let empty = try reopened.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
            XCTAssertEqual(empty.draft.input, "")
            XCTAssertNotEqual(empty.draft.id, draft.id)
        }
    }

    @MainActor
    func testClearDraftsCannotRemoveSubmittedOrUnknownOutcomes() throws {
        try fixture { store, _ in
            let editable = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/editable")
            for phase in [CapturePhase.queued, .creating, .checking, .uncertain] {
                var submitted = editable; submitted.id = UUID(); submitted.phase = phase
                try store.save(editable, account: 42, kind: "draft", id: editable.id.uuidString)
                try store.save(submitted, account: 42, kind: "draft", id: submitted.id.uuidString)
                XCTAssertThrowsError(try store.deleteDrafts([editable.id, submitted.id], account: 42))
                XCTAssertNotNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: editable.id.uuidString))
                XCTAssertNotNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: submitted.id.uuidString))
                XCTAssertEqual(try store.recordIDs(account: 42, kind: "deletedDraft"), [])
            }
            // A queue record protects the draft even if its phase snapshot is stale.
            try store.save("opaque delivery fixture", account: 0, kind: "delivery", id: editable.id.uuidString)
            XCTAssertFalse(try store.canDeleteDraft(editable))
            XCTAssertThrowsError(try store.deleteDrafts([editable.id], account: 42))
        }
    }

    @MainActor
    func testAutomaticRetentionIsRecoverableAndProtectsUserWritingAndWorkspaces() throws {
        try fixture { store, _ in
            let now = Date()
            var automatic = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/automatic")
            automatic.updatedAt = now.addingTimeInterval(-25 * 3600)
            var edited = automatic; edited.id = UUID(); edited.descriptionOverride = ""
            var title = automatic; title.id = UUID(); title.titleOverride = "My title"
            var active = automatic; active.id = UUID()
            var saved = automatic; saved.id = UUID(); saved.phase = .saved; saved.blockID = 123
            for draft in [automatic, edited, title, active, saved] {
                try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            }
            try store.save(CaptureWorkspace(activeDraftID: active.id), account: 42, kind: "workspace", id: "share")
            XCTAssertEqual(try store.archiveExpiredAutomaticDrafts(account: 42, now: now), [automatic.id])
            XCTAssertEqual(try store.value(DeletedCapture.self, account: 42, kind: "deletedDraft", id: automatic.id.uuidString)?.draft.input, automatic.input)
            for draft in [edited, title, active, saved] {
                XCTAssertNotNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString))
            }
            try store.restoreDeletedDrafts([automatic.id], account: 42)
            XCTAssertEqual(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: automatic.id.uuidString)?.input, automatic.input)
            XCTAssertEqual(try store.archiveExpiredAutomaticDrafts(account: 42, now: now.addingTimeInterval(1)), [], "Restored drafts get a fresh retention interval")
        }
    }

    @MainActor
    func testSavedHistoryCanBeRemovedAndRestoredWithoutTouchingBlock() throws {
        try fixture { store, _ in
            var saved = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/saved")
            saved.phase = .saved; saved.blockID = 900
            try store.save(saved, account: 42, kind: "draft", id: saved.id.uuidString)
            try store.save(["stage": "done"], account: 0, kind: "delivery", id: saved.id.uuidString)
            XCTAssertEqual(try store.deleteDrafts([saved.id], account: 42), [saved.id])
            XCTAssertNotNil(try store.value([String: String].self, account: 0, kind: "delivery", id: saved.id.uuidString))
            try store.restoreDeletedDrafts([saved.id], account: 42)
            XCTAssertEqual(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: saved.id.uuidString)?.blockID, 900)
            try store.save(["stage": "attention"], account: 0, kind: "delivery", id: saved.id.uuidString)
            XCTAssertFalse(try store.canDeleteDraft(saved))
        }
    }

    @MainActor
    func testDeletionFailureRollsBackRecoverableCopyAndWorkspaceTogether() throws {
        try fixture { store, url in
            let draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/rollback")
            try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            try store.save(CaptureWorkspace(activeDraftID: draft.id), account: 42, kind: "workspace", id: "main")
            var connection: OpaquePointer?
            XCTAssertEqual(sqlite3_open(url.path, &connection), SQLITE_OK)
            defer { sqlite3_close(connection) }
            XCTAssertEqual(sqlite3_exec(connection, "CREATE TRIGGER reject_detach BEFORE UPDATE ON records WHEN OLD.kind='workspace' BEGIN SELECT RAISE(ABORT,'fixture failure'); END", nil, nil, nil), SQLITE_OK)
            XCTAssertThrowsError(try store.deleteDrafts([draft.id], account: 42))
            let reopened = try CaptureStore(url: url)
            XCTAssertNotNil(try reopened.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString))
            XCTAssertNil(try reopened.value(DeletedCapture.self, account: 42, kind: "deletedDraft", id: draft.id.uuidString))
            XCTAssertEqual(try reopened.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "main")?.activeDraftID, draft.id)
        }
    }

    @MainActor
    func testRemovalAndUndoStayWithinTheAccount() throws {
        try fixture { store, _ in
            let draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.invalid/account")
            try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            XCTAssertEqual(try store.deleteDrafts([draft.id], account: 99), [])
            try store.deleteDrafts([draft.id], account: 42)
            try store.restoreDeletedDrafts([draft.id], account: 99)
            XCTAssertNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString))
            try store.restoreDeletedDrafts([draft.id], account: 42)
            XCTAssertNotNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString))
        }
    }
}
