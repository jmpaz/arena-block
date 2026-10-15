import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureUI

private actor UploadObservations {
    var values: [CaptureTransferProgress] = []
    func append(_ value: CaptureTransferProgress) { values.append(value) }
}

final class CaptureUploadProgressTests: XCTestCase {
    func testActualDelegateBytesProduceProgressWithoutACompletedResponse() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let transport = try BackgroundHTTP(identifier: "fixture", group: nil, directory: root)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: URL(string: "https://fixture.invalid/upload")!)
        task.taskDescription = "upload"
        let recorded = UploadObservations(), changed = expectation(description: "actual transfer observations")
        changed.expectedFulfillmentCount = 2
        transport.onProgress = { value in await recorded.append(value); changed.fulfill() }
        transport.urlSession(session, task: task, didSendBodyData: 25, totalBytesSent: 25, totalBytesExpectedToSend: 100)
        transport.urlSession(session, task: task, didSendBodyData: 75, totalBytesSent: 100, totalBytesExpectedToSend: 100)
        await fulfillment(of: [changed], timeout: 2)
        let values = await recorded.values
        XCTAssertEqual(values.map(\.completedBytes).sorted(), [25, 100])
        XCTAssertEqual(values.map(\.expectedBytes), [100, 100])
        XCTAssertNil(try transport.result("upload"))
    }

    @MainActor func testUploadBytesAdvanceSystemWorkWhileChannelConfirmationRemainsZero() throws {
        try fixture { delivery, store, _ in
            let job = try upload(delivery, store)
            let now = Date()
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 20, expectedBytes: 100, observedAt: now))
            let projection = try XCTUnwrap(store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: job.id.uuidString))
            let first = projection.progress(observation: try store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: "upload"))
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 80, expectedBytes: 100, observedAt: now.addingTimeInterval(1)))
            let second = projection.progress(observation: try store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: "upload"))
            XCTAssertGreaterThan(second.activityCompletedUnits, first.activityCompletedUnits)
            XCTAssertLessThan(second.activityCompletedUnits, second.activityTotalUnits)
            XCTAssertEqual(first.completedUnits, 0); XCTAssertEqual(second.completedUnits, 0)
            XCTAssertFalse(second.isDone); XCTAssertTrue(second.subtitle.contains("0/2 channels confirmed"))
            XCTAssertEqual(projection.revision, job.revision, "byte observations do not rewrite the frozen source job")
        }
    }

    @MainActor func testProgressSurvivesReopeningAndRejectsLateOrRegressingCallbacks() throws {
        try fixture { delivery, store, root in
            _ = try upload(delivery, store)
            let now = Date()
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 70, expectedBytes: 100, observedAt: now))
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 30, expectedBytes: 100, observedAt: now.addingTimeInterval(1)))
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 90, expectedBytes: 100, observedAt: now.addingTimeInterval(-1)))
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let progress = try XCTUnwrap(reopened.value(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: "upload"))
            XCTAssertEqual(progress.completedBytes, 70); XCTAssertEqual(progress.stage, .upload)
        }
    }

    func testStalledOrUnknownSizeUploadNeverReceivesFakeWorkIncrements() {
        let now = Date()
        var state = CaptureDeliveryState(operationID: UUID(), stage: .upload)
        state.preparationCompleted = true; state.mediaUploadRequired = true
        state.transferProgress = .init(transferID: "upload", completedBytes: 10, expectedBytes: 100, observedAt: now, stage: .upload)
        let first = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102], now: now)
        let stalled = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102], now: now.addingTimeInterval(40))
        XCTAssertEqual(stalled.activityCompletedUnits, first.activityCompletedUnits)
        XCTAssertTrue(stalled.transferStalled); XCTAssertEqual(stalled.title, "Upload not progressing")
        state.transferProgress = .init(transferID: "upload", completedBytes: 80, expectedBytes: nil, observedAt: now, stage: .upload)
        let unknown = CaptureContinuedProgress(state: state, selectedChannelIDs: [101, 102], now: now)
        XCTAssertEqual(unknown.activityCompletedUnits, 1_000)
        XCTAssertTrue(unknown.subtitle.contains("uploaded")); XCTAssertFalse(unknown.isDone)
    }

    @MainActor func testSuccessfulUploadRetainsTransportEvidenceBeforeMovingToCreate() throws {
        try fixture { delivery, store, root in
            let job = try upload(delivery, store)
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 100, expectedBytes: 100))
            var result = BackgroundHTTPResult(status: 200, body: Data(), error: nil, retryAfter: nil)
            result.completedAt = Date()
            let accepted = try XCTUnwrap(delivery.accept(result, id: job.id, transferID: "upload"))
            XCTAssertEqual(accepted.stage, .create); XCTAssertNotNil(accepted.mediaUploadCompletedAt)
            XCTAssertNil(accepted.draft.blockID); XCTAssertEqual(accepted.connected, [])
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let outcome = try XCTUnwrap(reopened.value(CaptureTransferOutcome.self, account: 42, kind: "deliveryAttempt", id: "upload"))
            XCTAssertEqual(outcome.operationID, job.id); XCTAssertEqual(outcome.receiptID, job.receiptID ?? job.id)
            XCTAssertEqual(outcome.stage, .upload); XCTAssertEqual(outcome.status, 200)
            XCTAssertEqual(outcome.startedAt, job.transferStarted); XCTAssertEqual(outcome.completedAt, result.completedAt)
            XCTAssertEqual(outcome.progress?.completedBytes, 100)
            XCTAssertFalse(CaptureContinuedProgress(state: accepted.state, selectedChannelIDs: [101, 102]).isDone)
        }
    }

    @MainActor func testContinuedTaskEndRetainsItsCauseAndActualCancellationResult() throws {
        try fixture { delivery, store, _ in
            let job = try upload(delivery, store)
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 60, expectedBytes: 100))
            try delivery.requestStop(job.id, reason: .continuedTaskEnded)
            var result = BackgroundHTTPResult(status: nil, body: Data(), error: "cancelled with a signed URL which must not be retained", retryAfter: nil)
            result.errorCode = NSURLErrorCancelled; result.errorDomain = NSURLErrorDomain
            let paused = try XCTUnwrap(delivery.accept(result, id: job.id, transferID: "upload"))
            XCTAssertEqual(paused.stage, .attention); XCTAssertEqual(paused.resumeStage, .upload)
            XCTAssertEqual(paused.interruption?.reason, .continuedTaskEnded)
            XCTAssertEqual(paused.lastTransferOutcome?.errorCode, NSURLErrorCancelled)
            XCTAssertEqual(paused.lastTransferOutcome?.progress?.completedBytes, 60)
            XCTAssertTrue(paused.problem?.contains("background task ended") == true)
            XCTAssertTrue(paused.problem?.contains("No block was created") == true)
            XCTAssertEqual(CaptureContinuedProgress(state: paused.state, selectedChannelIDs: [101, 102]).title, "Save interrupted")
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "late-create"))
        }
    }

    @MainActor func testExplicitPauseRemainsDistinctFromBackgroundTaskEnd() throws {
        try fixture { delivery, store, _ in
            let job = try upload(delivery, store)
            try delivery.requestStop(job.id)
            var result = BackgroundHTTPResult(status: nil, body: Data(), error: "cancelled", retryAfter: nil)
            result.errorCode = NSURLErrorCancelled; result.errorDomain = NSURLErrorDomain
            let paused = try XCTUnwrap(delivery.accept(result, id: job.id, transferID: "upload"))
            XCTAssertEqual(paused.interruption?.reason, .userPause)
            XCTAssertEqual(CaptureContinuedProgress(state: paused.state, selectedChannelIDs: [101, 102]).title, "Save paused")
        }
    }

    @MainActor func testRelaunchRecordsLostExecutionClaimWithoutAssumingForceQuit() throws {
        try fixture { delivery, store, root in
            let job = try upload(delivery, store)
            XCTAssertTrue(try delivery.beginContinued(job.id))
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let next = try CaptureDelivery(store: reopened, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
            XCTAssertEqual(try next.pauseUnclaimedContinued(), [job.id])
            let retained = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(retained.interruption?.reason, .executionClaimLost)
            XCTAssertNotNil(retained.stopRequestedAt)
            XCTAssertFalse(retained.interruption?.message.contains("force") == true)
        }
    }

    @MainActor func testCancelFencesLateUploadProgressAndLateSuccessCannotCreateABlock() throws {
        try fixture { delivery, store, _ in
            let job = try upload(delivery, store)
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 25, expectedBytes: 100))
            try delivery.cancel(job.id, accountID: 42)
            try delivery.recordProgress(.init(transferID: "upload", completedBytes: 100, expectedBytes: 100))
            XCTAssertEqual(try store.value(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: "upload")?.completedBytes, 25)
            let canceled = try XCTUnwrap(delivery.accept(.init(status: 200, body: Data(), error: nil, retryAfter: nil), id: job.id, transferID: "upload"))
            XCTAssertNotNil(canceled.canceledAt); XCTAssertNil(canceled.draft.blockID)
            XCTAssertThrowsError(try delivery.request(canceled, token: "fixture"))
            XCTAssertNotNil(try store.value(CaptureTransferOutcome.self, account: 42, kind: "deliveryAttempt", id: "upload"))
        }
    }

    @MainActor func testPermanentUpload403PreservesProviderCodeWithoutPresignLoop() throws {
        try fixture { delivery, store, root in
            let job = try upload(delivery, store)
            let body = Data("<Error><Code>SignatureDoesNotMatch</Code><CanonicalRequest>X-Amz-Credential=PRIVATE-SIGNED-QUERY</CanonicalRequest></Error>".utf8)
            let denied = try XCTUnwrap(delivery.accept(.init(status: 403, body: body, error: nil, retryAfter: nil), id: job.id, transferID: "upload"))
            XCTAssertEqual(denied.stage, .attention); XCTAssertEqual(denied.resumeStage, .upload)
            XCTAssertNil(denied.uploadAuthorizationRenewals)
            XCTAssertTrue(denied.problem?.contains("SignatureDoesNotMatch") == true)
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let outcome = try XCTUnwrap(reopened.value(CaptureTransferOutcome.self, account: 42, kind: "deliveryAttempt", id: "upload"))
            let encoded = String(decoding: try JSONEncoder().encode(outcome), as: UTF8.self)
            XCTAssertFalse(encoded.contains("PRIVATE-SIGNED-QUERY")); XCTAssertFalse(encoded.contains("CanonicalRequest"))
            XCTAssertEqual(outcome.providerCode, "SignatureDoesNotMatch")
        }
    }

    @MainActor func testExpiredUploadAuthorizationRenewalIsBoundedAcrossSuccessfulPresigns() throws {
        try fixture { delivery, store, _ in
            var job = try upload(delivery, store)
            let expired = BackgroundHTTPResult(status: 403, body: Data("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>".utf8), error: nil, retryAfter: nil)
            for count in 1...2 {
                delivery.consume(expired, job: &job)
                XCTAssertEqual(job.stage, .presign); XCTAssertEqual(job.uploadAuthorizationRenewals, count)
                delivery.consume(try response(.object(["files": .array([.object(["upload_url": .string("https://fixture.invalid/upload"), "key": .string("fixture-key"), "content_type": .string("video/mp4")])]), "expires_in": .number(3600)])), job: &job)
                XCTAssertEqual(job.stage, .upload)
            }
            delivery.consume(expired, job: &job)
            XCTAssertEqual(job.stage, .attention); XCTAssertEqual(job.uploadAuthorizationRenewals, 2)
        }
    }

    func testErrorEvidenceRedactsArbitraryURLTextAndPreservesKnownNetworkCode() throws {
        var result = BackgroundHTTPResult(status: nil, body: Data("<Code>https://private.invalid/?token=SECRET</Code>".utf8), error: "URL=https://private.invalid/?token=SECRET", retryAfter: nil)
        result.errorDomain = NSURLErrorDomain; result.errorCode = NSURLErrorTimedOut
        let outcome = CaptureTransferOutcome(transferID: "upload", stage: .upload, result: result)
        let json = String(decoding: try JSONEncoder().encode(outcome), as: UTF8.self)
        XCTAssertFalse(json.contains("SECRET")); XCTAssertFalse(json.contains("private.invalid"))
        XCTAssertEqual(outcome.errorCode, NSURLErrorTimedOut); XCTAssertEqual(outcome.redactedReason, "The network request timed out.")
    }

    @MainActor func testMissingTaskReceiptIsRetainedAsUnknownAndCreateStillRequiresReadback() throws {
        try fixture { delivery, store, _ in
            var job = try upload(delivery, store)
            job.stage = .create; job.attemptedChannelIDs = [101]
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            let unknown = try XCTUnwrap(delivery.recoverMissingTransfer(job.id, transferID: "upload"))
            XCTAssertEqual(unknown.stage, .reconcile); XCTAssertNil(unknown.draft.blockID)
            XCTAssertEqual(unknown.lastTransferOutcome?.responseMissing, true)
            XCTAssertNil(unknown.lastTransferOutcome?.status)
            XCTAssertEqual(try delivery.request(unknown, token: "fixture").request.httpMethod, "GET")
        }
    }

    @MainActor private func fixture(_ action: (CaptureDelivery, CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        try action(delivery, store, root)
    }
    @MainActor private func upload(_ delivery: CaptureDelivery, _ store: CaptureStore) throws -> DeliveryJob {
        var draft = CaptureDraft(accountID: 42, defaultChannel: channel(101), input: "https://example.test/video")
        draft.selection.toggle(channel(102)); draft.phase = .queued
        var job = DeliveryJob(id: draft.id, draft: draft, prepared: .init(payload: ["value": .string(draft.input)], update: [:]), attemptedChannelIDs: [], mediaPath: "/tmp/frozen-fixture.mp4", mediaType: "video/mp4", stage: .upload)
        job.draft.deliveryState = job.state
        try store.save(job.draft, account: 42, kind: "draft", id: job.id.uuidString)
        try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
        return try XCTUnwrap(delivery.reserveTransfer(job, transferID: "upload"))
    }
    private func channel(_ id: Int) -> Channel {
        .init(id: id, title: "Channel \(id)", slug: "channel-\(id)", visibility: "private", owner: .init(id: 42, name: "Fixture", slug: "fixture", type: "User"))
    }
    private func response(_ value: JSONValue) throws -> BackgroundHTTPResult {
        .init(status: 200, body: try JSONEncoder().encode(value), error: nil, retryAfter: nil)
    }
}
