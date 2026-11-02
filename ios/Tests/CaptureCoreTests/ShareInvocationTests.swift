import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureUI

final class ShareInvocationTests: XCTestCase {
    @MainActor func testNewShareIsBlankAndPreservesPriorDraftJobHistoryAndPendingRows() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        var prior = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.com/old")
        prior.titleOverride = "Old writing"; prior.phase = .queued
        let job = DeliveryJob(id: prior.id, draft: prior, prepared: .init(payload: [:], update: [:]), stage: .reading)
        try store.save(prior, account: 42, kind: "draft", id: prior.id.uuidString)
        try store.save(job, account: 0, kind: "delivery", id: prior.id.uuidString)
        try store.save(CaptureWorkspace(activeDraftID: prior.id, retainedResultID: prior.id), account: 42, kind: "workspace", id: "share")
        let pending = PendingShare(id: UUID(), urls: [prior.input])
        try store.save(pending, account: 0, kind: "incoming", id: pending.id.uuidString)
        let firstID = UUID()
        let fresh = try store.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: firstID)
        XCTAssertEqual(fresh.draft.input, ""); XCTAssertNil(fresh.draft.titleOverride)
        XCTAssertNil(fresh.draft.previewSnapshot); XCTAssertNil(fresh.draft.blockID)
        XCTAssertTrue(fresh.draft.selection.channels.isEmpty); XCTAssertNil(fresh.retainedResult)
        XCTAssertEqual(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: prior.id.uuidString)?.titleOverride, "Old writing")
        XCTAssertEqual(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: prior.id.uuidString)?.stage, .reading)
        XCTAssertEqual(try store.value(PendingShare.self, account: 0, kind: "incoming", id: pending.id.uuidString)?.urls, [prior.input])
    }

    @MainActor func testNewSameURLShareRejectsOldReadsWritesAndBrowserReplacementAtomically() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("capture.sqlite")
        let first = try CaptureStore(url: url), second = try CaptureStore(url: url)
        let firstID = UUID(), secondID = UUID()
        var draft = try first.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: firstID).draft
        draft.input = "https://example.com/same"; draft.titleOverride = "Old title"
        var workspace = try XCTUnwrap(first.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "share"))
        workspace.activeDraftID = draft.id
        _ = try first.commitNewCapture(draft, workspace: workspace, workspaceID: "share", consumingIncoming: false, shareInvocationID: firstID)
        _ = try second.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: secondID)
        XCTAssertThrowsError(try first.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false, shareInvocationID: firstID))
        XCTAssertThrowsError(try first.commitNewCapture(draft, workspace: workspace, workspaceID: "share", consumingIncoming: true, shareInvocationID: firstID))
        XCTAssertThrowsError(try first.replaceBrowserSnapshot(in: draft, recordsJSON: "[]", workspaceID: "share", shareInvocationID: firstID))
        let current = try second.openWorkspace(account: 42, id: "share", defaultChannel: nil, migrateLegacy: false, shareInvocationID: secondID)
        XCTAssertEqual(current.draft.input, ""); XCTAssertNil(current.draft.titleOverride)
        XCTAssertEqual(try first.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString)?.titleOverride, "Old title")
        XCTAssertEqual(try first.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "share")?.shareInvocationID, secondID)
    }

    @MainActor func testCurrentShareConsumesOnlyItsOwnSameURLSnapshot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let source = "https://www.reddit.com/comments/test/"
        let old = PendingShare(id: UUID(), urls: [source], redditCaptureJSON: "old")
        let current = PendingShare(id: UUID(), urls: [source], redditCaptureJSON: "current")
        for value in [old, current] { try store.save(value, account: 0, kind: "incoming", id: value.id.uuidString) }
        let invocation = UUID()
        var draft = try store.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: invocation).draft
        draft.input = source
        var workspace = try XCTUnwrap(store.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "share")); workspace.activeDraftID = draft.id
        let result = try store.commitNewCapture(draft, workspace: workspace, workspaceID: "share", consumingIncoming: true, incomingIDs: [current.id], shareInvocationID: invocation)
        XCTAssertEqual(result.draft.redditCapturesJSON, "[current]")
        XCTAssertEqual(result.incoming, [])
        XCTAssertNotNil(try store.value(PendingShare.self, account: 0, kind: "incoming", id: old.id.uuidString))
        XCTAssertNil(try store.value(PendingShare.self, account: 0, kind: "incoming", id: current.id.uuidString))
    }

    @MainActor func testLateProviderResultCannotReplaceNextSharesWorkspace() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let second = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let firstID = UUID(), secondID = UUID()
        let old = try first.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: firstID)
        var continuation: CheckedContinuation<Any?, Never>?
        let task = Task { @MainActor in
            let received = try await CaptureShareInput.sourceRepresentation(types: ["url"]) { _ in
                await withCheckedContinuation { continuation = $0 }
            }
            guard case .links(let urls) = received else { throw CaptureError.message("No fixture URL") }
            var draft = old.draft; draft.input = urls[0].absoluteString
            let workspace = CaptureWorkspace(activeDraftID: draft.id, shareInvocationID: firstID)
            _ = try first.commitNewCapture(draft, workspace: workspace, workspaceID: "share", consumingIncoming: false, shareInvocationID: firstID)
        }
        while continuation == nil { await Task.yield() }
        _ = try second.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: secondID)
        continuation?.resume(returning: URL(string: "https://example.com/late-first-share")!)
        do { try await task.value; XCTFail("A late provider replaced the new invocation") }
        catch is CancellationError { }
        let workspace = try XCTUnwrap(second.value(CaptureWorkspace.self, account: 42, kind: "workspace", id: "share"))
        XCTAssertEqual(workspace.shareInvocationID, secondID)
        XCTAssertNil(workspace.activeDraftID)
        XCTAssertNil(try first.value(CaptureDraft.self, account: 42, kind: "draft", id: old.draft.id.uuidString))
    }
}
