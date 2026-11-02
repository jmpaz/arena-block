import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureUI

final class CaptureForegroundRecoveryTests: XCTestCase {
    @MainActor func testShareForegroundCannotPauseALiveMainApplicationClaim() throws {
        try fixture { main, store, root in
            let job = try seed(store, stage: .provenanceRead, receipt: UUID())
            XCTAssertTrue(try main.beginContinued(job.id, receiptID: job.receiptID))
            let sharedStore = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let share = try CaptureDelivery(store: sharedStore, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture.share", ingestBase: nil)
            XCTAssertEqual(try share.prepareForeground(isMainApplication: false), [])
            let retained = try XCTUnwrap(sharedStore.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertNil(retained.stopRequestedAt)
            XCTAssertNotNil(retained.continuedRequestedAt)
            XCTAssertEqual(retained.receiptID, job.receiptID)
            XCTAssertEqual(try main.prepareForeground(isMainApplication: true), [])
        }
    }

    @MainActor func testForegroundFencesUnclaimedCurrentAndLegacyReceiptsButRetainsReadback() throws {
        try fixture { delivery, store, _ in
            for receipt in [nil, UUID()] as [UUID?] {
                var job = try seed(store, stage: .provenanceRead, receipt: receipt)
                job.continuedRequestedAt = Date().addingTimeInterval(-86_400)
                try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
                XCTAssertTrue(try delivery.pauseUnclaimedContinued().contains(job.id))
                let fenced = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
                XCTAssertNotNil(fenced.stopRequestedAt)
                XCTAssertNil(fenced.continuedRequestedAt)
                XCTAssertEqual(fenced.interruption?.reason, .executionClaimLost)
                XCTAssertEqual(fenced.receiptID, receipt)
                XCTAssertEqual(fenced.stage, .provenanceRead)
                XCTAssertEqual(try delivery.request(fenced, token: "fixture").request.httpMethod, "GET")
            }
            XCTAssertEqual(try delivery.pauseUnclaimedContinued(), [])
        }
    }

    @MainActor func testForegroundKeepsTheExactLiveClaimAndCanceledTombstone() throws {
        try fixture { delivery, store, _ in
            let owned = try seed(store, stage: .provenanceRead, receipt: UUID())
            XCTAssertTrue(try delivery.beginContinued(owned.id, receiptID: owned.receiptID))
            let canceled = try seed(store, stage: .provenanceRead, receipt: UUID())
            try delivery.cancel(canceled.id, accountID: 42)
            XCTAssertEqual(try delivery.pauseUnclaimedContinued(), [])
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: owned.id.uuidString)?.stopRequestedAt)
            XCTAssertNotNil(try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: canceled.id.uuidString)?.canceledAt)
            XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: canceled.id.uuidString))
        }
    }

    @MainActor func testStaleForeignGetRequiresSessionLockThenRetainsExactReceiptAndUnknownEvidence() throws {
        try fixture { delivery, store, _ in
            for receipt in [nil, UUID()] as [UUID?] {
                let job = try seed(store, stage: .provenanceRead, receipt: receipt)
                let now = try XCTUnwrap(job.transferStarted).addingTimeInterval(31)
                let session = try XCTUnwrap(job.transferSession)
                if receipt == nil {
                    XCTAssertNil(try delivery.recoverStaleForeignRead(job.id, transferID: "foreign-read", receiptID: job.id, sessionIdentifier: session, now: now))
                    try delivery.attach(session)
                }
                let recovered = try XCTUnwrap(delivery.recoverStaleForeignRead(job.id, transferID: "foreign-read", receiptID: receipt ?? job.id, sessionIdentifier: session, now: now))
                XCTAssertEqual(recovered.stage, .provenanceRead)
                XCTAssertEqual(recovered.receiptID, receipt)
                XCTAssertNil(recovered.transferID)
                XCTAssertEqual(recovered.draft.blockID, 900)
                XCTAssertEqual(recovered.connected, [101, 102])
                XCTAssertEqual(recovered.lastTransferOutcome?.responseMissing, true)
                XCTAssertEqual(recovered.lastTransferOutcome?.receiptID, receipt ?? job.id)
                XCTAssertNil(recovered.lastTransferOutcome?.status)
                XCTAssertEqual(try delivery.request(recovered, token: "fixture").request.httpMethod, "GET")
                XCTAssertNil(try delivery.accept(.init(status: 200, body: Data(), error: nil, retryAfter: nil), id: job.id, transferID: "foreign-read"))
            }
        }
    }

    @MainActor func testFreshUnknownAgeChangedReceiptAndChangedTransferCannotBeRotated() throws {
        try fixture { delivery, store, _ in
            var job = try seed(store, stage: .provenanceRead, receipt: UUID())
            let session = try XCTUnwrap(job.transferSession), receipt = try XCTUnwrap(job.receiptID)
            let started = try XCTUnwrap(job.transferStarted)
            try delivery.attach(session)
            for interval: TimeInterval in [0, 29, 30] {
                XCTAssertNil(try delivery.recoverStaleForeignRead(job.id, transferID: "foreign-read", receiptID: receipt, sessionIdentifier: session, now: started.addingTimeInterval(interval)))
            }
            XCTAssertNil(try delivery.recoverStaleForeignRead(job.id, transferID: "foreign-read", receiptID: UUID(), sessionIdentifier: session, now: started.addingTimeInterval(31)))
            XCTAssertNil(try delivery.recoverStaleForeignRead(job.id, transferID: "different", receiptID: receipt, sessionIdentifier: session, now: started.addingTimeInterval(31)))
            job.transferStarted = nil
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            XCTAssertNil(try delivery.recoverStaleForeignRead(job.id, transferID: "foreign-read", receiptID: receipt, sessionIdentifier: session))
            XCTAssertEqual(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString)?.transferID, "foreign-read")
        }
    }

    @MainActor func testForeignMutationAndCurrentProcessGetNeverUseElapsedTimeReplay() throws {
        try fixture { delivery, store, _ in
            try delivery.attach("fixture.foreign.delivery")
            for stage: CaptureDeliveryStage in [.presign, .upload, .create, .connect, .update, .provenanceWrite] {
                let job = try seed(store, stage: stage, receipt: UUID())
                XCTAssertNil(try delivery.recoverStaleForeignRead(job.id, transferID: "foreign-read", receiptID: job.receiptID!, sessionIdentifier: "fixture.foreign.delivery", now: job.transferStarted!.addingTimeInterval(86_400)))
                XCTAssertEqual(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString)?.stage, stage)
            }
            var current = try seed(store, stage: .provenanceRead, receipt: UUID())
            current.transferID = nil; current.transferSession = nil
            try store.save(current, account: 0, kind: "delivery", id: current.id.uuidString)
            current = try XCTUnwrap(delivery.reserveTransfer(current, transferID: "current-read"))
            try delivery.attach(current.transferSession!)
            XCTAssertNil(try delivery.recoverStaleForeignRead(current.id, transferID: "current-read", receiptID: current.receiptID!, sessionIdentifier: current.transferSession!, now: current.transferStarted!.addingTimeInterval(86_400)))
        }
    }

    @MainActor func testCanceledForeignReadCannotBeReopenedByRollbackDraftOrElapsedTime() throws {
        try fixture { delivery, store, _ in
            let job = try seed(store, stage: .provenanceRead, receipt: UUID())
            try delivery.attach(job.transferSession!)
            try delivery.cancel(job.id, accountID: 42)
            // Simulate an older writer restoring its previously decoded journal.
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            XCTAssertNil(try delivery.recoverStaleForeignRead(job.id, transferID: "foreign-read", receiptID: job.receiptID!, sessionIdentifier: job.transferSession!, now: job.transferStarted!.addingTimeInterval(31)))
            XCTAssertNotNil(try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: job.id.uuidString)?.canceledAt)
        }
    }

    @MainActor private func fixture(_ action: (CaptureDelivery, CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        try action(delivery, store, root)
    }

    @MainActor private func seed(_ store: CaptureStore, stage: CaptureDeliveryStage, receipt: UUID?) throws -> DeliveryJob {
        let channel = Channel(id: 101, title: "Inbox", slug: "inbox", visibility: "private", owner: .init(id: 42, name: "Fixture", slug: "fixture", type: "User"))
        var draft = CaptureDraft(accountID: 42, defaultChannel: channel, input: "https://example.test/article")
        draft.blockID = 900; draft.phase = .checking
        var job = DeliveryJob(id: draft.id, receiptID: receipt, draft: draft, prepared: .init(payload: [:], update: [:]), attemptedChannelIDs: [101, 102], contentVerified: true, stage: stage, transferID: "foreign-read", transferSession: "fixture.foreign.delivery", transferStarted: Date().addingTimeInterval(-86_400), connected: [101, 102])
        job.provenance = try CaptureConnectionProvenance(draft: { var d = draft; d.provenanceChannelID = 101; return d }(), prepared: job.prepared)
        job.provenanceConnectionID = 777
        try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
        return job
    }
}
