import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime
@testable import CaptureUI

final class CaptureRecoveredCreateTests: XCTestCase {
    @MainActor func testComposedVideoLostCreateFinalizesOnceThenAddsOnlyMissingPlacementAcrossRelaunches() throws {
        try fixture { first, store, root in
            let recovered = try recoveredVideo(first, store: store, root: root)
            let frozenPlan = recovered.draft.previewSnapshot?.plan
            let resumedStore = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let resumed = try makeDelivery(store: resumedStore, root: root)
            var job = try XCTUnwrap(resumedStore.value(DeliveryJob.self, account: 0, kind: "delivery", id: recovered.id.uuidString))
            XCTAssertEqual(job.reconciledCreate, true)
            let initial = try block(job, final: false)
            job = try exchange(resumed, job, json: initial, method: "GET", path: "/v3/blocks/900")
            XCTAssertEqual(job.stage, .update)
            let put = try XCTUnwrap(resumed.reserveTransfer(job, transferID: "finalize"))
            let beforeReply = try XCTUnwrap(CaptureStore(url: root.appendingPathComponent("capture.sqlite")).value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertNotNil(beforeReply.initialFieldsAttemptedAt)
            XCTAssertEqual(beforeReply.transferID, "finalize")
            let request = try resumed.request(put, token: "fixture")
            XCTAssertEqual(request.request.httpMethod, "PUT")
            XCTAssertEqual(request.request.url?.path, "/v3/blocks/900")
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.body)), .object(job.prepared.update))
            job = try XCTUnwrap(resumed.accept(try response(.object([:])), id: job.id, transferID: "finalize"))
            XCTAssertEqual(job.stage, .verify)

            let nextStore = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let next = try makeDelivery(store: nextStore, root: root)
            job = try XCTUnwrap(nextStore.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            job = try exchange(next, job, json: block(job, final: true), method: "GET", path: "/v3/blocks/900")
            XCTAssertTrue(job.contentVerified == true)
            job = try exchange(next, job, json: members([101]), method: "GET", path: "/v3/blocks/900/connections")
            job = try provenance(next, job)
            job = try exchange(next, job, json: members([101]), method: "GET", path: "/v3/blocks/900/connections")
            XCTAssertEqual(job.stage, .connect)
            XCTAssertTrue(next.preparePlacementValidation(&job))
            try nextStore.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            job = try exchange(next, job, json: .object(["id": .number(102), "can": .object(["add_to": .bool(true)])]), method: "GET", path: "/v3/channels/102")
            let connection = try XCTUnwrap(next.reserveTransfer(job, transferID: "missing-placement"))
            let connectionRequest = try next.request(connection, token: "fixture")
            let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(connectionRequest.body))
            XCTAssertEqual(connectionRequest.request.httpMethod, "POST")
            XCTAssertEqual(connectionRequest.request.url?.path, "/v3/connections")
            XCTAssertEqual(body["connectable_id"], .number(900))
            XCTAssertEqual(body["channel_ids"], .array([.number(102)]))
            XCTAssertEqual(connection.attemptedChannelIDs, [101, 102])
            job = try XCTUnwrap(next.accept(try response(.object([:]), status: 201), id: job.id, transferID: "missing-placement"))
            job = try exchange(next, job, json: members([101, 102]), method: "GET", path: "/v3/blocks/900/connections")
            job = try provenance(next, job)
            XCTAssertEqual(job.stage, .done)
            XCTAssertEqual(job.draft.blockID, 900)
            XCTAssertEqual(job.draft.previewSnapshot?.plan, frozenPlan)
            XCTAssertEqual(job.draft.previewSnapshot?.selectedMedia, ["1.1"])
            XCTAssertEqual(job.receiptID ?? job.id, recovered.receiptID ?? recovered.id)
            XCTAssertNil(try nextStore.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
            XCTAssertEqual(try nextStore.value(DeliveryJob.self, account: 42, kind: "deliveryReceipt", id: job.id.uuidString)?.connected, [101, 102])
        }
    }

    @MainActor func testRecoveredVideoPreservesCustomTitleDescriptionMissingBodyAndWrongIdentity() throws {
        try fixture { delivery, store, root in
            for variant in 0..<6 {
                let job = try recoveredVideo(delivery, store: store, root: root)
                var changed = try block(job, final: false).object
                if variant == 0 { changed["title"] = .string("Edited later in Are.na") }
                if variant == 1 { changed["description"] = .object(["markdown": .string("My later notes")]) }
                if variant == 2 { changed.removeValue(forKey: "description") }
                if variant == 3 { changed["user"] = .object(["id": .number(99)]) }
                if variant == 4 { changed["description"] = .string((job.prepared.payload["description"]?.string ?? "") + "\n") }
                if variant == 5 { var metadata = changed["metadata"]!.object; metadata["arena_block_plan"] = .string(String(repeating: "0", count: 64)); changed["metadata"] = .object(metadata) }
                let retained = try exchange(delivery, job, json: .object(changed), method: "GET", path: "/v3/blocks/900")
                XCTAssertEqual(retained.stage, .attention)
                XCTAssertEqual(retained.draft.blockID, 900)
                XCTAssertEqual(retained.block, .object(changed))
                XCTAssertNil(retained.initialFieldsAttemptedAt)
                XCTAssertThrowsError(try delivery.request(retained, token: "fixture"))
                XCTAssertNil(try delivery.reserveTransfer(job, transferID: "stale-finalize"))
            }
        }
    }

    @MainActor func testAlreadyFinalRecoveredVideoUsesReadbackWithoutAnotherPut() throws {
        try fixture { delivery, store, root in
            let job = try recoveredVideo(delivery, store: store, root: root)
            var final = try exchange(delivery, job, json: block(job, final: true), method: "GET", path: "/v3/blocks/900")
            XCTAssertEqual(final.stage, .verify)
            XCTAssertNil(final.initialFieldsAttemptedAt)
            final = try exchange(delivery, final, json: block(final, final: true), method: "GET", path: "/v3/blocks/900")
            XCTAssertTrue(final.contentVerified == true)
            XCTAssertEqual(final.stage, .connections)
        }
    }

    @MainActor func testNormalAcknowledgedCreateKeepsItsAcquisitionPath() throws {
        try fixture { delivery, store, root in
            let job = try recoveredVideo(delivery, store: store, root: root, loseReply: false)
            XCTAssertNil(job.reconciledCreate)
            let read = try exchange(delivery, job, json: block(job, final: false), method: "GET", path: "/v3/blocks/900")
            XCTAssertEqual(read.stage, .update)
            let admitted = try XCTUnwrap(delivery.reserveTransfer(read, transferID: "normal-finalize"))
            XCTAssertNotNil(admitted.initialFieldsAttemptedAt)
            XCTAssertEqual(try delivery.request(admitted, token: "fixture").request.httpMethod, "PUT")
        }
    }

    @MainActor func testRecoveredTextFinishesExactGeneratedBodyWithoutChangingQuoteComposition() throws {
        try fixture { delivery, store, root in
            let job = try recoveredVideo(delivery, store: store, root: root, video: false)
            let plan = try XCTUnwrap(job.draft.previewSnapshot?.plan)
            XCTAssertTrue(plan["block"]?["markdown"]?.string?.contains("Quoted thought.") == true)
            var read = try exchange(delivery, job, json: block(job, final: false), method: "GET", path: "/v3/blocks/900")
            XCTAssertEqual(read.stage, .update)
            read = try exchange(delivery, read, json: .object([:]), method: "PUT", path: "/v3/blocks/900")
            read = try exchange(delivery, read, json: block(read, final: true), method: "GET", path: "/v3/blocks/900")
            XCTAssertTrue(read.contentVerified == true)
            XCTAssertEqual(read.draft.previewSnapshot?.plan, plan)
            XCTAssertEqual(read.draft.previewSnapshot?.selectedMedia, [])
        }
    }

    @MainActor func testUnclaimedForegroundAndUserPauseKeepGeneratedPlaceholderReadOnly() throws {
        try fixture { delivery, store, root in
            for foreground in [false, true] {
                let job = try recoveredVideo(delivery, store: store, root: root)
                let current: CaptureDelivery
                let currentStore: CaptureStore
                if foreground {
                    XCTAssertTrue(try delivery.beginContinued(job.id))
                    currentStore = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
                    current = try makeDelivery(store: currentStore, root: root)
                    XCTAssertTrue(try current.prepareForeground(isMainApplication: true).contains(job.id))
                } else {
                    current = delivery; currentStore = store
                    try current.requestStop(job.id)
                }
                let stopped = try XCTUnwrap(currentStore.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
                XCTAssertNotNil(stopped.stopRequestedAt)
                let read = try exchange(current, stopped, json: block(stopped, final: false), method: "GET", path: "/v3/blocks/900")
                XCTAssertEqual(read.stage, .verify)
                let retained = try exchange(current, read, json: block(read, final: false), method: "GET", path: "/v3/blocks/900")
                XCTAssertEqual(retained.stage, .attention)
                XCTAssertNotNil(retained.stopRequestedAt)
                XCTAssertNil(retained.initialFieldsAttemptedAt)
                XCTAssertFalse(retained.contentVerified == true)
                XCTAssertNil(try current.reserveTransfer(retained, transferID: "forbidden-finalize"))
            }
        }
    }

    @MainActor func testCancelBeforeOrAfterFinalizationAdmissionNeverAddsAPlacement() throws {
        try fixture { delivery, store, root in
            for alreadyAdmitted in [false, true] {
                let job = try recoveredVideo(delivery, store: store, root: root)
                let update = try exchange(delivery, job, json: block(job, final: false), method: "GET", path: "/v3/blocks/900")
                let inFlight = alreadyAdmitted ? try XCTUnwrap(delivery.reserveTransfer(update, transferID: "put-before-cancel")) : update
                try delivery.cancel(job.id, accountID: 42)
                XCTAssertNil(try delivery.reserveTransfer(inFlight, transferID: "after-cancel"))
                if alreadyAdmitted {
                    let canceled = try XCTUnwrap(delivery.accept(try response(.object([:])), id: job.id, transferID: "put-before-cancel"))
                    XCTAssertNotNil(canceled.canceledAt)
                    XCTAssertNotNil(canceled.initialFieldsAttemptedAt)
                    XCTAssertEqual(canceled.draft.blockID, 900)
                    XCTAssertEqual(canceled.connected, [])
                    XCTAssertThrowsError(try delivery.request(canceled, token: "fixture"))
                }
                XCTAssertNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
                XCTAssertNotNil(try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: job.id.uuidString)?.canceledAt)
                XCTAssertNil(try store.value(DeliveryJob.self, account: 42, kind: "deliveryReceipt", id: job.id.uuidString))
            }
        }
    }

    @MainActor func testUnknownFinalizationReadsAppliedFieldsButNeverReplaysARestoredPlaceholder() throws {
        try fixture { delivery, store, root in
            for applied in [false, true] {
                let job = try recoveredVideo(delivery, store: store, root: root)
                let ready = try exchange(delivery, job, json: block(job, final: false), method: "GET", path: "/v3/blocks/900")
                let admitted = try XCTUnwrap(delivery.reserveTransfer(ready, transferID: "unknown-put"))
                let reopenedStore = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
                let reopened = try makeDelivery(store: reopenedStore, root: root)
                var unknown = try XCTUnwrap(reopened.recoverMissingTransfer(admitted.id, transferID: "unknown-put"))
                XCTAssertEqual(unknown.stage, .verify)
                XCTAssertNotNil(unknown.initialFieldsAttemptedAt)
                unknown = try exchange(reopened, unknown, json: block(unknown, final: applied), method: "GET", path: "/v3/blocks/900")
                if applied {
                    XCTAssertTrue(unknown.contentVerified == true)
                    XCTAssertEqual(unknown.stage, .connections)
                } else {
                    XCTAssertEqual(unknown.stage, .attention)
                    XCTAssertTrue(try reopened.prepareRetainedInspection(unknown.id))
                    // Inspection changes stage to read. Finish that read-only
                    // attempt before an explicit destination continuation.
                    var inspecting = try XCTUnwrap(reopenedStore.value(DeliveryJob.self, account: 0, kind: "delivery", id: unknown.id.uuidString))
                    inspecting = try exchange(reopened, inspecting, json: block(inspecting, final: false), method: "GET", path: "/v3/blocks/900")
                    inspecting = try exchange(reopened, inspecting, json: block(inspecting, final: false), method: "GET", path: "/v3/blocks/900")
                    let targets = try XCTUnwrap(reopened.continuationTargets(inspecting.id))
                    XCTAssertTrue(try reopened.reaffirmContinuation(inspecting.id, channelIDs: targets))
                    let continued = try XCTUnwrap(reopenedStore.value(DeliveryJob.self, account: 0, kind: "delivery", id: unknown.id.uuidString))
                    let refused = try exchange(reopened, continued, json: block(continued, final: false), method: "GET", path: "/v3/blocks/900")
                    XCTAssertEqual(refused.stage, .attention)
                    XCTAssertTrue(refused.problem?.contains("earlier content update") == true)
                    XCTAssertNotNil(refused.initialFieldsAttemptedAt)
                    XCTAssertThrowsError(try reopened.request(refused, token: "fixture"))
                }
            }
        }
    }

    @MainActor private func recoveredVideo(_ delivery: CaptureDelivery, store: CaptureStore, root: URL, loseReply: Bool = true, video: Bool = true) throws -> DeliveryJob {
        var draft = CaptureDraft(accountID: 42, defaultChannel: channel(101), input: "https://www.tiktok.com/@fixture/video/123")
        draft.selection.toggle(channel(102)); draft.provenanceChannelID = 101; draft.defaultChannelMode = .always
        let encodedSources: String
        if video { encodedSources = #"[{"provider":"tiktok","id":"123","canonicalUrl":"https://www.tiktok.com/@fixture/video/123","author":{"handle":"fixture"},"text":"Captured caption.\n\n日本語 — café 👋","media":[{"ref":"1.1","kind":"video","url":"https://cdn.example.test/video.mp4","alt":"","width":640,"height":360,"durationSeconds":4}]}]"# }
        else {
            draft.input = "https://x.com/fixture/status/123"
            encodedSources = #"[{"provider":"x","id":"123","canonicalUrl":"https://x.com/fixture/status/123","author":{"handle":"fixture"},"text":"Captured caption.","media":[],"quote":{"provider":"x","id":"122","canonicalUrl":"https://x.com/quoted/status/122","author":{"handle":"quoted"},"text":"Quoted thought.","media":[]}}]"#
        }
        let sources = try JSONDecoder().decode(JSONValue.self, from: Data(encodedSources.utf8))
        let source = try CapturePreparation(runtime: CaptureRuntime(), container: root).compose(.init(draft: draft), sources: sources)
        XCTAssertEqual(source.preview.plan?["block"]?["kind"], .string(video ? "video" : "text"))
        XCTAssertNotEqual(source.prepared.payload["description"], source.prepared.update["description"])
        draft.previewSnapshot = source.preview
        let id = try delivery.persistSubmission(draft: draft, prepared: source.prepared, media: video ? root.appendingPathComponent("renders/video.mp4") : nil, contentType: video ? "video/mp4" : nil)
        var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
        job.stage = video ? .upload : .create; job.uploadURL = "https://uploads.example.test/upload"; job.uploadedSource = video ? "https://media.example.test/video.mp4" : nil; job.uploadExpiry = Date().addingTimeInterval(3_600)
        try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
        if video { job = try exchange(delivery, job, json: .object([:]), method: "PUT", path: "/upload") }
        XCTAssertEqual(job.stage, .create)
        let create = try XCTUnwrap(delivery.reserveTransfer(job, transferID: UUID().uuidString))
        let creation = try delivery.request(create, token: "fixture")
        XCTAssertEqual(creation.request.httpMethod, "POST"); XCTAssertEqual(creation.request.url?.path, "/v3/blocks")
        let creationBody = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(creation.body))
        XCTAssertEqual(creationBody["description"], job.prepared.payload["description"])
        XCTAssertEqual(creationBody["channels"]?.array.compactMap { $0["id"]?.int }, [101])
        if !loseReply { return try XCTUnwrap(delivery.accept(try response(.object(["id": .number(900)]), status: 201), id: id, transferID: create.transferID!)) }
        job = try XCTUnwrap(delivery.accept(.init(status: 201, body: Data(), error: "Response lost after send", retryAfter: nil, errorCode: NSURLErrorNetworkConnectionLost, errorDomain: NSURLErrorDomain), id: id, transferID: create.transferID!))
        XCTAssertEqual(job.stage, .reconcile); XCTAssertNil(job.draft.blockID)
        let match: JSONValue = .object(["id": .number(900), "created_at": .string(ISO8601DateFormatter().string(from: job.createdAt)), "user": .object(["id": .number(42)]), "metadata": .object(["arena_capture_id": .string(id.uuidString)])])
        job = try exchange(delivery, job, json: .object(["data": .array([match]), "meta": .object(["has_more_pages": .bool(false)])]), method: "GET", path: "/v3/users/42/contents")
        XCTAssertEqual(job.stage, .read); XCTAssertEqual(job.draft.blockID, 900); XCTAssertEqual(job.reconciledCreate, true)
        return job
    }

    @MainActor private func block(_ job: DeliveryJob, final: Bool) throws -> JSONValue {
        var metadata = job.prepared.payload["metadata"]?.object ?? [:]; metadata["arena_capture_id"] = .string(job.id.uuidString)
        var result: [String: JSONValue] = ["id": .number(900), "state": .string("available"), "type": .string(job.draft.previewSnapshot?.plan?["block"]?["kind"] == .string("text") ? "Text" : "Attachment"), "user": .object(["id": .number(42)]), "metadata": .object(metadata), "title": try XCTUnwrap(job.prepared.update["title"]), "description": .object(["markdown": try XCTUnwrap(final ? job.prepared.update["description"] : job.prepared.payload["description"])]), "attachment": .object(["content_type": .string("video/mp4")])]
        if let content = job.prepared.update["content"] { result["content"] = .object(["markdown": final ? content : try XCTUnwrap(job.prepared.payload["value"])]) }
        return .object(result)
    }
    @MainActor private func provenance(_ delivery: CaptureDelivery, _ job: DeliveryJob) throws -> DeliveryJob {
        var job = try exchange(delivery, job, json: .object(["data": .array([.object(["id": .number(900), "type": .string("Attachment"), "connection": .object(["id": .number(777)])])]), "meta": .object(["has_more_pages": .bool(false)])]), method: "GET", path: "/v3/channels/101/contents")
        job = try exchange(delivery, job, json: .object(["id": .number(777), "connected_by": .object(["id": .number(42)]), "metadata": .object(try XCTUnwrap(job.provenance?.metadata))]), method: "GET", path: "/v3/connections/777")
        return job
    }
    @MainActor private func exchange(_ delivery: CaptureDelivery, _ job: DeliveryJob, json: JSONValue, method: String, path: String) throws -> DeliveryJob {
        let transfer = UUID().uuidString
        let admitted = try XCTUnwrap(delivery.reserveTransfer(job, transferID: transfer))
        let request = try delivery.request(admitted, token: "fixture")
        XCTAssertEqual(request.request.httpMethod, method); XCTAssertEqual(request.request.url?.path, path)
        return try XCTUnwrap(delivery.accept(try response(json), id: job.id, transferID: transfer))
    }
    private func members(_ ids: [Int]) -> JSONValue { .object(["data": .array(ids.map { .object(["id": .number(Double($0))]) }), "meta": .object(["has_more_pages": .bool(false)])]) }
    private func response(_ json: JSONValue, status: Int = 200) throws -> BackgroundHTTPResult { .init(status: status, body: try JSONEncoder().encode(json), error: nil, retryAfter: nil) }
    private func channel(_ id: Int) -> Channel { .init(id: id, title: "Channel \(id)", slug: "channel-\(id)", visibility: "private", owner: .init(id: 42, name: "Fixture", slug: "fixture", type: "User")) }
    @MainActor private func makeDelivery(store: CaptureStore, root: URL) throws -> CaptureDelivery { try .init(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil) }
    @MainActor private func fixture(_ action: (CaptureDelivery, CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        try action(makeDelivery(store: store, root: root), store, root)
    }
}
