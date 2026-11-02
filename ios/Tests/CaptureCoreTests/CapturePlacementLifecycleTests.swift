import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureUI

final class CapturePlacementLifecycleTests: XCTestCase {
    @MainActor func testAddingWhileConnectingKeepsLogicalCaptureAndLateResultUsesLatestSelection() throws {
        try fixture { delivery, store, _ in
            let original = try seed(store, stage: .connect, channels: [101, 102], connected: [101], attempted: [101])
            let reserved = try XCTUnwrap(delivery.reserveTransfer(original, transferID: "in-flight-102"))
            XCTAssertEqual(reserved.attemptedChannelIDs, [101, 102])
            let chosen = selection([101, 102, 103])
            XCTAssertEqual(try delivery.amendPlacements(original.id, account: 42, selection: chosen, baseline: original.draft.selection), original.id)
            XCTAssertNil(try delivery.reserveTransfer(original, transferID: "stale-dispatch"))
            let accepted = try XCTUnwrap(delivery.accept(response(.object([:])), id: original.id, transferID: "in-flight-102"))
            XCTAssertEqual(accepted.draft.selection.channels.map(\.id), [101, 102, 103])
            XCTAssertEqual(accepted.stage, .connections)
            var checked = try XCTUnwrap(delivery.acceptForTest(try members([101, 102]), source: accepted, transfer: "scan"))
            XCTAssertEqual(checked.stage, .connect)
            XCTAssertTrue(delivery.preparePlacementValidation(&checked))
            XCTAssertEqual(try delivery.request(checked, token: "fixture").request.url?.path, "/v3/channels/103")
            delivery.consume(try response(.object(["id": .number(103), "can": .object(["add_to": .bool(true)])])), job: &checked)
            XCTAssertEqual(try body(delivery.request(checked, token: "fixture").body)["channel_ids"], .array([.number(103)]))
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "draft"), [original.id.uuidString])
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "placementChange").count, 1)
            XCTAssertEqual(checked.draft.blockID, 900)
        }
    }

    @MainActor func testUnsentRemovalDuringPermissionReadCannotAttributeResponseToNewTarget() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .connect, channels: [101, 102], connected: [101], attempted: [101])
            XCTAssertTrue(delivery.preparePlacementValidation(&job))
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            let reserved = try XCTUnwrap(delivery.reserveTransfer(job, transferID: "permission-102"))
            XCTAssertEqual(try delivery.request(reserved, token: "fixture").request.url?.path, "/v3/channels/102")
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 103]), baseline: job.draft.selection)
            var accepted = try XCTUnwrap(delivery.accept(try response(.object(["id": .number(102), "can": .object(["add_to": .bool(true)])])), id: job.id, transferID: "permission-102"))
            XCTAssertEqual(accepted.draft.selection.channels.map(\.id), [101, 103])
            XCTAssertNil(accepted.validatedChannelIDs)
            XCTAssertTrue(delivery.preparePlacementValidation(&accepted))
            XCTAssertEqual(try delivery.request(accepted, token: "fixture").request.url?.path, "/v3/channels/103")
            delivery.consume(try response(.object(["id": .number(103), "can": .object(["add_to": .bool(false)])])), job: &accepted)
            XCTAssertEqual(accepted.stage, .attention)
            XCTAssertFalse(accepted.validatedChannelIDs?.contains(103) == true)
        }
    }

    @MainActor func testFailedPermissionReadForRemovedUnsentChoiceDoesNotFailRemainingSelection() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .connect, channels: [101, 102], connected: [101], attempted: [101])
            XCTAssertTrue(delivery.preparePlacementValidation(&job))
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            _ = try delivery.reserveTransfer(job, transferID: "removed-permission")
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 103]))
            var current = try XCTUnwrap(delivery.accept(.init(status: 403, body: Data(), error: nil, retryAfter: nil), id: job.id, transferID: "removed-permission"))
            XCTAssertEqual(current.stage, .connect); XCTAssertNil(current.problem)
            XCTAssertTrue(delivery.preparePlacementValidation(&current))
            XCTAssertEqual(current.placementValidationID, 103)
        }
    }

    @MainActor func testRemovingLastUnsentTargetReconcilesWithoutEmptyConnectionPost() throws {
        try fixture { delivery, store, _ in
            let original = try seed(store, stage: .connect, channels: [101, 102], connected: [101], attempted: [101])
            _ = try delivery.amendPlacements(original.id, account: 42, selection: selection([101]))
            var current = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString))
            XCTAssertThrowsError(try delivery.request(current, token: "fixture"))
            XCTAssertNil(try delivery.reserveTransfer(current, transferID: "empty-post"))
            XCTAssertTrue(delivery.preparePlacementValidation(&current))
            XCTAssertEqual(current.stage, .connections)
            XCTAssertEqual(try delivery.request(current, token: "fixture").request.httpMethod, "GET")
            let done = try XCTUnwrap(delivery.acceptForTest(try members([101]), source: current, transfer: "cancel-readback"))
            XCTAssertEqual(done.stage, .done)
            XCTAssertEqual(done.draft.id, original.id)
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "draft").count, 1)
            XCTAssertEqual(done.draft.selection.channels.map(\.id), [101])
        }
    }

    @MainActor func testStaleDestinationFailureResumeMarkerDoesNotBlockLaterValidEdits() throws {
        try fixture { delivery, store, _ in
            var original = try seed(store, stage: .connect, channels: [101, 102], connected: [101], attempted: [101])
            original.resumeStage = .destinations // Retained marker from an already recovered GET.
            try store.save(original, account: 0, kind: "delivery", id: original.id.uuidString)
            XCTAssertNoThrow(try delivery.amendPlacements(original.id, account: 42, selection: selection([101, 102, 103])))
        }
    }

    @MainActor func testAttemptedRemovalIsRejectedAtomicallyAndUnrelatedConnectionsDoNotBlockAddition() throws {
        try fixture { delivery, store, _ in
            let job = try seed(store, stage: .connect, channels: [101, 102], connected: [101, 999], attempted: [101, 102])
            XCTAssertEqual(try delivery.protectedPlacementIDs(job.id, account: 42), [101, 102])
            XCTAssertThrowsError(try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 103])))
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "placementChange").count, 0)
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 102, 103]))
            let current = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(current.connected, [101, 999])
            XCTAssertEqual(current.draft.selection.channels.map(\.id), [101, 102, 103])
        }
    }

    @MainActor func testTwoPickersRebaseDeltasAndDeduplicateInsteadOfReplacingConcurrentChoice() throws {
        try fixture { delivery, store, _ in
            let job = try seed(store, stage: .connections, channels: [101], connected: [101], attempted: [101])
            let baseline = job.draft.selection
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 102]), baseline: baseline)
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 103]), baseline: baseline)
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 102]), baseline: baseline)
            let current = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(current.draft.selection.channels.map(\.id), [101, 102, 103])
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "placementChange").count, 2)
            XCTAssertThrowsError(try delivery.amendPlacements(job.id, account: 99, selection: selection([101, 104])))
            XCTAssertEqual(try store.recordIDs(account: 99, kind: "draft"), [])
        }
    }

    @MainActor func testCompletionRaceReopensSameCaptureReadOnlyAndRetainsImmutableReceiptAndAudit() throws {
        try fixture { delivery, store, url in
            let job = try seed(store, stage: .connections, channels: [101], connected: [101], attempted: [101])
            let editor = try XCTUnwrap(job.draft.addingPlacements())
            XCTAssertEqual(editor.id, job.id)
            let completed = try XCTUnwrap(delivery.acceptForTest(try members([101]), source: job, transfer: "finish"))
            XCTAssertEqual(completed.stage, .done)
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "deliveryReceipt").count, 1)
            _ = try delivery.amendPlacements(editor.id, account: 42, selection: selection([101, 102]), baseline: editor.selection)
            let reopened = try CaptureStore(url: url)
            var next = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(next.id, job.id); XCTAssertNotNil(next.receiptID)
            XCTAssertEqual(next.draft.blockID, 900); XCTAssertNil(next.submission); XCTAssertNil(next.mediaPath)
            XCTAssertTrue(next.prepared.update.isEmpty); XCTAssertTrue(next.prepared.payload.isEmpty)
            XCTAssertEqual(try delivery.request(next, token: "fixture").request.url?.path, "/v3/blocks/900")
            delivery.consume(try response(.object(["id": .number(900), "state": .string("available"), "title": .string("Edited remotely")])), job: &next)
            XCTAssertEqual(next.stage, .connections); XCTAssertEqual(next.block?["title"]?.string, "Edited remotely")
            for stage in [CaptureDeliveryStage.create, .update, .presign, .upload] {
                var forbidden = next; forbidden.stage = stage
                XCTAssertThrowsError(try delivery.request(forbidden, token: "fixture"))
            }
            let eventID = try XCTUnwrap(reopened.recordIDs(account: 42, kind: "placementChange").first)
            let event = try XCTUnwrap(reopened.value(CapturePlacementChange.self, account: 42, kind: "placementChange", id: eventID))
            XCTAssertEqual(event.captureID, job.id); XCTAssertEqual(event.before.phase, .saved)
            XCTAssertEqual(event.before.deliveryState?.stage, .done)
            XCTAssertEqual(try reopened.recordIDs(account: 42, kind: "draft"), [job.id.uuidString])
        }
    }

    @MainActor func testAmbiguousAddedPlacementReconcilesAndNeverRepeatsOrCreates() throws {
        try fixture { delivery, store, _ in
            let job = try seed(store, stage: .connect, channels: [101, 102], connected: [101], attempted: [101])
            let reserved = try XCTUnwrap(delivery.reserveTransfer(job, transferID: "post-102"))
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 102, 103]))
            let uncertain = try XCTUnwrap(delivery.accept(.init(status: nil, body: Data(), error: "lost after send", retryAfter: nil), id: job.id, transferID: "post-102"))
            XCTAssertEqual(uncertain.stage, .connections)
            let stopped = try XCTUnwrap(delivery.acceptForTest(try members([101]), source: uncertain, transfer: "readback"))
            XCTAssertEqual(stopped.stage, .attention)
            XCTAssertTrue(stopped.problem?.contains("unconfirmed") == true)
            XCTAssertEqual(stopped.draft.blockID, 900)
            XCTAssertEqual(stopped.attemptedChannelIDs, reserved.attemptedChannelIDs)
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "draft").count, 1)
        }
    }

    @MainActor func testPausedAmendmentDoesNotResumeAndFullScanReplacesStaleConfirmation() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .attention, channels: [101, 102], connected: [101, 102], attempted: [101, 102])
            job.stopRequestedAt = Date(); job.resumeStage = .connections
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            _ = try delivery.amendPlacements(job.id, account: 42, selection: selection([101, 102, 103]))
            var paused = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(paused.stage, .attention); XCTAssertNotNil(paused.stopRequestedAt)
            paused.stage = .connections
            delivery.consume(try members([101]), job: &paused)
            XCTAssertEqual(paused.connected, [101]); XCTAssertEqual(paused.stage, .attention)
            XCTAssertNotNil(paused.stopRequestedAt)
        }
    }

    @MainActor func testLaterAdditionsDoNotRestoreAConnectionRemovedOutsideCapture() throws {
        try fixture { delivery, store, _ in
            let original = try seed(store, stage: .connections, channels: [101], connected: [101], attempted: [101])
            _ = try XCTUnwrap(delivery.acceptForTest(try members([101]), source: original, transfer: "first-finish"))
            _ = try delivery.amendPlacements(original.id, account: 42, selection: selection([101, 102]), baseline: original.draft.selection)
            var next = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString))
            XCTAssertEqual(next.requiredChannelIDs, [102])
            delivery.consume(try response(.object(["id": .number(900), "state": .string("available")])), job: &next)
            delivery.consume(try members([]), job: &next) // 101 was removed in Are.na.
            XCTAssertEqual(next.stage, .connect)
            XCTAssertEqual(next.draft.selection.channels.map(\.id), [102])
            XCTAssertEqual(try body(delivery.request(next, token: "fixture").body)["channel_ids"], .array([.number(102)]))
            next.stage = .connections
            let finished = try XCTUnwrap(delivery.acceptForTest(try members([102]), source: next, transfer: "second-finish"))
            XCTAssertEqual(finished.stage, .done)
            XCTAssertEqual(finished.draft.selection.channels.map(\.id), [102])
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "deliveryReceipt").count, 2)
            let eventID = try XCTUnwrap(store.recordIDs(account: 42, kind: "placementChange").first)
            XCTAssertEqual(try store.value(CapturePlacementChange.self, account: 42, kind: "placementChange", id: eventID)?.before.selection.channels.map(\.id), [101])
        }
    }

    @MainActor func testCompletedCaptureRetainsTwentyPlacementsAndCanAddTwentyMorePerAmendment() throws {
        try fixture { delivery, store, _ in
            let oldIDs = Array(101...120), newIDs = Array(121...140)
            let original = try seed(store, stage: .connections, channels: oldIDs, connected: Set(oldIDs), attempted: oldIDs)
            _ = try XCTUnwrap(delivery.acceptForTest(try members(oldIDs), source: original, transfer: "initial-twenty"))
            _ = try delivery.amendPlacements(original.id, account: 42, selection: selection(oldIDs + newIDs), baseline: original.draft.selection)
            let next = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString))
            XCTAssertEqual(next.draft.selection.channels.count, 40)
            XCTAssertEqual(next.requiredChannelIDs, Set(newIDs))
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "draft").count, 1)
            XCTAssertThrowsError(try delivery.amendPlacements(original.id, account: 42, selection: selection(oldIDs + Array(121...141)), baseline: original.draft.selection))
        }
    }

    @MainActor func testStaleContinuedCycleCannotStopOrReleaseNewPlacementCycle() throws {
        try fixture { delivery, store, _ in
            let original = try seed(store, stage: .connections, channels: [101], connected: [101], attempted: [101])
            XCTAssertTrue(try delivery.beginContinued(original.id, receiptID: original.id))
            let first = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString))
            XCTAssertTrue(try delivery.beginContinued(original.id, receiptID: original.id))
            XCTAssertEqual(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString)?.revision, first.revision)
            _ = try XCTUnwrap(delivery.acceptForTest(try members([101]), source: first, transfer: "old-done"))
            _ = try delivery.amendPlacements(original.id, account: 42, selection: selection([101, 102]))
            let newReceipt = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString)?.receiptID)
            XCTAssertNotEqual(newReceipt, original.id)
            XCTAssertTrue(try delivery.beginContinued(original.id, receiptID: newReceipt))
            XCTAssertFalse(try delivery.beginContinued(original.id, receiptID: original.id))
            try delivery.endContinued(original.id, receiptID: original.id)
            try delivery.requestStop(original.id, receiptID: original.id)
            let current = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString))
            XCTAssertNotNil(current.continuedRequestedAt)
            XCTAssertNil(current.stopRequestedAt)
            XCTAssertEqual(current.receiptID, newReceipt)
        }
    }

    @MainActor private func fixture(_ body: (CaptureDelivery, CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("capture.sqlite")
        let store = try CaptureStore(url: url)
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        try body(delivery, store, url)
    }
    @MainActor private func seed(_ store: CaptureStore, stage: CaptureDeliveryStage, channels: [Int], connected: Set<Int>, attempted: [Int]) throws -> DeliveryJob {
        var draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.test/original")
        draft.selection = selection(channels); draft.phase = .checking; draft.blockID = 900
        let block = JSONValue.object(["id": .number(900), "state": .string("available"), "title": .string("Original title")])
        let job = DeliveryJob(id: draft.id, draft: draft, prepared: .init(payload: ["title": .string("Original title")], update: [:]), attemptedChannelIDs: attempted, contentVerified: true, stage: stage, connected: connected, block: block)
        draft.deliveryState = job.state; draft.savedBlock = block
        var seeded = job; seeded.draft = draft
        try store.save(draft, account: 42, kind: "draft", id: draft.id.uuidString)
        try store.save(seeded, account: 0, kind: "delivery", id: job.id.uuidString)
        return seeded
    }
    private func selection(_ ids: [Int]) -> DestinationSelection {
        var result = DestinationSelection(defaultChannel: nil)
        for id in ids { result.toggle(Channel(id: id, title: "Channel \(id)", slug: "channel-\(id)", visibility: "private", owner: .init(id: 42, name: "Fixture", slug: "fixture", type: "User")), maxCount: Int.max) }
        return result
    }
    private func response(_ value: JSONValue) throws -> BackgroundHTTPResult {
        .init(status: 200, body: try JSONEncoder().encode(value), error: nil, retryAfter: nil)
    }
    private func members(_ ids: [Int]) throws -> BackgroundHTTPResult {
        try response(.object(["data": .array(ids.map { .object(["id": .number(Double($0))]) }), "meta": .object(["has_more_pages": .bool(false)])]))
    }
    private func body(_ data: Data?) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(data)) }
}

private extension CaptureDelivery {
    func acceptForTest(_ result: BackgroundHTTPResult, source: DeliveryJob, transfer: String) throws -> DeliveryJob? {
        var source = source; source.transferID = transfer
        try store.save(source, account: 0, kind: "delivery", id: source.id.uuidString)
        return try accept(result, id: source.id, transferID: transfer)
    }
}
