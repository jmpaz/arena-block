import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureUI

final class CaptureCreateWindowTests: XCTestCase {
    @MainActor func testHundredPageAccountFindsExistingCreateUsingOlderSentinelThenStopsAtOneOfTwo() throws {
        try fixture { delivery, store in
            var job = try seed(store)
            XCTAssertTrue(try delivery.prepareRetainedInspection(job.id, minimumInterval: 60))
            job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            let stop = job.stopRequestedAt
            XCTAssertTrue(job.readOnlyReconciliation == true)
            XCTAssertEqual(try delivery.request(job, token: "fixture").request.httpMethod, "GET")
            // The live API ranks pages, then returns their hydrated rows in
            // ascending order. Row order does not invalidate the page range.
            let first = (0..<99).map { row(8_000 + $0, at: TimeInterval(-600 + $0)) } + [row(900, at: 20, capture: job.id)]
            delivery.consume(try page(1, rows: first), job: &job)
            XCTAssertEqual(job.stage, .reconcile); XCTAssertNil(job.draft.blockID)
            job = try JSONDecoder().decode(DeliveryJob.self, from: JSONEncoder().encode(job))
            delivery.consume(try page(2, rows: (0..<100).map { row(7_000 + $0, at: TimeInterval(-1_000 + $0)) }), job: &job)
            XCTAssertEqual(job.stage, .read); XCTAssertEqual(job.draft.blockID, 900)
            XCTAssertEqual(job.stopRequestedAt, stop)
            XCTAssertEqual(try delivery.request(job, token: "fixture").request.httpMethod, "GET")
            delivery.consume(try response(.object(["id": .number(900), "state": .string("available")])), job: &job)
            XCTAssertEqual(job.stage, .verify)
            delivery.consume(try response(.object(["id": .number(900), "state": .string("available")])), job: &job)
            XCTAssertEqual(job.stage, .connections)
            delivery.consume(try response(.object(["data": .array([.object(["id": .number(101)])]), "meta": .object(["has_more_pages": .bool(false)])])), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.connected, [101]); XCTAssertEqual(job.draft.blockID, 900)
            XCTAssertEqual(job.stopRequestedAt, stop)
            XCTAssertThrowsError(try delivery.request(job, token: "fixture"))
            XCTAssertEqual(job.attemptedChannelIDs, [101])
        }
    }

    @MainActor func testDuplicateCaptureIDsAcrossPagesAreRejectedBeforeBoundaryAcceptance() throws {
        try fixture { delivery, store in
            var job = try seed(store, checking: true)
            delivery.consume(try page(1, rows: [row(900, at: 20, capture: job.id)]), job: &job)
            delivery.consume(try page(2, rows: [row(901, at: 10, capture: job.id), row(700, at: -600)]), job: &job)
            XCTAssertEqual(job.stage, .attention); XCTAssertNil(job.draft.blockID)
            XCTAssertEqual(job.draft.phase, .uncertain)
            XCTAssertTrue(job.problem?.contains("Multiple blocks") == true)
        }
    }

    @MainActor func testMissingDatesWrongActorAndReversedPageRangesNeverPermitEarlyAcceptance() throws {
        try fixture { delivery, store in
            for variant in 0..<4 {
                var job = try seed(store, checking: true)
                var candidate = row(900, at: 20, capture: job.id)
                if variant == 0 { candidate = .object(["id": .number(900), "metadata": .object(["arena_capture_id": .string(job.id.uuidString)]), "user": .object(["id": .number(42)])]) }
                if variant == 1 { candidate = row(900, at: 20, capture: job.id, actor: 99) }
                delivery.consume(try page(1, rows: [candidate, row(800, at: -600)]), job: &job)
                let second = variant == 2 ? [row(701, at: 30), row(700, at: -900)] : [row(701, at: -601), row(700, at: -900)]
                if variant == 3 { job.reconcileWindow = nil } // A legacy mid-scan relaunch.
                delivery.consume(try page(2, rows: second), job: &job)
                XCTAssertEqual(job.stage, .reconcile); XCTAssertNil(job.draft.blockID)
                delivery.consume(try page(3, rows: [row(600, at: -1_000)]), job: &job)
                XCTAssertEqual(job.stage, .reconcile); XCTAssertNil(job.draft.blockID)
            }
        }
    }

    @MainActor func testEqualPageBoundaryNeedsAnotherStrictlyOlderSentinel() throws {
        try fixture { delivery, store in
            var job = try seed(store, checking: true)
            delivery.consume(try page(1, rows: [row(900, at: 20, capture: job.id), row(800, at: -600)]), job: &job)
            delivery.consume(try page(2, rows: [row(701, at: -600), row(700, at: -700)]), job: &job)
            XCTAssertEqual(job.stage, .reconcile); XCTAssertNil(job.draft.blockID)
            job = try JSONDecoder().decode(DeliveryJob.self, from: JSONEncoder().encode(job))
            delivery.consume(try page(3, rows: [row(600, at: -800)]), job: &job)
            XCTAssertEqual(job.stage, .read); XCTAssertEqual(job.draft.blockID, 900)
        }
    }

    @MainActor func testTerminalPageCannotBypassActorDateRangeOrLegacyWindowProof() throws {
        try fixture { delivery, store in
            for variant in 0..<4 {
                var job = try seed(store, checking: true)
                var candidate = row(900, at: 20, capture: job.id)
                if variant == 0 { candidate = .object(["id": .number(900), "metadata": .object(["arena_capture_id": .string(job.id.uuidString)]), "user": .object(["id": .number(42)])]) }
                if variant == 1 { candidate = row(900, at: 20, capture: job.id, actor: 99) }
                delivery.consume(try page(1, rows: [candidate]), job: &job)
                if variant == 3 { job.reconcileWindow = nil }
                let final = variant == 2 ? row(700, at: 30) : row(700, at: -900)
                delivery.consume(try response(.object(["data": .array([final]), "meta": .object(["has_more_pages": .bool(false)])])), job: &job)
                XCTAssertEqual(job.stage, .attention); XCTAssertNil(job.draft.blockID)
                XCTAssertEqual(job.draft.phase, .uncertain)
                XCTAssertThrowsError(try delivery.request(job, token: "fixture"))
            }
        }
    }

    @MainActor func testCandidateBeforeAdmissionAllowanceCannotUseCausalBoundary() throws {
        try fixture { delivery, store in
            var job = try seed(store, checking: true)
            delivery.consume(try page(1, rows: [row(900, at: -301, capture: job.id)]), job: &job)
            delivery.consume(try page(2, rows: [row(700, at: -600)]), job: &job)
            XCTAssertEqual(job.stage, .reconcile); XCTAssertNil(job.draft.blockID)
        }
    }

    @MainActor func testBoundExhaustionWithCandidateButNoCausalBoundaryRemainsUnknown() throws {
        try fixture { delivery, store in
            var job = try seed(store, checking: true)
            delivery.consume(try page(1, rows: [row(900, at: 20, capture: job.id)]), job: &job)
            for number in 2...10 { delivery.consume(try page(number, rows: [row(800 - number, at: TimeInterval(20 - number))]), job: &job) }
            XCTAssertEqual(job.stage, .attention); XCTAssertNil(job.draft.blockID)
            XCTAssertEqual(job.draft.phase, .uncertain)
            XCTAssertThrowsError(try delivery.request(job, token: "fixture"))
        }
    }

    @MainActor func testRestartAtPageOneDiscardsPreviousCandidateAndOrderingProof() throws {
        try fixture { delivery, store in
            var job = try seed(store, checking: true)
            delivery.consume(try page(1, rows: [row(900, at: 20, capture: job.id)]), job: &job)
            job.page = 1
            delivery.consume(try page(1, rows: [row(901, at: 20, capture: job.id), row(800, at: -600)]), job: &job)
            delivery.consume(try page(2, rows: [row(700, at: -900)]), job: &job)
            XCTAssertEqual(job.stage, .read); XCTAssertEqual(job.draft.blockID, 901)
        }
    }

    @MainActor func testMalformedPagingCannotAcceptCandidateAtAnOlderBoundary() throws {
        try fixture { delivery, store in
            var job = try seed(store, checking: true)
            delivery.consume(try page(1, rows: [row(900, at: 20, capture: job.id), row(800, at: -600)]), job: &job)
            delivery.consume(try response(.object(["data": .array([row(700, at: -900)]), "meta": .object(["has_more_pages": .bool(true), "current_page": .number(2), "next_page": .number(4), "total_pages": .number(100)])])), job: &job)
            XCTAssertEqual(job.stage, .attention); XCTAssertNil(job.draft.blockID)
        }
    }

    @MainActor func testUnknownCreateInspectionIsThrottledAndNeverReopensUnsentOrCanceledWork() throws {
        try fixture { delivery, store in
            var job = try seed(store)
            let now = Date()
            XCTAssertTrue(try delivery.prepareRetainedInspection(job.id, minimumInterval: 60, now: now))
            job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            job.stage = .attention
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            XCTAssertFalse(try delivery.prepareRetainedInspection(job.id, minimumInterval: 60, now: now.addingTimeInterval(59)))
            XCTAssertTrue(try delivery.prepareRetainedInspection(job.id, minimumInterval: 60, now: now.addingTimeInterval(60)))
            try delivery.cancel(job.id, accountID: 42)
            XCTAssertFalse(try delivery.prepareRetainedInspection(job.id, now: now.addingTimeInterval(120)))
            var unsent = try seed(store)
            unsent.draft.phase = .queued; unsent.resumeStage = .rendering; unsent.attemptedChannelIDs = []
            try store.save(unsent, account: 0, kind: "delivery", id: unsent.id.uuidString)
            XCTAssertFalse(try delivery.prepareRetainedInspection(unsent.id))
        }
    }

    private let admission = Date(timeIntervalSince1970: 1_800_000_000)

    private func row(_ id: Int, at offset: TimeInterval, capture: UUID? = nil, actor: Int = 42) -> JSONValue {
        var object: [String: JSONValue] = ["id": .number(Double(id)), "created_at": .string(ISO8601DateFormatter().string(from: admission.addingTimeInterval(offset))), "user": .object(["id": .number(Double(actor))])]
        if let capture { object["metadata"] = .object(["arena_capture_id": .string(capture.uuidString)]) }
        return .object(object)
    }
    private func page(_ number: Int, rows: [JSONValue]) throws -> BackgroundHTTPResult {
        try response(.object(["data": .array(rows), "meta": .object(["current_page": .number(Double(number)), "next_page": .number(Double(number + 1)), "has_more_pages": .bool(true), "total_pages": .number(100), "total_count": .number(10_000)])]))
    }
    private func response(_ json: JSONValue) throws -> BackgroundHTTPResult {
        .init(status: 200, body: try JSONEncoder().encode(json), error: nil, retryAfter: nil)
    }
    @MainActor private func seed(_ store: CaptureStore, checking: Bool = false) throws -> DeliveryJob {
        let owner = Owner(id: 42, name: "Fixture", slug: "fixture", type: "User")
        var draft = CaptureDraft(accountID: 42, defaultChannel: .init(id: 101, title: "Inbox", slug: "inbox", visibility: "private", owner: owner), input: "https://example.test/article")
        draft.selection.toggle(.init(id: 102, title: "Selected", slug: "selected", visibility: "private", owner: owner)); draft.phase = .uncertain
        var job = DeliveryJob(id: draft.id, draft: draft, prepared: .init(payload: [:], update: [:]), attemptedChannelIDs: [101], resumeStage: .reconcile, stage: checking ? .reconcile : .attention, stopRequestedAt: admission.addingTimeInterval(20), createdAt: admission)
        job.draft.deliveryState = job.state
        try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
        return job
    }
    @MainActor private func fixture(_ action: (CaptureDelivery, CaptureStore) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        try action(delivery, store)
    }
}
