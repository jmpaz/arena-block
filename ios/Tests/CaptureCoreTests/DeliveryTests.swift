import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime
@testable import CaptureUI

final class DeliveryTests: XCTestCase {
    func testContinuedProgressCountsOnlyServerConfirmedOutcomes() {
        let id = UUID()
        let selected: Set<Int> = [101, 102]
        var state = CaptureDeliveryState(operationID: id, stage: .upload)
        var progress = CaptureContinuedProgress(state: state, selectedChannelIDs: selected)
        XCTAssertEqual(progress.completedUnits, 0)
        XCTAssertEqual(progress.totalUnits, 3)
        XCTAssertFalse(progress.isQuantifiable)
        XCTAssertFalse(progress.isDone)

        state.stage = .connections
        state.contentVerified = true
        state.confirmedChannelIDs = [101]
        progress = CaptureContinuedProgress(state: state, selectedChannelIDs: selected)
        XCTAssertEqual(progress.completedUnits, 2)
        XCTAssertTrue(progress.isQuantifiable)
        XCTAssertEqual(progress.subtitle, "1 of 2 placements confirmed")
        XCTAssertFalse(progress.isDone)

        // A complete server scan may reveal that a formerly confirmed placement is gone.
        state.confirmedChannelIDs = []
        progress = CaptureContinuedProgress(state: state, selectedChannelIDs: selected)
        XCTAssertEqual(progress.completedUnits, 1)
        XCTAssertEqual(progress.subtitle, "0 of 2 placements confirmed")
        XCTAssertFalse(progress.isDone)
    }

    func testContinuedProgressSeparatesRetryPauseAndVerifiedFinish() {
        let id = UUID()
        let now = Date(timeIntervalSince1970: 1_000)
        var state = CaptureDeliveryState(operationID: id, stage: .connect, confirmedChannelIDs: [101], contentVerified: true, notBefore: now.addingTimeInterval(60))
        var progress = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102], now: now)
        XCTAssertTrue(progress.waitingToRetry)
        XCTAssertEqual(progress.title, "Waiting to retry")
        XCTAssertFalse(progress.isDone)

        state.stage = .attention
        state.stopRequested = true
        progress = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102], now: now)
        XCTAssertTrue(progress.needsAttention)
        XCTAssertEqual(progress.title, "Save paused")
        XCTAssertFalse(progress.isDone)

        state.stage = .done
        state.stopRequested = false
        state.confirmedChannelIDs = [101, 102]
        progress = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102], now: now)
        XCTAssertEqual(progress.completedUnits, progress.totalUnits)
        XCTAssertTrue(progress.isDone)
        XCTAssertFalse(progress.needsAttention)
    }

    @MainActor
    func testCreateWithSuccessStatusAndTransportErrorReconcilesInsteadOfResubmitting() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .create)
            delivery.consume(.init(status: 201, body: Data(), error: "Connection lost while reading response", retryAfter: nil), job: &job)
            XCTAssertEqual(job.stage, .reconcile)
            XCTAssertEqual(job.draft.phase, .uncertain)
            XCTAssertNil(job.draft.blockID)
            let request = try delivery.request(job, token: "test")
            XCTAssertEqual(request.request.httpMethod, "GET")
            XCTAssertTrue(request.request.url?.path.contains("/users/") == true)
        }
    }

    @MainActor
    func testCreateTimeoutResponseRemainsUncertain() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .create)
            delivery.consume(try response(.object(["error": .string("Request timed out")]), status: 408), job: &job)
            XCTAssertEqual(job.stage, .reconcile)
            XCTAssertEqual(job.draft.phase, .uncertain)
            XCTAssertEqual(try delivery.request(job, token: "test").request.httpMethod, "GET")
        }
    }

    @MainActor
    func testCreateWithoutReadableIdentifierRemainsUncertain() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .create)
            delivery.consume(try response(.object(["message": .string("accepted")]), status: 201), job: &job)
            XCTAssertEqual(job.stage, .reconcile)
            XCTAssertEqual(job.draft.phase, .uncertain)
        }
    }

    @MainActor
    func testFailedUploadRetainsUploadStageEvenAfterPresignProvidedSourceURL() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .presign)
            job.mediaPath = "/tmp/approved.jpg"
            job.mediaType = "image/jpeg"
            delivery.consume(try response(.object([
                "files": .array([.object([
                    "upload_url": .string("https://uploads.example.test/signed"),
                    "key": .string("test/approved.jpg"),
                    "content_type": .string("image/jpeg")
                ])]), "expires_in": .number(3600)
            ])), job: &job)
            XCTAssertEqual(job.stage, .upload)
            XCTAssertNotNil(job.uploadedSource)
            job.attempts = 7
            delivery.consume(.init(status: nil, body: Data(), error: "offline", retryAfter: nil), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.resumeStage, .upload)
            job.stage = try XCTUnwrap(job.resumeStage)
            let operation = try delivery.request(job, token: "test")
            XCTAssertEqual(operation.request.httpMethod, "PUT")
            XCTAssertEqual(operation.request.url?.host, "uploads.example.test")
            XCTAssertNil(operation.request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(operation.file?.path, "/tmp/approved.jpg")
        }
    }

    @MainActor
    func testQueuedDestinationValidationRequiresEveryChannelBeforeCreate() throws {
        try withDelivery { delivery, store in
            var job = makeJob(stage: .destinations, channels: [101, 102])
            _ = try delivery.persistSubmission(draft: job.draft, prepared: job.prepared, media: nil, contentType: nil)
            job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(job.draft.phase, .queued)
            XCTAssertEqual(try delivery.request(job, token: "test").request.url?.path, "/v3/channels/101")
            delivery.consume(try response(.object(["can": .object(["add_to": .bool(true)])])), job: &job)
            XCTAssertEqual(job.stage, .destinations)
            XCTAssertEqual(try delivery.request(job, token: "test").request.url?.path, "/v3/channels/102")
            delivery.consume(try response(.object(["can": .object(["add_to": .bool(false)])])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.resumeStage, .destinations)
            XCTAssertNil(job.draft.blockID)
        }
    }

    @MainActor
    func testDefaultPrivacyIsRecheckedBeforeQueuedCreation() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .destinations, channels: [101])
            job.draft.provenanceChannelID = 101
            job.provenance = try CaptureConnectionProvenance(draft: job.draft, prepared: job.prepared)
            let publicInbox: JSONValue = .object([
                "id": .number(Double(101)), "visibility": .string("public"),
                "owner": .object(["id": .number(Double(123456789)), "type": .string("User")]),
                "can": .object(["add_to": .bool(true)])
            ])
            delivery.consume(try response(publicInbox), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertNil(job.draft.blockID)

            job = makeJob(stage: .destinations, channels: [101])
            job.draft.provenanceChannelID = 101
            job.provenance = try CaptureConnectionProvenance(draft: job.draft, prepared: job.prepared)
            var privateInbox = publicInbox.object
            privateInbox["visibility"] = .string("private")
            delivery.consume(try response(.object(privateInbox)), job: &job)
            XCTAssertEqual(job.stage, .create)
        }
    }

    @MainActor
    func testConnectionsNeedAllDestinationsAcrossPages() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .connections, channels: [101, 102])
            job.draft.blockID = 900
            delivery.consume(try response(.object([
                "data": .array([.object(["id": .number(101)])]),
                "meta": .object(["has_more_pages": .bool(true), "next_page": .number(2)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .connections)
            XCTAssertEqual(job.page, 2)
            delivery.consume(try response(.object([
                "data": .array([.object(["id": .number(102)])]),
                "meta": .object(["has_more_pages": .bool(false)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .done)
        }
    }

    @MainActor
    func testMalformedConnectionsPageRetainsLastCompleteConfirmation() throws {
        try withDelivery { delivery, _ in
            for malformed in [
                JSONValue.object(["meta": .object(["has_more_pages": .bool(false)])]),
                .object(["data": .array([])]),
                .object(["data": .array([]), "meta": .object(["has_more_pages": .bool(true)])]),
                .object(["data": .array([.object(["missing_id": .number(101)])]), "meta": .object(["has_more_pages": .bool(false)])])
            ] {
                var job = makeJob(stage: .connections, channels: [101, 102])
                job.draft.blockID = 900
                job.connected = [101]
                delivery.consume(try response(malformed), job: &job)
                XCTAssertEqual(job.stage, .attention)
                XCTAssertEqual(job.connected, [101])
                XCTAssertNotEqual(job.draft.phase, .saved)
            }
        }
    }

    @MainActor
    func testCreateReadbackWaitsForCompleteScanAndRejectsDifferentMatchingBlocks() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .reconcile)
            job.draft.phase = .uncertain
            let operationID = job.id.uuidString
            let matching: (Int) -> JSONValue = { id in
                .object(["id": .number(Double(id)), "metadata": .object(["arena_capture_id": .string(operationID)])])
            }
            delivery.consume(try response(.object([
                "data": .array([matching(900)]),
                "meta": .object(["has_more_pages": .bool(true), "next_page": .number(2)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .reconcile)
            XCTAssertNil(job.draft.blockID)
            XCTAssertEqual(job.reconcileCandidateID, 900)

            job = try JSONDecoder().decode(DeliveryJob.self, from: JSONEncoder().encode(job))
            delivery.consume(try response(.object([
                "data": .array([matching(901)]),
                "meta": .object(["has_more_pages": .bool(false)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.draft.phase, .uncertain)
            XCTAssertNil(job.draft.blockID)
        }
    }

    @MainActor
    func testIncompleteCreateReadbackNeverAcceptsCandidate() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .reconcile)
            job.draft.phase = .uncertain
            let match = JSONValue.object(["id": .number(900), "metadata": .object(["arena_capture_id": .string(job.id.uuidString)])])
            delivery.consume(try response(.object([
                "data": .array([match]),
                "meta": .object(["has_more_pages": .bool(true)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertNil(job.draft.blockID)
            XCTAssertEqual(job.draft.phase, .uncertain)
        }
    }

    @MainActor
    func testCreateReadbackAcceptsOneMatchOnlyAfterFinalPage() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .reconcile)
            job.draft.phase = .uncertain
            let match = JSONValue.object(["id": .number(900), "metadata": .object(["arena_capture_id": .string(job.id.uuidString)])])
            delivery.consume(try response(.object([
                "data": .array([match]),
                "meta": .object(["has_more_pages": .bool(true), "next_page": .number(2)])
            ])), job: &job)
            XCTAssertNil(job.draft.blockID)
            delivery.consume(try response(.object([
                "data": .array([]),
                "meta": .object(["has_more_pages": .bool(false)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .read)
            XCTAssertEqual(job.draft.blockID, 900)
            XCTAssertNil(job.reconcileCandidateID)
        }
    }

    @MainActor
    func testConfirmedPlacementsChangeOnlyAfterCompleteScan() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .connections, channels: [101, 102])
            job.draft.blockID = 900
            job.connected = [101, 102]
            delivery.consume(try response(.object([
                "data": .array([.object(["id": .number(101)])]),
                "meta": .object(["has_more_pages": .bool(true), "next_page": .number(2)])
            ])), job: &job)
            XCTAssertEqual(job.connected, [101, 102])
            XCTAssertEqual(job.state.confirmedChannelIDs, [101, 102])
            job = try JSONDecoder().decode(DeliveryJob.self, from: JSONEncoder().encode(job))
            delivery.consume(try response(.object([
                "data": .array([]),
                "meta": .object(["has_more_pages": .bool(false)])
            ])), job: &job)
            XCTAssertEqual(job.connected, [101])
            XCTAssertEqual(job.state.confirmedChannelIDs, [101])
            XCTAssertEqual(job.stage, .attention)
        }
    }

    @MainActor
    func testQueuedJobWithoutScanFieldStillDecodes() throws {
        let job = makeJob(stage: .connections, channels: [101, 102])
        var encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(job)) as? [String: Any])
        encoded.removeValue(forKey: "scanningConnected")
        encoded.removeValue(forKey: "reconcileCandidateID")
        let reopened = try JSONDecoder().decode(DeliveryJob.self, from: JSONSerialization.data(withJSONObject: encoded))
        XCTAssertNil(reopened.scanningConnected)
        XCTAssertNil(reopened.reconcileCandidateID)
        XCTAssertEqual(reopened.id, job.id)
    }

    @MainActor
    func testMissingDestinationDoesNotBecomeSaved() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .connections, channels: [101, 102])
            job.draft.blockID = 900
            delivery.consume(try response(.object([
                "data": .array([.object(["id": .number(101)])]),
                "meta": .object(["has_more_pages": .bool(false)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertNotEqual(job.draft.phase, .saved)
            XCTAssertEqual(job.draft.blockID, 900)
        }
    }

    @MainActor
    func testMissingCopiedCoverFailsEvenWhenTextMatchesApprovedPlan() throws {
        try withDelivery { delivery, _ in
            let runtime = try CaptureRuntime()
            let posts = #"[{"provider":"x","id":"123","canonicalUrl":"https://x.com/person/status/123","author":{"handle":"person"},"text":"Approved words","media":[{"ref":"1.1","kind":"image","url":"https://example.com/one.jpg","alt":"","width":640,"height":480}]}]"#
            let composed = try JSONDecoder().decode(JSONValue.self, from: Data(runtime.compose(postsJSON: posts).utf8))
            let plan = try XCTUnwrap(composed["plan"])
            let fields = try XCTUnwrap(composed["fields"])
            var job = makeJob(stage: .verify)
            job.draft.blockID = 900
            job.draft.previewSnapshot = CapturePreview(kind: "social", url: "https://x.com/person/status/123", plan: plan)
            let block: JSONValue = .object([
                "id": .number(900), "state": .string("available"), "type": .string("Link"),
                "title": fields["title"] ?? .string(""),
                "description": .object(["markdown": fields["description"] ?? .string("")]),
                "image": .null
            ])
            delivery.consume(try response(block), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertTrue(job.problem?.localizedCaseInsensitiveContains("cover") == true, job.problem ?? "No failure reason")
        }
    }

    @MainActor
    func testPreviouslyPublishedCaptureIsVerifiedWithoutEditingItsContent() throws {
        try withDelivery { delivery, store in
            var original = makeJob(stage: .destinations)
            original.draft.publicationKey = "same-material"
            original.prepared.update = ["title": .string("Approved title")]
            try store.save(900, account: original.draft.accountID, kind: "published", id: "same-material")
            _ = try delivery.persistSubmission(draft: original.draft, prepared: original.prepared, media: nil, contentType: nil)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: original.id.uuidString))
            XCTAssertEqual(job.draft.blockID, 900)
            XCTAssertEqual(job.reuseExisting, true)
            delivery.consume(try response(.object(["can": .object(["add_to": .bool(true)])])), job: &job)
            XCTAssertEqual(job.stage, .read)
            delivery.consume(try response(.object(["state": .string("available"), "title": .string("Changed elsewhere")])), job: &job)
            XCTAssertEqual(job.stage, .verify)
            XCTAssertEqual(try delivery.request(job, token: "test").request.httpMethod, "GET")
            delivery.consume(try response(.object(["state": .string("available"), "title": .string("Changed elsewhere")])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.draft.blockID, 900)
        }
    }

    @MainActor
    func testReuseConnectsOnlyMissingChannelsAndReconcilesAmbiguousConnection() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .connections, channels: [101, 102])
            job.draft.blockID = 900
            job.reuseExisting = true
            delivery.consume(try response(.object([
                "data": .array([.object(["id": .number(101)])]),
                "meta": .object(["has_more_pages": .bool(false)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .connect)
            let operation = try delivery.request(job, token: "test")
            XCTAssertEqual(operation.request.httpMethod, "POST")
            XCTAssertEqual(operation.request.url?.path, "/v3/connections")
            let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(operation.body))
            XCTAssertEqual(body["channel_ids"], .array([.number(102)]))
            XCTAssertEqual(body["connectable_id"], .number(900))
            delivery.consume(.init(status: 201, body: Data(), error: "Response interrupted", retryAfter: nil), job: &job)
            XCTAssertEqual(job.stage, .connections)
            XCTAssertEqual(try delivery.request(job, token: "test").request.httpMethod, "GET")
            delivery.consume(try response(.object([
                "data": .array([.object(["id": .number(101)]), .object(["id": .number(102)])]),
                "meta": .object(["has_more_pages": .bool(false)])
            ])), job: &job)
            XCTAssertEqual(job.stage, .done)
            XCTAssertEqual(job.connectionAttempts, 1)
        }
    }

    @MainActor
    func testDeletedPublishedBlockRequiresAttentionInsteadOfCreatingReplacement() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .read)
            job.draft.blockID = 900; job.reuseExisting = true
            delivery.consume(try response(.object(["error": .string("Not found")]), status: 404), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.resumeStage, .read)
            XCTAssertEqual(job.draft.blockID, 900)
        }
    }

    @MainActor
    func testSubmittingSameSavedDraftDoesNotCreateNewDeliveryJob() throws {
        try withDelivery { delivery, store in
            var job = makeJob(stage: .done)
            job.draft.phase = .saved; job.draft.blockID = 900
            try store.save(job.draft, account: job.draft.accountID, kind: "draft", id: job.id.uuidString)
            _ = try delivery.persistSubmission(draft: job.draft, prepared: job.prepared, media: nil, contentType: nil)
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(try store.value(CaptureDraft.self, account: job.draft.accountID, kind: "draft", id: job.id.uuidString)?.phase, .saved)
        }
    }

    @MainActor
    func testPersistedCompletionIsConsumedOnceAndCannotOverwriteNextTransfer() throws {
        try withDelivery { delivery, store in
            var job = makeJob(stage: .create)
            job.transferID = "first"; job.transferSession = "extension.delivery"
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            let created = try response(.object(["id": .number(900)]), status: 201)
            var next = try XCTUnwrap(delivery.accept(created, id: job.id, transferID: "first"))
            XCTAssertEqual(next.stage, .read)
            XCTAssertEqual(next.draft.blockID, 900)
            XCTAssertEqual(next.revision, 1)
            next.transferID = "second"
            try store.save(next, account: 0, kind: "delivery", id: next.id.uuidString)
            XCTAssertNil(try delivery.accept(created, id: job.id, transferID: "first"))
            let retained = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(retained.transferID, "second")
            XCTAssertEqual(retained.stage, .read)
        }
    }

    @MainActor
    func testConfirmationAtomicallyRetainsHistoryAndRetiresActiveJob() throws {
        try withDelivery { delivery, store in
            var job = makeJob(stage: .connections)
            job.draft.blockID = 900; job.draft.publicationKey = "approved"
            job.block = .object(["id": .number(900), "title": .string("Approved")])
            job.contentVerified = true
            job.transferID = "connections"
            _ = try store.reservePublication(account: job.draft.accountID, key: "approved", draftID: job.id)
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            let result = try response(.object(["data": .array([.object(["id": .number(101)])]), "meta": .object(["has_more_pages": .bool(false)])]))
            let confirmed = try XCTUnwrap(delivery.accept(result, id: job.id, transferID: "connections"))
            XCTAssertEqual(confirmed.stage, .done)
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            let saved = try XCTUnwrap(store.value(CaptureDraft.self, account: job.draft.accountID, kind: "draft", id: job.id.uuidString))
            XCTAssertEqual(saved.phase, .saved)
            XCTAssertEqual(saved.savedBlock, job.block)
            XCTAssertEqual(try store.value(Int.self, account: job.draft.accountID, kind: "published", id: "approved"), 900)
            XCTAssertNil(try store.value(UUID.self, account: job.draft.accountID, kind: "publicationLock", id: "approved"))
            XCTAssertNil(try delivery.accept(result, id: job.id, transferID: "connections"))
        }
    }

    @MainActor
    private func withDelivery(_ action: (CaptureDelivery, CaptureStore) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CaptureStore(url: directory.appendingPathComponent("capture.sqlite"))
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: directory.appendingPathComponent("delivery"), group: "test.capture", identifier: "test.capture.delivery", ingestBase: "https://ingest.example.test")
        try action(delivery, store)
    }

    @MainActor
    func testPartialPlacementObservationSurvivesReopeningAndKeepsOperationIdentity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("capture.sqlite")
        let store = try CaptureStore(url: url)
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: directory.appendingPathComponent("delivery"), group: "test.capture", identifier: "test.capture", ingestBase: nil)
        var first = makeJob(stage: .connections, channels: [101, 102])
        first.draft.blockID = 900; first.contentVerified = true; first.transferID = "first"
        first.block = .object(["id": .number(900), "title": .string("Retained block")])
        var second = makeJob(stage: .connections, channels: [103])
        second.draft.blockID = 901; second.transferID = "second"
        first.draft.publicationKey = "same-plan"; second.draft.publicationKey = "same-plan"
        try store.save(first, account: 0, kind: "delivery", id: first.id.uuidString)
        try store.save(second, account: 0, kind: "delivery", id: second.id.uuidString)
        try store.save(CaptureWorkspace(activeDraftID: second.id, retainedResultID: first.id), account: first.draft.accountID, kind: "workspace", id: "current")
        let response = try response(.object(["data": .array([.object(["id": .number(101)])]), "meta": .object(["has_more_pages": .bool(false)])]))
        _ = try delivery.accept(response, id: first.id, transferID: "first")
        let reopened = try CaptureStore(url: url)
        let partial = try XCTUnwrap(reopened.value(CaptureDraft.self, account: first.draft.accountID, kind: "draft", id: first.id.uuidString))
        XCTAssertEqual(partial.deliveryState?.operationID, first.id)
        XCTAssertEqual(partial.deliveryState?.confirmedChannelIDs, [101])
        XCTAssertEqual(partial.deliveryState?.stage, .attention)
        XCTAssertEqual(partial.deliveryState?.contentVerified, true)
        XCTAssertEqual(partial.savedBlock, first.block)
        XCTAssertEqual(try reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: second.id.uuidString)?.transferID, "second")
        XCTAssertEqual(try reopened.value(CaptureWorkspace.self, account: first.draft.accountID, kind: "workspace", id: "current")?.activeDraftID, second.id)
        XCTAssertNil(try delivery.accept(response, id: first.id, transferID: "second"))
    }

    @MainActor
    func testCompletionRetainsConfirmedPlacementsAfterDeliveryJobRetires() throws {
        try withDelivery { delivery, store in
            var job = makeJob(stage: .connections, channels: [101, 102])
            job.draft.blockID = 900; job.contentVerified = true; job.transferID = "complete"
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            _ = try delivery.accept(try response(.object(["data": .array([.object(["id": .number(101)]), .object(["id": .number(102)])]), "meta": .object(["has_more_pages": .bool(false)])])), id: job.id, transferID: "complete")
            let saved = try XCTUnwrap(store.value(CaptureDraft.self, account: job.draft.accountID, kind: "draft", id: job.id.uuidString))
            XCTAssertEqual(saved.deliveryState?.operationID, job.id)
            XCTAssertEqual(saved.deliveryState?.stage, .done)
            XCTAssertEqual(saved.deliveryState?.confirmedChannelIDs, [101, 102])
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
        }
    }

    @MainActor
    func testAddPlacementsReadsCurrentBlockAndNeverPublishesOldContent() throws {
        try withDelivery { delivery, store in
            var original = makeJob(stage: .done).draft
            original.phase = .saved; original.blockID = 900
            original.titleOverride = "Old approved title"; original.descriptionOverride = "My writing"
            original.media = .all; original.publicationKey = "original-plan"
            let next = try XCTUnwrap(original.addingPlacements())
            XCTAssertNotEqual(next.id, original.id)
            XCTAssertTrue(next.selection.channels.isEmpty)
            XCTAssertFalse(next.selection.implicitDefault)
            XCTAssertEqual(next.titleOverride, original.titleOverride)
            XCTAssertEqual(next.media, .all)
            XCTAssertNil(next.publicationKey)
            var selected = next; selected.selection.toggle(original.selection.channels[0])
            _ = try delivery.persistSubmission(draft: selected, prepared: .init(payload: [:], update: [:]), media: nil, contentType: nil)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: selected.id.uuidString))
            delivery.consume(try response(.object(["can": .object(["add_to": .bool(true)])])), job: &job)
            XCTAssertEqual(job.stage, .read)
            XCTAssertEqual(try delivery.request(job, token: "test").request.url?.path, "/v3/blocks/900")
            delivery.consume(try response(.object(["id": .number(900), "state": .string("available"), "title": .string("Later authored title")])), job: &job)
            XCTAssertEqual(job.stage, .connections)
            XCTAssertEqual(job.contentVerified, true)
            delivery.consume(try response(.object(["data": .array([]), "meta": .object(["has_more_pages": .bool(false)])])), job: &job)
            XCTAssertEqual(job.stage, .connect)
            let connection = try delivery.request(job, token: "test")
            XCTAssertEqual(connection.request.url?.path, "/v3/connections")
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(connection.body))["channel_ids"], .array([.number(101)]))
            for stage in [DeliveryJob.Stage.create, .update, .presign, .upload] {
                job.stage = stage
                XCTAssertThrowsError(try delivery.request(job, token: "test"))
            }
        }
    }

    @MainActor
    func testVerifiedPartialRecoveryChecksMembershipBeforeAddingOnlyMissingPlacement() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .attention, channels: [101, 102])
            job.draft.blockID = 900; job.contentVerified = true; job.resumeStage = .connections
            job.connected = [101]; job.problem = "Pending destination"
            job.resumeAfterAttention()
            XCTAssertEqual(job.stage, .connections)
            XCTAssertEqual(try delivery.request(job, token: "test").request.httpMethod, "GET")
            delivery.consume(try response(.object(["data": .array([.object(["id": .number(101)])]), "meta": .object(["has_more_pages": .bool(false)])])), job: &job)
            let request = try delivery.request(job, token: "test")
            XCTAssertEqual(request.request.url?.path, "/v3/connections")
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.body))["channel_ids"], .array([.number(102)]))
        }
    }

    func testUnverifiedOrMismatchedOperationCannotStartPlacementContinuation() {
        var draft = makeJob(stage: .read).draft
        draft.blockID = 900
        XCTAssertNil(draft.addingPlacements())
        draft.deliveryState = .init(operationID: UUID(), stage: .connections, contentVerified: true)
        XCTAssertNil(draft.addingPlacements())
        draft.deliveryState?.operationID = draft.id
        XCTAssertNotNil(draft.addingPlacements())
    }

    func testLegacyDraftDecodesWithoutNewOperationOrWorkspaceFields() throws {
        let old = makeJob(stage: .create).draft
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        json.removeValue(forKey: "intent"); json.removeValue(forKey: "deliveryState")
        let decoded = try JSONDecoder().decode(CaptureDraft.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded.id, old.id)
        XCTAssertEqual(decoded.selection, old.selection)
        XCTAssertNil(decoded.deliveryState)
        XCTAssertFalse(decoded.isPlacementOnly)
    }

    private func makeJob(stage: DeliveryJob.Stage, channels: [Int] = [101]) -> DeliveryJob {
        var draft = CaptureDraft(accountID: 123456789, defaultChannel: nil, input: "https://example.com/article")
        for id in channels {
            draft.selection.toggle(Channel(id: id, title: "Channel", slug: "channel-\(id)", visibility: "private", owner: Owner(id: 123456789, name: "Test", slug: "test", type: "User")))
        }
        return DeliveryJob(id: draft.id, draft: draft, prepared: PreparedCapture(payload: ["value": .string(draft.input)], update: [:]), stage: stage)
    }

    @MainActor
    func testOnlyActualDefaultConnectionGetsSummaryAndPrivateOriginalIsRetained() throws {
        try withDelivery { delivery, store in
            var source = makeJob(stage: .create, channels: [101, 102])
            source.draft.provenanceChannelID = 102; source.draft.defaultChannelMode = .always
            source.draft.requestedChannelIDs = [101]
            _ = try delivery.persistSubmission(draft: source.draft, prepared: source.prepared, media: nil, contentType: nil)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString))
            job.stage = .create
            let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(delivery.request(job, token: "fixture").body))
            XCTAssertNil(body["channel_ids"])
            XCTAssertNil(body["channels"]?.array[0]["metadata"])
            XCTAssertEqual(body["channels"]?.array[1]["metadata"]?["ac_capture_id"], .string(job.id.uuidString))
            XCTAssertEqual(body["channels"]?.array[1]["metadata"]?["ac_snapshot_complete"], .bool(false))
            XCTAssertNil(body["metadata"]?["ac_capture_id"])
            let original = try JSONDecoder().decode(JSONValue.self, from: Data(try XCTUnwrap(job.draft.provenanceSnapshotJSON).utf8))
            XCTAssertEqual(original["draft"]?["input"], .string(source.draft.input))
            let retained = job.draft.provenanceSnapshotJSON
            job.draft.titleOverride = "Later authored title"
            XCTAssertEqual(job.draft.provenanceSnapshotJSON, retained)
        }
    }

    @MainActor
    func testDefaultConnectionIsMappedByContentsAndVerifiedBeforeProvenanceSuccess() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .connections, channels: [101, 102])
            job.draft.blockID = 900; job.contentVerified = true; job.draft.provenanceChannelID = 102
            job.provenance = try CaptureConnectionProvenance(draft: job.draft, prepared: job.prepared)
            delivery.consume(try response(.object(["data": .array([.object(["id": .number(101)]), .object(["id": .number(102)])]), "meta": .object(["has_more_pages": .bool(false)])])), job: &job)
            XCTAssertEqual(job.stage, .provenanceContents)
            XCTAssertEqual(try delivery.request(job, token: "fixture").request.url?.path, "/v3/channels/102/contents")
            delivery.consume(try response(.object(["data": .array([.object(["id": .number(900), "type": .string("Link"), "connection": .object(["id": .number(777)])])]), "meta": .object(["has_more_pages": .bool(false)])])), job: &job)
            XCTAssertEqual(job.stage, .provenanceRead)
            XCTAssertEqual(try delivery.request(job, token: "fixture").request.url?.path, "/v3/connections/777")
            let actor: JSONValue = .object(["id": .number(Double(job.draft.accountID))])
            delivery.consume(try response(.object(["id": .number(777), "connected_by": actor, "metadata": .object(["user_note": .string("Keep")])])), job: &job)
            XCTAssertEqual(job.stage, .provenanceWrite)
            let write = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(delivery.request(job, token: "fixture").body))
            XCTAssertNil(write["metadata"]?["user_note"])
            delivery.consume(try response(.object([:])), job: &job)
            XCTAssertEqual(job.stage, .provenanceVerify)
            var confirmed = try XCTUnwrap(job.provenancePatch); confirmed["user_note"] = .string("Keep")
            delivery.consume(try response(.object(["data": .object(["id": .number(777), "connected_by": actor, "metadata": .object(confirmed)])])), job: &job)
            XCTAssertEqual(job.stage, .done)
            XCTAssertEqual(job.draft.provenanceConnectionID, 777)
        }
    }

    @MainActor
    func testLostProvenanceWriteReadsExistingSummaryBeforeRetryingAndWrongActorStops() throws {
        try withDelivery { delivery, _ in
            var job = makeJob(stage: .provenanceWrite)
            job.draft.blockID = 900; job.draft.provenanceChannelID = 101
            job.provenance = try CaptureConnectionProvenance(draft: job.draft, prepared: job.prepared)
            job.provenanceConnectionID = 777; job.provenancePatch = job.provenance?.metadata
            delivery.consume(.init(status: nil, body: Data(), error: "Lost response", retryAfter: nil), job: &job)
            XCTAssertEqual(job.stage, .provenanceRead)
            XCTAssertEqual(try delivery.request(job, token: "fixture").request.httpMethod, "GET")
            delivery.consume(try response(.object(["data": .object(["id": .number(777), "connected_by": .object(["id": .number(Double(job.draft.accountID))]), "metadata": .object(try XCTUnwrap(job.provenance?.metadata))])])), job: &job)
            XCTAssertEqual(job.stage, .done)
            job.stage = .provenanceRead
            delivery.consume(try response(.object(["id": .number(777), "connected_by": .object(["id": .number(2)]), "metadata": .object([:])])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.resumeStage, .provenanceRead)
            job.resumeStage = .provenanceVerify
            job.resumeAfterAttention()
            XCTAssertEqual(job.stage, .provenanceRead)
        }
    }

    private func response(_ json: JSONValue, status: Int = 200) throws -> BackgroundHTTPResult {
        .init(status: status, body: try JSONEncoder().encode(json), error: nil, retryAfter: nil)
    }
}
