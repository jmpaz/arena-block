import Foundation
import XCTest
@testable import CaptureCore

final class CaptureWorkspaceTests: XCTestCase {
    @MainActor
    private func fixture(_ body: (CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-workspace-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("capture.sqlite")
        try body(CaptureStore(url: url), url)
    }

    private func draft(_ input: String = "https://example.invalid/article", account: Int = 42) -> CaptureDraft {
        CaptureDraft(accountID: account, defaultChannel: nil, input: input)
    }

    @MainActor
    func testFirstExtensionStartsItsOwnDraftAndCommitsSelectionBeforeReopen() throws {
        try fixture { store, url in
            var main = draft(); main.titleOverride = "Main writing"
            try store.save(main, account: 42, kind: "draft", id: main.id.uuidString)
            try store.save(CaptureWorkspace(activeDraftID: main.id), account: 42, kind: "workspace", id: "main")
            let share = try store.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false)
            XCTAssertNotEqual(share.draft.id, main.id)
            XCTAssertEqual(share.draft.input, "")
            XCTAssertNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: share.draft.id.uuidString))
            var edited = share.draft; edited.titleOverride = "Share writing"
            try store.save(edited, account: 42, kind: "draft", id: edited.id.uuidString)
            try store.save(CaptureWorkspace(activeDraftID: edited.id), account: 42, kind: "workspace", id: "share")
            let reopened = try CaptureStore(url: url)
            XCTAssertEqual(try reopened.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false).draft.id, share.draft.id)
            XCTAssertEqual(try reopened.value(CaptureDraft.self, account: 42, kind: "draft", id: main.id.uuidString)?.titleOverride, "Main writing")
        }
    }

    @MainActor
    func testExtensionDoesNotMigrateEvenAnUnownedLegacyDraft() throws {
        try fixture { store, _ in
            let legacy = draft()
            try store.save(legacy, account: 42, kind: "draft", id: legacy.id.uuidString)
            let share = try store.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false)
            XCTAssertNotEqual(share.draft.id, legacy.id)
            XCTAssertEqual(share.draft.input, "")
            XCTAssertEqual(try store.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true).draft.id, legacy.id)
        }
    }

    @MainActor
    func testMainMigrationExcludesEveryWorkspaceActiveAndRetainedDraft() throws {
        try fixture { store, url in
            let legacy = draft(), selected = draft(), retained = draft()
            for value in [legacy, selected, retained] {
                try store.save(value, account: 42, kind: "draft", id: value.id.uuidString)
            }
            // Ownership scanning must include more than the default 100-record window.
            try store.save(CaptureWorkspace(activeDraftID: selected.id, retainedResultID: retained.id), account: 42, kind: "workspace", id: "share")
            for index in 0..<101 {
                try store.save(CaptureWorkspace(), account: 42, kind: "workspace", id: "other-\(index)")
            }
            let main = try store.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
            XCTAssertEqual(main.draft.id, legacy.id)
            let reopened = try CaptureStore(url: url)
            XCTAssertEqual(try reopened.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true).draft.id, legacy.id)
            XCTAssertEqual(try reopened.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false).draft.id, selected.id)
            XCTAssertEqual(try reopened.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false).retainedResult?.id, retained.id)
        }
    }

    @MainActor
    func testMissingInitializedPointerStartsFreshWithoutRepeatingMigration() throws {
        try fixture { store, _ in
            let orphan = draft(), retained = draft()
            for value in [orphan, retained] { try store.save(value, account: 42, kind: "draft", id: value.id.uuidString) }
            try store.save(CaptureWorkspace(activeDraftID: UUID(), retainedResultID: retained.id), account: 42, kind: "workspace", id: "main")
            let main = try store.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
            XCTAssertNotEqual(main.draft.id, orphan.id)
            XCTAssertEqual(main.draft.input, "")
            XCTAssertEqual(main.retainedResult?.id, retained.id)
        }
    }

    @MainActor
    func testEmptyInitializedWorkspaceDoesNotAdoptLatestAccountDraft() throws {
        try fixture { store, _ in
            try store.save(CaptureWorkspace(), account: 42, kind: "workspace", id: "main")
            let legacy = draft()
            try store.save(legacy, account: 42, kind: "draft", id: legacy.id.uuidString)
            let main = try store.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
            XCTAssertNotEqual(main.draft.id, legacy.id)
            XCTAssertEqual(main.draft.input, "")
        }
    }

    @MainActor
    func testOwnershipAndMigrationAreScopedToTheAccount() throws {
        try fixture { store, _ in
            let legacy = draft(), other = draft(account: 99)
            try store.save(legacy, account: 42, kind: "draft", id: legacy.id.uuidString)
            try store.save(other, account: 99, kind: "draft", id: other.id.uuidString)
            try store.save(CaptureWorkspace(activeDraftID: other.id), account: 99, kind: "workspace", id: "main")
            XCTAssertEqual(try store.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true).draft.id, legacy.id)
            XCTAssertEqual(try store.openWorkspace(account: 99, id: "main", defaultChannel: nil, migrateLegacy: true).draft.id, other.id)
        }
    }

    @MainActor
    func testEmptyWorkspaceIsNavigationStateAndNeverReopensAnOldDraft() throws {
        try fixture { store, url in
            let old = draft()
            try store.save(old, account: 42, kind: "draft", id: old.id.uuidString)
            try store.save(CaptureWorkspace(), account: 42, kind: "workspace", id: "main")
            for _ in 0..<5 {
                let reopened = try CaptureStore(url: url)
                let empty = try reopened.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
                XCTAssertEqual(empty.draft.input, "")
                XCTAssertNil(try reopened.value(CaptureDraft.self, account: 42, kind: "draft", id: empty.draft.id.uuidString))
                XCTAssertNil(try reopened.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "main")?.activeDraftID)
                XCTAssertEqual(try reopened.recordIDs(account: 42, kind: "draft"), [old.id.uuidString])
            }
        }
    }

    @MainActor
    func testInitializationRollsBackDraftAndPointerTogether() throws {
        try fixture { store, url in
            enum Interrupted: Error { case beforeCommit }
            XCTAssertThrowsError(try store.transaction {
                _ = try store.openWorkspace(account: 42, id: "main", defaultChannel: nil, migrateLegacy: true)
                throw Interrupted.beforeCommit
            })
            let reopened = try CaptureStore(url: url)
            XCTAssertNil(try reopened.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "main"))
            XCTAssertEqual(try reopened.recordIDs(account: 42, kind: "draft"), [])
        }
    }
}
