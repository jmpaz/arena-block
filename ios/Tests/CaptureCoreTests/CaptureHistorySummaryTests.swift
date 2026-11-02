import Foundation
import XCTest
@testable import CaptureCore

final class CaptureHistorySummaryTests: XCTestCase {
    func testProjectionMatchesRowsWithoutKeepingSourcePlansOrBlockBodies() throws {
        var draft = populatedDraft(index: 1)
        draft.phase = .checking
        draft.deliveryState = .init(operationID: draft.id, stage: .attention, stopRequested: true)
        draft.problem = "Interrupted"
        for savedTitle in [String?.none, "Saved title", ""] {
            for override in [String?.none, "Edited title", ""] {
                draft.titleOverride = override
                if let savedTitle { draft.savedBlock = .object(["title": .string(savedTitle), "image": image]) }
                else { draft.savedBlock = .object(["body": .string("Complete captured writing"), "image": image]) }
                let projected = try JSONDecoder().decode(CaptureHistorySummary.self, from: JSONEncoder().encode(draft))
                let direct = CaptureHistorySummary(draft: draft)
                XCTAssertEqual(projected.id, draft.id)
                XCTAssertEqual(projected.input, draft.input)
                XCTAssertEqual(projected.title, direct.title)
                XCTAssertEqual(projected.imageURL, URL(string: "https://example.test/large.jpg"))
                XCTAssertEqual(projected.selection, draft.selection)
                XCTAssertEqual(projected.deliveryState, draft.deliveryState)
                XCTAssertEqual(projected.isActiveCapture, draft.isActiveCapture)
                XCTAssertEqual(projected.isDraftCapture, draft.isDraftCapture)
                XCTAssertEqual(projected.hasUserEdits, draft.hasUserEdits)
                XCTAssertTrue(projected.hasProblem)
            }
        }
    }

    @MainActor func testLargeHistoryKeepsOldActiveWorkVisibleAndSourceReceiptsUnchanged() throws {
        try fixture { store, url in
            var active = populatedDraft(index: 0)
            active.phase = .checking
            active.deliveryState = .init(operationID: active.id, stage: .attention)
            try store.transaction {
                try store.save(active, account: 42, kind: "draft", id: active.id.uuidString)
                for index in 1...140 {
                    var draft = populatedDraft(index: index)
                    draft.phase = .saved
                    try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
                }
            }
            let cold = try CaptureStore(url: url)
            let summaries = try cold.captureHistorySummaries(account: 42, limit: 101)
            XCTAssertEqual(summaries.count, 101)
            XCTAssertEqual(try store.activeCaptureCount(account: 42), 1)
            XCTAssertEqual(try store.captureHistorySummaries(account: 42, activeOnly: true, limit: 1).map(\.id), [active.id])
            XCTAssertEqual(try store.captureHistory(account: 42, activeOnly: true, limit: 1).map(\.id), [active.id])
            XCTAssertTrue(try store.captureHistorySummaries(account: 99).isEmpty)
            XCTAssertEqual(try store.activeCaptureCount(account: 99), 0)
            _ = try store.archiveExpiredAutomaticDrafts(account: 42)
            let retained = try XCTUnwrap(store.value(CaptureDraft.self, account: 42, kind: "draft", id: active.id.uuidString))
            XCTAssertEqual(retained.previewSnapshot?.plan, active.previewSnapshot?.plan)
            XCTAssertEqual(retained.savedBlock, active.savedBlock)
            XCTAssertEqual(retained.substackCapturesJSON, active.substackCapturesJSON)
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "draft").count, 141)
        }
    }

    @MainActor func testSharedWriterAndReopenedConnectionInvalidateChangedSummaries() throws {
        try fixture { app, url in
            let share = try CaptureStore(url: url)
            var draft = populatedDraft(index: 1); draft.phase = .queued
            try share.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            XCTAssertEqual(try app.activeCaptureCount(account: 42), 1)
            draft.phase = .saved; draft.titleOverride = "Saved through Share"
            draft.savedBlock = nil; draft.previewSnapshot = nil
            try share.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            XCTAssertEqual(try app.activeCaptureCount(account: 42), 0)
            XCTAssertEqual(try app.captureHistorySummaries(account: 42).first?.title, "Saved through Share")
            XCTAssertTrue(app.releaseIdleConnection())
            draft.phase = .checking
            try share.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            XCTAssertEqual(try app.activeCaptureCount(account: 42), 1)
            try share.remove(account: 42, kind: "draft", id: draft.id.uuidString)
            XCTAssertEqual(try app.activeCaptureCount(account: 42), 0)
            XCTAssertTrue(try app.captureHistorySummaries(account: 42).isEmpty)
        }
    }

    @MainActor func testRolledBackWritesDoNotChangeActiveCountOrRetention() throws {
        enum Abort: Error { case requested }
        try fixture { store, _ in
            var draft = populatedDraft(index: 1); draft.phase = .checking
            try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            XCTAssertEqual(try store.activeCaptureCount(account: 42), 1)
            XCTAssertThrowsError(try store.transaction {
                draft.phase = .saved
                try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
                XCTAssertEqual(try store.activeCaptureCount(account: 42), 0)
                throw Abort.requested
            })
            XCTAssertEqual(try store.activeCaptureCount(account: 42), 1)
            XCTAssertThrowsError(try store.transaction {
                try store.remove(account: 42, kind: "draft", id: draft.id.uuidString)
                XCTAssertEqual(try store.activeCaptureCount(account: 42), 0)
                throw Abort.requested
            })
            XCTAssertEqual(try store.activeCaptureCount(account: 42), 1)
            XCTAssertEqual(try store.archiveExpiredAutomaticDrafts(account: 42, now: .distantFuture), [])
        }
    }

    @MainActor func testSummaryDeletionEligibilityUsesDurableJobPresenceAndStage() throws {
        try fixture { store, _ in
            var draft = populatedDraft(index: 1)
            XCTAssertTrue(try store.canDeleteDraft(CaptureHistorySummary(draft: draft)))
            try store.save(["stage": "attention"], account: 0, kind: "delivery", id: draft.id.uuidString)
            XCTAssertFalse(try store.canDeleteDraft(CaptureHistorySummary(draft: draft)))
            draft.phase = .saved
            XCTAssertFalse(try store.canDeleteDraft(CaptureHistorySummary(draft: draft)))
            try store.save(["stage": "done"], account: 0, kind: "delivery", id: draft.id.uuidString)
            XCTAssertTrue(try store.canDeleteDraft(CaptureHistorySummary(draft: draft)))
        }
    }

    @MainActor func testCanceledCapturesStayInHistoryAcrossColdReadAndDoNotExpire() throws {
        try fixture { store, url in
            var draft = populatedDraft(index: 1)
            draft.phase = .saved; draft.updatedAt = .distantPast
            draft.deliveryState = .init(operationID: draft.id, stage: .done)
            draft.deliveryState?.canceledAt = Date()
            try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            let reopened = try CaptureStore(url: url)
            let summary = try XCTUnwrap(reopened.captureHistorySummaries(account: 42).first)
            XCTAssertTrue(summary.isCanceled)
            XCTAssertFalse(summary.isActiveCapture)
            XCTAssertFalse(summary.isDraftCapture)
            XCTAssertFalse(summary.isUnsubmittedDraft)
            XCTAssertTrue(draft.isCanceled)
            XCTAssertFalse(draft.isActiveCapture)
            XCTAssertEqual(try reopened.activeCaptureCount(account: 42), 0)
            XCTAssertEqual(try reopened.captureHistorySummaries(account: 42, activeOnly: false).map(\.id), [draft.id])
            XCTAssertEqual(try reopened.archiveExpiredAutomaticDrafts(account: 42, now: .distantFuture), [])
            try store.save(["transferID": "pending-canceled-request"], account: 0, kind: "canceledDelivery", id: draft.id.uuidString)
            XCTAssertFalse(try reopened.canDeleteDraft(summary))
            XCTAssertFalse(try reopened.canDeleteDraft(draft))
            try store.save(["transferID": String?.none], account: 0, kind: "canceledDelivery", id: draft.id.uuidString)
            XCTAssertTrue(try reopened.canDeleteDraft(summary))
        }
    }

    @MainActor func testPendingCanceledTransferProtectsDraftAfterOlderReaderStripsCancellationMetadata() throws {
        try fixture { store, url in
            var draft = populatedDraft(index: 1)
            draft.phase = .saved
            draft.deliveryState = .init(operationID: draft.id, stage: .done)
            draft.deliveryState?.canceledAt = Date()
            try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            try store.save(["transferID": "awaiting-canceled-request-receipt"], account: 0, kind: "canceledDelivery", id: draft.id.uuidString)

            // A rollback-compatible older app can decode the draft, then encode
            // it again without the optional cancellation field it did not know.
            draft.deliveryState?.canceledAt = nil
            let olderWriter = try CaptureStore(url: url)
            try olderWriter.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
            let summary = try XCTUnwrap(store.captureHistorySummaries(account: 42).first)
            XCTAssertFalse(summary.isCanceled)
            XCTAssertFalse(try store.canDeleteDraft(summary))
            XCTAssertFalse(try store.canDeleteDraft(draft))
            XCTAssertThrowsError(try store.deleteDrafts([draft.id], account: 42))
            XCTAssertNotNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString))
            XCTAssertNil(try store.value(DeletedCapture.self, account: 42, kind: "deletedDraft", id: draft.id.uuidString))
            XCTAssertNotNil(try store.value([String: String].self, account: 0, kind: "canceledDelivery", id: draft.id.uuidString))

            try olderWriter.save(["transferID": String?.none], account: 0, kind: "canceledDelivery", id: draft.id.uuidString)
            XCTAssertTrue(try store.canDeleteDraft(summary))
        }
    }

    private var image: JSONValue { .object(["large": .object(["url": .string("https://example.test/large.jpg")])]) }

    private func populatedDraft(index: Int) -> CaptureDraft {
        var draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.test/source/\(index)")
        let media = (0..<24).map { mediaIndex in
            JSONValue.object(["ref": .string("media-\(mediaIndex)"), "url": .string("https://example.test/image/\(mediaIndex).jpg"),
                              "alt": .string("Original description"), "metadata": .object(["width": .number(1200), "height": .number(800)])])
        }
        draft.substackCapturesJSON = String(repeating: "Original source record with retained text. ", count: 1200)
        draft.previewSnapshot = .init(kind: "social", url: draft.input, plan: .object([
            "block": .object(["title": .string("Source \(index)"), "markdown": .string(String(repeating: "Complete writing\n", count: 400))]),
            "sources": .array([.object(["media": .array(media), "raw": .object(["retained": .bool(true)])])])]))
        draft.savedBlock = .object(["title": .string("Saved \(index)"), "image": image,
                                    "content": .string("Complete block writing"), "connections": .array([.object(["id": .number(100 + Double(index))])])])
        return draft
    }

    @MainActor private func fixture(_ body: (CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-summary-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("capture.sqlite")
        try body(CaptureStore(url: url), url)
    }
}
