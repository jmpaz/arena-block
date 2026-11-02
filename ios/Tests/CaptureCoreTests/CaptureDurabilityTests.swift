import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureUI

final class CaptureDurabilityTests: XCTestCase {
    @MainActor func testCancellationIsDurableBeforeAStaleRequestCanReserve() throws {
        try fixture { delivery, store, url in
            let job = try seed(store, stage: .queued, attempted: [], block: nil)
            try delivery.cancel(job.id, accountID: 42)
            let reopened = try CaptureStore(url: url)
            let canceled = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: job.id.uuidString))
            XCTAssertNotNil(canceled.canceledAt)
            XCTAssertNotNil(canceled.stopRequestedAt)
            XCTAssertNil(try reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "stale"))
            XCTAssertFalse(canceled.state.canceledWithUnconfirmedRequest ?? true)
            XCTAssertTrue(canceled.problem?.contains("No block was created") == true)
            XCTAssertNil(try reopened.value(DeliveryJob.self, account: 42, kind: "deliveryReceipt", id: job.id.uuidString))
            XCTAssertThrowsError(try delivery.persistQueuedSubmission(draft: job.draft))
            try delivery.cancel(job.id, accountID: 42)
            XCTAssertEqual(try reopened.recordIDs(account: 0, kind: "canceledDelivery"), [job.id.uuidString])
        }
    }

    @MainActor func testLateCreateReceiptEnrichesCanceledCaptureWithoutCompletingOrRetrying() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .create, attempted: [101], block: nil)
            job.transferID = "create"; job.transferSession = "test.delivery"
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            try delivery.cancel(job.id, accountID: 42)
            let before = try XCTUnwrap(store.value(CaptureDraft.self, account: 42, kind: "draft", id: job.id.uuidString))
            XCTAssertEqual(before.deliveryState?.canceledWithUnconfirmedRequest, true)
            let receipt = try XCTUnwrap(delivery.accept(try response(.object(["id": .number(900)]), status: 201), id: job.id, transferID: "create"))
            XCTAssertEqual(receipt.draft.blockID, 900)
            XCTAssertNotNil(receipt.canceledAt)
            XCTAssertEqual(receipt.connected, [])
            XCTAssertNil(receipt.transferID)
            XCTAssertThrowsError(try delivery.request(receipt, token: "fixture"))
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "duplicate"))
            XCTAssertNil(try store.value(DeliveryJob.self, account: 42, kind: "deliveryReceipt", id: job.id.uuidString))
            XCTAssertNil(try delivery.accept(try response(.object(["id": .number(901)])), id: job.id, transferID: "create"))
        }
    }

    @MainActor func testCancellationRetainsConfirmedConnectionsAndAcceptsOnlyAlreadySentCompleteReadback() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .connections, attempted: [101, 102], connected: [101])
            job.transferID = "readback"; job.transferSession = "test.delivery"
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            try delivery.cancel(job.id, accountID: 42)
            let canceled = try XCTUnwrap(delivery.accept(try members([101, 102]), id: job.id, transferID: "readback"))
            XCTAssertEqual(canceled.connected, [101, 102])
            XCTAssertEqual(canceled.confirmedOnceChannelIDs, [101, 102])
            XCTAssertNotNil(canceled.canceledAt)
            let fact = CaptureContinuedProgress(state: canceled.state, selectedChannelIDs: [101, 102])
            XCTAssertTrue(fact.isCanceled); XCTAssertTrue(fact.isTerminal); XCTAssertFalse(fact.isDone)
            XCTAssertEqual(fact.subtitle, "2 of 2 channels confirmed")
            XCTAssertNil(try delivery.continuationTargets(job.id))
            XCTAssertFalse(try delivery.reaffirmContinuation(job.id, channelIDs: [101, 102]))
        }
    }

    @MainActor func testCancelLegacyUnknownAndOrphanDraftNeverClaimsNoBlockWasCreated() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .attention, attempted: nil, block: nil)
            job.draft.phase = .uncertain; job.resumeStage = nil
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            try delivery.cancel(job.id, accountID: 42)
            let canceled = try XCTUnwrap(store.value(CaptureDraft.self, account: 42, kind: "draft", id: job.id.uuidString))
            XCTAssertEqual(canceled.deliveryState?.canceledWithUnconfirmedRequest, true)
            XCTAssertFalse(canceled.problem?.contains("No block was created") == true)

            var orphan = CaptureDraft(accountID: 42, defaultChannel: channel(101), input: "https://example.test/orphan")
            orphan.phase = .uncertain
            let receiptID = UUID()
            orphan.deliveryState = .init(operationID: orphan.id, receiptID: receiptID, stage: .attention)
            try store.save(orphan, account: 42, kind: "draft", id: orphan.id.uuidString)
            try delivery.cancel(orphan.id, accountID: 42)
            let retained = try XCTUnwrap(store.value(CaptureDraft.self, account: 42, kind: "draft", id: orphan.id.uuidString))
            XCTAssertNotNil(retained.deliveryState?.canceledAt)
            XCTAssertEqual(retained.deliveryState?.canceledWithUnconfirmedRequest, true)
            XCTAssertEqual(retained.deliveryState?.receiptID, receiptID)
        }
    }

    @MainActor func testCanceledLateReceiptUpdatesDeletedSnapshotWithoutResurrectingCapture() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .create, attempted: [101], block: nil)
            job.transferID = "create"
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            try delivery.cancel(job.id, accountID: 42)
            let canceled = try XCTUnwrap(store.value(CaptureDraft.self, account: 42, kind: "draft", id: job.id.uuidString))
            try store.save(DeletedCapture(draft: canceled), account: 42, kind: "deletedDraft", id: job.id.uuidString)
            try store.remove(account: 42, kind: "draft", id: job.id.uuidString)
            _ = try delivery.accept(try response(.object(["id": .number(900)])), id: job.id, transferID: "create")
            XCTAssertNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: job.id.uuidString))
            let deleted = try XCTUnwrap(store.value(DeletedCapture.self, account: 42, kind: "deletedDraft", id: job.id.uuidString))
            XCTAssertEqual(deleted.draft.blockID, 900)
            XCTAssertNotNil(deleted.draft.deliveryState?.canceledAt)
        }
    }

    @MainActor func testCancelReleasesOnlyProvenUnsentPublicationAndKnownBlockIsReused() throws {
        try fixture { delivery, store, _ in
            var unsent = try seed(store, stage: .rendering, attempted: [], block: nil)
            unsent.draft.publicationKey = "unsent"
            XCTAssertTrue(try store.reservePublication(account: 42, key: "unsent", draftID: unsent.id))
            try store.save(unsent, account: 0, kind: "delivery", id: unsent.id.uuidString)
            try delivery.cancel(unsent.id, accountID: 42)
            XCTAssertTrue(try store.reservePublication(account: 42, key: "unsent", draftID: UUID()))

            var unknown = try seed(store, stage: .create, attempted: [101], block: nil)
            unknown.draft.publicationKey = "unknown"; unknown.transferID = "create"
            XCTAssertTrue(try store.reservePublication(account: 42, key: "unknown", draftID: unknown.id))
            try store.save(unknown, account: 0, kind: "delivery", id: unknown.id.uuidString)
            try delivery.cancel(unknown.id, accountID: 42)
            XCTAssertFalse(try store.reservePublication(account: 42, key: "unknown", draftID: UUID()))
            _ = try delivery.accept(try response(.object(["id": .number(900)])), id: unknown.id, transferID: "create")
            XCTAssertEqual(try store.value(Int.self, account: 42, kind: "published", id: "unknown"), 900)
            XCTAssertTrue(try store.reservePublication(account: 42, key: "unknown", draftID: UUID()))
        }
    }

    @MainActor func testAmbiguousPlacementReadbackNeverAuthorizesAutomaticReplay() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .connections, attempted: [101, 102], connected: [101])
            delivery.consume(try members([101]), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertThrowsError(try delivery.request(job, token: "fixture"))
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            XCTAssertEqual(try delivery.continuationTargets(job.id), [102])
            XCTAssertFalse(try delivery.reaffirmContinuation(job.id, channelIDs: []))
            XCTAssertFalse(try delivery.reaffirmContinuation(job.id, channelIDs: [103]))
            XCTAssertTrue(try delivery.reaffirmContinuation(job.id, channelIDs: [102]))
            var reaffirmed = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(reaffirmed.stage, .connections)
            XCTAssertEqual(try delivery.request(reaffirmed, token: "fixture").request.httpMethod, "GET")
            delivery.consume(try members([101]), job: &reaffirmed)
            XCTAssertEqual(reaffirmed.stage, .connect)
            XCTAssertTrue(delivery.preparePlacementValidation(&reaffirmed))
            XCTAssertEqual(try delivery.request(reaffirmed, token: "fixture").request.url?.path, "/v3/channels/102")
            delivery.consume(try response(.object(["id": .number(102), "can": .object(["add_to": .bool(true)])])), job: &reaffirmed)
            try store.save(reaffirmed, account: 0, kind: "delivery", id: job.id.uuidString)
            let reserved = try XCTUnwrap(delivery.reserveTransfer(reaffirmed, transferID: "explicit-retry"))
            XCTAssertEqual(reserved.draft.blockID, 900)
            XCTAssertEqual(reserved.connectionRetryCounts?[102], 1)
            XCTAssertFalse(reserved.reaffirmedChannelIDs?.contains(102) == true)
            let request = try delivery.request(reserved, token: "fixture")
            XCTAssertEqual(request.request.url?.path, "/v3/connections")
            let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.body))
            XCTAssertEqual(body["channel_ids"], .array([.number(102)]))
            XCTAssertEqual(body["connectable_id"], .number(900))
            var lost = try XCTUnwrap(delivery.accept(.init(status: nil, body: Data(), error: "Lost response", retryAfter: nil), id: job.id, transferID: "explicit-retry"))
            delivery.consume(try members([101]), job: &lost)
            XCTAssertEqual(lost.stage, .attention)
            XCTAssertEqual(lost.attemptedChannelIDs, [101, 102])
        }
    }

    @MainActor func testPreviouslyConfirmedRemovalIsNeverRecreatedEvenWithReaffirmation() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .connections, attempted: [101, 102], connected: [101, 102])
            delivery.consume(try members([101]), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.confirmedOnceChannelIDs, [101, 102])
            XCTAssertTrue(job.problem?.contains("left removed") == true)
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            XCTAssertNil(try delivery.continuationTargets(job.id))
            XCTAssertFalse(try delivery.reaffirmContinuation(job.id, channelIDs: [102]))
        }
    }

    @MainActor func testFirstAttemptConsumesContinuationConsentBeforeAnAmbiguousReply() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .attention, attempted: [101], connected: [101])
            job.stopRequestedAt = Date(); job.resumeStage = .connections
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            XCTAssertTrue(try delivery.reaffirmContinuation(job.id, channelIDs: [102]))
            var resumed = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            delivery.consume(try members([101]), job: &resumed)
            try store.save(resumed, account: 0, kind: "delivery", id: job.id.uuidString)
            let reserved = try XCTUnwrap(delivery.reserveTransfer(resumed, transferID: "first-102"))
            XCTAssertFalse(reserved.reaffirmedChannelIDs?.contains(102) == true)
            var lost = try XCTUnwrap(delivery.accept(.init(status: nil, body: Data(), error: "Lost response", retryAfter: nil), id: job.id, transferID: "first-102"))
            delivery.consume(try members([101]), job: &lost)
            XCTAssertEqual(lost.stage, .attention)
            XCTAssertFalse(lost.reaffirmedChannelIDs?.contains(102) == true)
        }
    }

    @MainActor func testCancellationTombstoneFencesOldReaderWhichDroppedOptionalMetadata() throws {
        try fixture { delivery, store, _ in
            let job = try seed(store, stage: .connect, attempted: [101], connected: [101])
            try delivery.cancel(job.id, accountID: 42)
            var old = job.draft; old.phase = .saved
            old.deliveryState = .init(operationID: old.id, stage: .done, confirmedChannelIDs: [101], contentVerified: true)
            try store.save(old, account: 42, kind: "draft", id: old.id.uuidString)
            XCTAssertThrowsError(try delivery.amendPlacements(old.id, account: 42, selection: old.selection))
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "old-reader"))
            XCTAssertFalse(try delivery.hasPendingWork())
            try delivery.cancel(job.id, accountID: 42)
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertNotNil(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: job.id.uuidString)?.deliveryState?.canceledAt)
        }
    }

    @MainActor func testLatePrecreateReceiptCannotReleaseAnotherCapturesPublicationReservation() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .upload, attempted: [], block: nil)
            job.draft.publicationKey = "same-material"; job.transferID = "upload"
            XCTAssertTrue(try store.reservePublication(account: 42, key: "same-material", draftID: job.id))
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            try delivery.cancel(job.id, accountID: 42)
            let newer = UUID()
            XCTAssertTrue(try store.reservePublication(account: 42, key: "same-material", draftID: newer))
            _ = try delivery.accept(.init(status: 200, body: Data(), error: nil, retryAfter: nil), id: job.id, transferID: "upload")
            XCTAssertEqual(try store.value(UUID.self, account: 42, kind: "publicationLock", id: "same-material"), newer)
        }
    }

    @MainActor func testNewExplicitAddCanRestoreOnlyItsNamedHistoricalTargetOnce() throws {
        try fixture { delivery, store, _ in
            var original = try seed(store, stage: .connections, attempted: [101, 102], connected: [101])
            original.draft.selection = .init(defaultChannel: channel(101))
            original.requiredChannelIDs = []; original.confirmedOnceChannelIDs = [101, 102]
            original.transferID = "complete"
            try store.save(original, account: 0, kind: "delivery", id: original.id.uuidString)
            _ = try delivery.accept(try members([101]), id: original.id, transferID: "complete")
            var selected = DestinationSelection(defaultChannel: channel(101)); selected.toggle(channel(102))
            _ = try delivery.amendPlacements(original.id, account: 42, selection: selected)
            var added = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString))
            XCTAssertEqual(added.explicitlyAddedChannelIDs, [102])
            XCTAssertEqual(added.confirmedOnceChannelIDs, [101, 102])
            delivery.consume(try response(.object(["id": .number(900), "state": .string("available")])), job: &added)
            delivery.consume(try members([101]), job: &added)
            XCTAssertEqual(added.stage, .connect)
            try store.save(added, account: 0, kind: "delivery", id: added.id.uuidString)
            let reserved = try XCTUnwrap(delivery.reserveTransfer(added, transferID: "explicit-add"))
            XCTAssertFalse(reserved.explicitlyAddedChannelIDs?.contains(102) == true)
            var lost = try XCTUnwrap(delivery.accept(.init(status: nil, body: Data(), error: "Lost reply", retryAfter: nil), id: added.id, transferID: "explicit-add"))
            delivery.consume(try members([101]), job: &lost)
            XCTAssertEqual(lost.stage, .attention)
        }
    }

    @MainActor func testPausedCompleteReadbackCanFinishWithoutAnotherMutation() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .connections, attempted: [101, 102], connected: [101])
            job.stopRequestedAt = Date(); job.readOnlyReconciliation = true; job.transferID = "final-read"
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            let complete = try XCTUnwrap(delivery.accept(try members([101, 102]), id: job.id, transferID: "final-read"))
            XCTAssertEqual(complete.stage, .done)
            XCTAssertEqual(complete.connected, [101, 102])
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertTrue(CaptureContinuedProgress(state: complete.state, selectedChannelIDs: [101, 102]).isDone)
            XCTAssertThrowsError(try delivery.request(complete, token: "fixture"))
        }
    }

    @MainActor func testPausedProvenanceReadbackFinishesOnlyWhenExistingSummaryMatches() throws {
        try fixture { delivery, store, _ in
            for matches in [true, false] {
                var job = try seed(store, stage: .provenanceRead, attempted: [101, 102], connected: [101, 102])
                job.draft.provenanceChannelID = 101
                job.provenance = try CaptureConnectionProvenance(draft: job.draft, prepared: job.prepared)
                job.provenanceConnectionID = 700; job.stopRequestedAt = Date(); job.readOnlyReconciliation = true
                job.transferID = "summary-\(matches)"
                try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
                let metadata = matches ? try XCTUnwrap(job.provenance?.metadata) : [:]
                let result = try response(.object(["id": .number(700), "connected_by": .object(["id": .number(42)]), "metadata": .object(metadata)]))
                let observed = try XCTUnwrap(delivery.accept(result, id: job.id, transferID: "summary-\(matches)"))
                XCTAssertEqual(observed.stage, matches ? .done : .attention)
                XCTAssertEqual(observed.draft.blockID, 900)
                XCTAssertEqual(observed.connected, [101, 102])
                XCTAssertNil(try delivery.reserveTransfer(observed, transferID: "forbidden-put"))
            }
        }
    }

    @MainActor func testUncertainUpdateReadsBackInsteadOfRepeatingPut() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .update, attempted: [101])
            job.prepared.update = ["title": .string("Captured title")]
            delivery.consume(.init(status: 200, body: Data(), error: "Response lost", retryAfter: nil), job: &job)
            XCTAssertEqual(job.stage, .verify)
            XCTAssertEqual(try delivery.request(job, token: "fixture").request.httpMethod, "GET")
            delivery.consume(try response(.object(["id": .number(900), "title": .string("Edited later")])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.draft.blockID, 900)
        }
    }

    @MainActor func testMissingUpdateTaskAndReceiptReadsExternalEditWithoutRepeatingPut() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .update, attempted: [101])
            job.prepared.update = ["title": .string("Captured title")]
            job.transferID = "lost-put"; job.transferStarted = Date().addingTimeInterval(-31)
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            var recovered = try XCTUnwrap(delivery.recoverMissingTransfer(job.id, transferID: "lost-put"))
            XCTAssertEqual(recovered.stage, .verify)
            XCTAssertNil(recovered.transferID)
            XCTAssertEqual(try delivery.request(recovered, token: "fixture").request.httpMethod, "GET")
            delivery.consume(try response(.object(["id": .number(900), "title": .string("Edited in Are.na after the lost response")])), job: &recovered)
            XCTAssertEqual(recovered.stage, .attention)
            XCTAssertEqual(recovered.draft.blockID, 900)
            XCTAssertThrowsError(try delivery.request(recovered, token: "fixture"))
        }
    }

    func testSystemProgressUsesReceiptIdentityAndNeverTreatsCancellationOrPartialStateAsSuccess() {
        let capture = UUID(), receipt = UUID()
        var state = CaptureDeliveryState(operationID: capture, receiptID: receipt, stage: .done, confirmedChannelIDs: [101], contentVerified: true)
        var fact = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102])
        XCTAssertEqual(fact.receiptID, receipt); XCTAssertFalse(fact.isDone)
        state.confirmedChannelIDs = [101, 102]
        fact = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102])
        XCTAssertTrue(fact.isDone)
        state.canceledAt = Date(); state.stopRequested = true
        fact = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102])
        XCTAssertTrue(fact.isCanceled); XCTAssertTrue(fact.isTerminal); XCTAssertFalse(fact.isDone)
        XCTAssertEqual(fact.title, "Canceled")
    }

    @MainActor func testCancellationWireValuesRemainReadableByLegacyEnumDecoder() throws {
        struct LegacyState: Decodable { var operationID: UUID; var stage: CaptureDeliveryStage; var confirmedChannelIDs: Set<Int>; var contentVerified: Bool; var stopRequested: Bool? }
        struct LegacyDraft: Decodable { var id: UUID; var phase: CapturePhase; var deliveryState: LegacyState? }
        try fixture { delivery, store, _ in
            let job = try seed(store, stage: .queued, attempted: [], block: nil)
            try delivery.cancel(job.id, accountID: 42)
            let saved = try XCTUnwrap(store.value(CaptureDraft.self, account: 42, kind: "draft", id: job.id.uuidString))
            let data = try JSONEncoder().encode(saved)
            let legacy = try JSONDecoder().decode(LegacyDraft.self, from: data)
            XCTAssertEqual(legacy.id, job.id); XCTAssertEqual(legacy.phase, .saved)
            XCTAssertEqual(legacy.deliveryState?.stage, .done)
            XCTAssertEqual(legacy.deliveryState?.stopRequested, true)
            XCTAssertFalse(legacy.deliveryState?.contentVerified ?? true)
            XCTAssertNil(try store.value(DeliveryJob.self, account: 42, kind: "deliveryReceipt", id: job.id.uuidString))
        }
    }

    @MainActor private func fixture(_ action: (CaptureDelivery, CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("capture.sqlite")
        let store = try CaptureStore(url: url)
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        try action(delivery, store, url)
    }

    @MainActor private func seed(_ store: CaptureStore, stage: CaptureDeliveryStage, attempted: [Int]?, connected: Set<Int> = [], block: Int? = 900) throws -> DeliveryJob {
        var draft = CaptureDraft(accountID: 42, defaultChannel: channel(101), input: "https://example.test/article")
        draft.selection.toggle(channel(102)); draft.phase = block == nil ? .queued : .checking
        draft.blockID = block
        var job = DeliveryJob(id: draft.id, draft: draft, prepared: .init(payload: ["value": .string(draft.input)], update: [:]), attemptedChannelIDs: attempted,
            contentVerified: block != nil, stage: stage, connected: connected, block: block.map { .object(["id": .number(Double($0))]) })
        job.draft.deliveryState = job.state
        try store.save(job.draft, account: 42, kind: "draft", id: job.id.uuidString)
        try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
        return job
    }

    private func channel(_ id: Int) -> Channel {
        .init(id: id, title: "Channel \(id)", slug: "channel-\(id)", visibility: "private", owner: .init(id: 42, name: "Fixture", slug: "fixture", type: "User"))
    }
    private func members(_ ids: [Int]) throws -> BackgroundHTTPResult {
        try response(.object(["data": .array(ids.map { .object(["id": .number(Double($0))]) }), "meta": .object(["has_more_pages": .bool(false)])]))
    }
    private func response(_ json: JSONValue, status: Int = 200) throws -> BackgroundHTTPResult {
        .init(status: status, body: try JSONEncoder().encode(json), error: nil, retryAfter: nil)
    }
}
