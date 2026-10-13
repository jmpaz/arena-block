import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime
@testable import CaptureUI

final class SubmissionTests: XCTestCase {
    @MainActor
    func testDurableSavePromotesSelectedChannelsBeforeRemoteCompletionWithoutDuplicateReordering() async throws {
        try await withDelivery { delivery, store, root in
            var first = self.draft()
            first.selection.toggle(self.channel(102))
            let firstID = try delivery.persistQueuedSubmission(draft: first)
            XCTAssertNotNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: firstID.uuidString))
            XCTAssertEqual(try store.recordIDs(account: first.accountID, kind: "recent"), ["101", "102"])

            var second = self.draft()
            second.selection = DestinationSelection(defaultChannel: self.channel(103))
            _ = try delivery.persistQueuedSubmission(draft: second)
            XCTAssertEqual(try store.recordIDs(account: first.accountID, kind: "recent"), ["103", "101", "102"])
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            XCTAssertEqual(try reopened.recordIDs(account: first.accountID, kind: "recent"), ["103", "101", "102"])

            XCTAssertEqual(try delivery.persistQueuedSubmission(draft: first), firstID)
            XCTAssertEqual(try store.recordIDs(account: first.accountID, kind: "recent"), ["103", "101", "102"])
        }
    }

    @MainActor
    func testUnclaimedContinuedTaskCannotAutoSubmitAfterRestart() async throws {
        try await withDelivery { delivery, store, root in
            let id = try delivery.persistQueuedSubmission(draft: self.draft())
            XCTAssertTrue(try delivery.beginContinued(id))
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            XCTAssertNotNil(try reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)?.continuedRequestedAt)
            delivery.deactivateContinued(id) // A new process has no in-memory task owner.
            await delivery.resume()
            let held = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(held.stage, .queued)
            XCTAssertNil(held.transferID)
            XCTAssertEqual(try delivery.pauseUnclaimedContinued(), [id])
            let stopped = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertNotNil(stopped.stopRequestedAt)
            XCTAssertNil(stopped.continuedRequestedAt)
            XCTAssertNil(try delivery.reserveTransfer(held, transferID: "late-create"))
        }
    }

    @MainActor
    func testExpiredContinuedCreateKeepsUUIDAndReconcilesLateResult() async throws {
        try await withDelivery { delivery, store, _ in
            let id = try delivery.persistQueuedSubmission(draft: self.draft())
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.stage = .create; job.attemptedChannelIDs = [101]
            job.transferID = "create-in-flight"; job.transferSession = "fixture.delivery"; job.transferStarted = Date()
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            XCTAssertTrue(try delivery.beginContinued(id))
            delivery.deactivateContinued(id)
            XCTAssertEqual(try delivery.pauseUnclaimedContinued(), [id])
            let unknown = try XCTUnwrap(delivery.accept(.init(status: nil, body: Data(), error: "cancelled after send", retryAfter: nil), id: id, transferID: "create-in-flight"))
            XCTAssertEqual(unknown.id, id)
            XCTAssertEqual(unknown.stage, .reconcile)
            XCTAssertEqual(try delivery.request(unknown, token: "fixture").request.httpMethod, "GET")
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "duplicate-create"))
        }
    }

    @MainActor
    func testStopDuringSlowSourceReadCannotCommitLatePreparation() async throws {
        try await withDelivery { delivery, store, root in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            let started = expectation(description: "source read started")
            let prepared = try self.composed(source, root: root)
            delivery.readSource = { _ in
                started.fulfill()
                try? await Task.sleep(for: .milliseconds(150)) // Simulate a provider that ignores cancellation.
                return prepared
            }
            let reading = Task { await delivery.check(id) }
            await fulfillment(of: [started], timeout: 2)
            try delivery.requestStop(id)
            await reading.value
            let stopped = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(stopped.stage, .attention)
            XCTAssertEqual(stopped.state.stopRequested, true)
            XCTAssertNil(stopped.draft.blockID)
            XCTAssertNil(stopped.transferID)
            XCTAssertNil(stopped.draft.publicationKey)
            XCTAssertEqual(stopped.resumeStage, .reading)
        }
    }

    @MainActor
    func testStopDuringSlowMediaRenderDiscardsLateOutputBeforeCreate() async throws {
        try await withDelivery { delivery, store, root in
            var source = self.draft(); source.media = .all
            let id = try delivery.persistQueuedSubmission(draft: source)
            let prepared = try self.composed(source, root: root)
            let started = expectation(description: "media render started")
            let output = root.appendingPathComponent("late-render.jpg")
            delivery.readSource = { _ in prepared }
            delivery.renderSource = { _, _ in
                started.fulfill()
                try? await Task.sleep(for: .milliseconds(150)) // Simulate a renderer returning after Stop.
                try Data("fixture".utf8).write(to: output)
                return NativeRenderedMedia(fileURL: output, contentType: "image/jpeg", byteCount: 7)
            }
            let rendering = Task { await delivery.check(id) }
            await fulfillment(of: [started], timeout: 2)
            try delivery.requestStop(id)
            await rendering.value
            let stopped = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(stopped.stage, .attention)
            XCTAssertEqual(stopped.resumeStage, .rendering)
            XCTAssertTrue(stopped.draft.previewSnapshot?.selectedMedia.contains("1.1") == true)
            XCTAssertNil(stopped.draft.blockID)
            XCTAssertNil(stopped.transferID)
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
        }
    }

    @MainActor
    func testStopCancelsCooperativeSourcePreparationPromptly() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            let started = expectation(description: "source read started")
            var cancelled = false
            delivery.readSource = { _ in
                started.fulfill()
                do { try await Task.sleep(for: .seconds(30)) }
                catch { cancelled = true; throw error }
                XCTFail("Source preparation should have been cancelled")
                throw CancellationError()
            }
            let reading = Task { await delivery.check(id) }
            await fulfillment(of: [started], timeout: 2)
            try delivery.requestStop(id)
            await reading.value
            let stopped = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertTrue(cancelled)
            XCTAssertEqual(stopped.stage, .attention)
            XCTAssertEqual(stopped.state.stopRequested, true)
            XCTAssertNil(stopped.transferID)
        }
    }

    @MainActor
    func testStopBeforeCreateIsDurableAndFencesAllTransfers() async throws {
        try await withDelivery { delivery, store, root in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            let before = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            try delivery.requestStop(id)
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let stopped = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(stopped.id, id)
            XCTAssertEqual(stopped.stage, .attention)
            XCTAssertEqual(stopped.state.stopRequested, true)
            XCTAssertNil(stopped.draft.blockID)
            XCTAssertNil(stopped.transferID)
            XCTAssertNil(try delivery.reserveTransfer(before, transferID: "late-create"))
            try delivery.requestStop(id)
            XCTAssertEqual(try store.recordIDs(account: 0, kind: "delivery"), [id.uuidString])
        }
    }

    @MainActor
    func testContinueStoppedCaptureReusesFrozenUUIDAndDoesNotStartAnotherJob() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            try delivery.requestStop(id)
            delivery.readSource = { snapshot in
                XCTAssertEqual(snapshot.url, source.input)
                throw CaptureError.message("Offline during continued source read.")
            }
            await delivery.continueStopped(id)
            let continued = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(continued.id, id)
            XCTAssertNil(continued.stopRequestedAt)
            XCTAssertEqual(continued.stage, .attention)
            XCTAssertEqual(continued.resumeStage, .reading)
            XCTAssertNil(continued.transferID)
            XCTAssertEqual(try store.recordIDs(account: 0, kind: "delivery"), [id.uuidString])
        }
    }

    @MainActor
    func testStopAfterInFlightPlacementReadsActualConnectionsWithoutAnotherPost() async throws {
        try await withDelivery { delivery, store, root in
            var source = self.draft()
            source.selection.toggle(self.channel(102))
            let id = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.draft.blockID = 900; job.contentVerified = true
            job.stage = .connect; job.attemptedChannelIDs = [101, 102]
            job.transferID = "placement-102"; job.transferSession = "fixture.delivery"; job.transferStarted = Date()
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            try delivery.requestStop(id)
            XCTAssertEqual(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)?.transferID, "placement-102")
            let accepted = try XCTUnwrap(delivery.accept(.init(status: 201, body: Data("{}".utf8), error: nil, retryAfter: nil), id: id, transferID: "placement-102"))
            XCTAssertEqual(accepted.stage, .connections)
            XCTAssertFalse(delivery.shouldCancelTransferOnStop(accepted))
            XCTAssertEqual(try delivery.request(accepted, token: "fixture").request.httpMethod, "GET")
            let read = try XCTUnwrap(delivery.reserveTransfer(accepted, transferID: "placement-read"))
            XCTAssertEqual(read.stage, .connections)
            let stopped = try XCTUnwrap(delivery.accept(try self.members([101, 102]), id: id, transferID: "placement-read"))
            XCTAssertEqual(stopped.stage, .attention)
            XCTAssertEqual(stopped.connected, Set([101, 102]))
            XCTAssertEqual(stopped.state.stopRequested, true)
            XCTAssertEqual(stopped.draft.blockID, 900)
            XCTAssertNil(try delivery.reserveTransfer(accepted, transferID: "late-connect"))
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            XCTAssertEqual(try reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)?.connected, Set([101, 102]))
        }
    }

    @MainActor
    func testStopAfterUnknownCreateReconcilesWithoutSecondCreate() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.stage = .create; job.attemptedChannelIDs = [101]
            job.transferID = "create-unknown"; job.transferSession = "fixture.delivery"; job.transferStarted = Date()
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            try delivery.requestStop(id)
            let retainedCreate = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertTrue(delivery.shouldCancelTransferOnStop(retainedCreate))
            let unknown = try XCTUnwrap(delivery.accept(.init(status: nil, body: Data(), error: "connection lost", retryAfter: nil), id: id, transferID: "create-unknown"))
            XCTAssertEqual(unknown.stage, .reconcile)
            XCTAssertFalse(delivery.shouldCancelTransferOnStop(unknown))
            XCTAssertEqual(unknown.draft.phase, .uncertain)
            XCTAssertEqual(try delivery.request(unknown, token: "fixture").request.httpMethod, "GET")
            _ = try XCTUnwrap(delivery.reserveTransfer(unknown, transferID: "creation-read"))
            let none = JSONValue.object(["data": .array([]), "meta": .object(["has_more_pages": .bool(false)])])
            let unresolved = try XCTUnwrap(delivery.accept(.init(status: 200, body: try JSONEncoder().encode(none), error: nil, retryAfter: nil), id: id, transferID: "creation-read"))
            XCTAssertEqual(unresolved.stage, .attention)
            XCTAssertEqual(unresolved.draft.phase, .uncertain)
            XCTAssertEqual(unresolved.state.stopRequested, true)
            XCTAssertNil(unresolved.draft.blockID)
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "duplicate-create"))
        }
    }

    @MainActor
    func testStoppedUnknownCreateFoundOnReadbackKeepsBlockWithoutUpdatingIt() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.stage = .create; job.attemptedChannelIDs = [101]
            job.transferID = "create-lost"; job.transferSession = "fixture.delivery"; job.transferStarted = Date()
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            try delivery.requestStop(id)
            let unknown = try XCTUnwrap(delivery.accept(.init(status: nil, body: Data(), error: "lost response", retryAfter: nil), id: id, transferID: "create-lost"))
            let lookup = try XCTUnwrap(delivery.reserveTransfer(unknown, transferID: "find-create"))
            XCTAssertEqual(try delivery.request(lookup, token: "fixture").request.httpMethod, "GET")
            let found: JSONValue = .object(["data": .array([.object([
                "id": .number(900), "metadata": .object(["arena_capture_id": .string(id.uuidString)])
            ])]), "meta": .object(["has_more_pages": .bool(false)])])
            let known = try XCTUnwrap(delivery.accept(.init(status: 200, body: try JSONEncoder().encode(found), error: nil, retryAfter: nil), id: id, transferID: "find-create"))
            XCTAssertEqual(known.id, id)
            XCTAssertEqual(known.draft.blockID, 900)
            XCTAssertEqual(known.stage, .connections)
            XCTAssertFalse(known.contentVerified == true)
            XCTAssertEqual(try delivery.request(known, token: "fixture").request.httpMethod, "GET")
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "duplicate-create"))
        }
    }

    @MainActor
    func testStopOfExistingUnknownCreateStartsReadOnlyReconciliation() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.stage = .attention; job.resumeStage = .reconcile; job.draft.phase = .uncertain
            job.attemptedChannelIDs = [101]
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            try delivery.requestStop(id)
            let stopping = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(stopping.stage, .reconcile)
            XCTAssertEqual(stopping.state.stopRequested, true)
            XCTAssertEqual(try delivery.request(stopping, token: "fixture").request.httpMethod, "GET")
            XCTAssertFalse(delivery.shouldCancelTransferOnStop(stopping))
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "duplicate-create"))
        }
    }

    @MainActor
    func testStopDuringMediaUploadDoesNotAdvanceToBlockCreate() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.stage = .upload; job.transferID = "media-upload"; job.transferSession = "fixture.delivery"
            job.transferStarted = Date(); job.uploadedSource = "https://uploads.example.test/asset.jpg"
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            try delivery.requestStop(id)
            let stopped = try XCTUnwrap(delivery.accept(.init(status: 200, body: Data(), error: nil, retryAfter: nil), id: id, transferID: "media-upload"))
            XCTAssertEqual(stopped.stage, .attention)
            XCTAssertEqual(stopped.resumeStage, .create)
            XCTAssertNil(stopped.draft.blockID)
            XCTAssertNil(stopped.transferID)
            XCTAssertEqual(stopped.attemptedChannelIDs, [])
            XCTAssertNil(try delivery.reserveTransfer(job, transferID: "forbidden-create"))
        }
    }

    @MainActor
    func testFreshPreparationKeepsMediaOnlyExtraWithoutItsProse() async throws {
        try await withDelivery { delivery, _, root in
            let primary = "https://x.com/example/status/101"
            let extra = "https://x.com/example/status/102"
            let sources: JSONValue = .array([
                .object(["provider": .string("x"), "id": .string("101"), "canonicalUrl": .string(primary),
                         "author": .object(["handle": .string("example")]), "text": .string("Keep this primary text"),
                         "media": .array([]), "selection": .object(["role": .string("primary"), "origin": .string("explicit")])]),
                .object(["provider": .string("x"), "id": .string("102"), "canonicalUrl": .string(extra),
                         "author": .object(["handle": .string("example")]), "text": .string("Exclude this supplementary text"),
                         "media": .array([.object(["ref": .string("2.1"), "kind": .string("image"),
                                                   "url": .string("https://example.test/image.jpg"), "alt": .string("")])]),
                         "selection": .object(["role": .string("extra"), "origin": .string("explicit")])])
            ])
            var source = self.draft()
            source.input = "\(primary)\n\(extra)"
            source.sourceRoles = [.primary, .extra]
            source.media = .all
            source.phase = .ready
            source.previewSnapshot = CapturePreview(kind: "social", url: primary,
                plan: .object(["sources": sources]), inputRefs: [primary], extraInputRefs: [extra])
            let id = try delivery.persistQueuedSubmission(draft: source)
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let job = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            let snapshot = try XCTUnwrap(job.submission)
            XCTAssertEqual(snapshot.supplementaryRefs, [extra])
            let prepared = try await CapturePreparation(runtime: CaptureRuntime(), container: root).read(snapshot)
            XCTAssertEqual(prepared.preview.plan?["policy"]?["mediaOnlyPosts"], .array([.number(2)]))
            XCTAssertEqual(prepared.preview.selectedMedia, ["2.1"])
            XCTAssertTrue(prepared.preview.text.contains("Keep this primary text"))
            XCTAssertFalse(prepared.preview.text.contains("Exclude this supplementary text"))
            XCTAssertNil(job.draft.blockID)
        }
    }

    @MainActor
    func testFreshPreparationUsesFrozenExpandedSourcesWithoutDiscovery() async throws {
        try await withDelivery { delivery, _, root in
            let original = "https://bsky.app/profile/example.test/post/one"
            let connected = "https://bsky.app/profile/example.test/post/two"
            var source = self.draft()
            source.input = original
            source.media = .none
            source.phase = .ready
            source.previewSnapshot = CapturePreview(kind: "social", url: original, plan: .object(["sources": .array([
                .object(["provider": .string("bluesky"), "id": .string("one"), "canonicalUrl": .string(original),
                         "author": .object(["handle": .string("example.test")]), "text": .string("First exact post"), "media": .array([]),
                         "selection": .object(["role": .string("primary"), "origin": .string("explicit")])]),
                .object(["provider": .string("bluesky"), "id": .string("two"), "canonicalUrl": .string(connected),
                         "author": .object(["handle": .string("example.test")]), "text": .string("Connected exact post"), "media": .array([]),
                         "selection": .object(["role": .string("primary"), "origin": .string("expanded"), "parentUri": .string("at://example.test/app.bsky.feed.post/one")])])
            ])]), inputRefs: [original])
            let id = try delivery.persistQueuedSubmission(draft: source)
            source.input = "https://bsky.app/profile/example.test/post/changed"
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let job = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            let snapshot = try XCTUnwrap(job.submission)
            XCTAssertEqual(snapshot.preview?.plan?["sources"]?.array.count, 2)
            let fresh = CapturePreparation(runtime: try CaptureRuntime(), container: root)
            let prepared = try await fresh.read(snapshot)
            XCTAssertEqual(prepared.preview.plan?["sources"]?.array.count, 2)
            XCTAssertTrue(prepared.preview.text.contains("First exact post"))
            XCTAssertTrue(prepared.preview.text.contains("Connected exact post"))
            XCTAssertNil(job.draft.blockID)
            XCTAssertEqual(job.stage, .queued)
        }
    }

    @MainActor
    func testCommitBeforeProviderReadAndFreshDeliveryKeepsOrderedPostsFrozen() async throws {
        try await withDelivery { delivery, store, root in
            var source = self.draft()
            source.input = "https://x.com/person/status/123\nhttps://x.com/person/status/456"
            source.media = .selected; source.selectedMedia = ["1.1"]
            source.titleOverride = "Approved title"; source.descriptionOverride = "Approved description"
            var reads = 0
            delivery.readSource = { _ in XCTFail("The old delivery instance must not resume the job"); throw CaptureError.message("old instance") }
            let id = try delivery.persistQueuedSubmission(draft: source)
            XCTAssertEqual(reads, 0)
            source.input = "https://example.com/changed"; source.titleOverride = "Later edit"
            source.media = .none; source.selection.toggle(self.channel(102))
            XCTAssertEqual(try delivery.persistQueuedSubmission(draft: source), id)
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let job = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(job.stage, .queued)
            XCTAssertEqual(job.submission?.url, "https://x.com/person/status/123")
            XCTAssertEqual(job.submission?.sourceRefs, ["https://x.com/person/status/123", "https://x.com/person/status/456"])
            XCTAssertEqual(job.submission?.title, "Approved title")
            XCTAssertEqual(job.submission?.description, "Approved description")
            XCTAssertEqual(job.submission?.policy["selectedMedia"], .array([.string("1.1")]))
            XCTAssertEqual(job.draft.selection.channels.map(\.id), [101])
            XCTAssertEqual(try reopened.recordIDs(account: 0, kind: "delivery").count, 1)
            XCTAssertEqual(try reopened.recordIDs(account: source.accountID, kind: "draft").count, 1)
            let resumed = try CaptureDelivery(store: reopened, credentials: CredentialStore(accessGroup: nil),
                directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "restarted", ingestBase: "https://ingest.example.test")
            resumed.readSource = { submission in
                reads += 1
                XCTAssertEqual(submission.sourceRefs, ["https://x.com/person/status/123", "https://x.com/person/status/456"])
                throw CaptureError.message("offline")
            }
            do { try await resumed.preparePending(id); XCTFail("Expected offline") } catch { }
            XCTAssertEqual(reads, 1)
            XCTAssertEqual(try reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)?.stage, .reading)
        }
    }

    @MainActor
    func testCheapPreviewIsCommittedBeforeRenderingAndCancellationRestartsSamePlan() async throws {
        try await withDelivery { delivery, store, root in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            let composed = try self.composed(source, root: root)
            delivery.readSource = { _ in composed }
            var renderCalls = 0
            delivery.renderSource = { _, operationID in
                renderCalls += 1
                XCTAssertEqual(operationID, id)
                let retained = try XCTUnwrap(store.value(CaptureDraft.self, account: source.accountID, kind: "draft", id: id.uuidString))
                XCTAssertEqual(retained.deliveryState?.stage, .rendering)
                XCTAssertEqual(retained.previewSnapshot?.title, composed.preview.title)
                XCTAssertEqual(retained.previewSnapshot?.plan, composed.preview.plan)
                throw CancellationError()
            }
            do { try await delivery.preparePending(id); XCTFail("Expected cancellation") } catch is CancellationError { }
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            XCTAssertEqual(try reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)?.stage, .rendering)
            delivery.readSource = { _ in XCTFail("Must not re-read composed source after restart"); throw CancellationError() }
            do { try await delivery.preparePending(id); XCTFail("Expected cancellation") } catch is CancellationError { }
            XCTAssertEqual(renderCalls, 2)
            XCTAssertEqual(try store.recordIDs(account: 0, kind: "delivery"), [id.uuidString])
        }
    }

    @MainActor
    func testUnavailableSelectedReferenceFailsInsteadOfTextOnly() throws {
        let root = FileManager.default.temporaryDirectory
        let runtime = try CaptureRuntime()
        let preparation = CapturePreparation(runtime: runtime, container: root)
        var source = draft(); source.media = .selected; source.selectedMedia = ["missing.ref"]
        let snapshot = try CaptureSubmissionSnapshot(draft: source)
        XCTAssertThrowsError(try preparation.compose(snapshot, sources: posts)) { error in
            XCTAssertTrue(error.localizedDescription.contains("selected media"))
        }
    }

    @MainActor
    func testQueuedSaveRemapsExtraMediaAfterThreadExpansionAndKeepsWriting() throws {
        let old = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        [
          {"provider":"x","id":"123","canonicalUrl":"https://x.com/person/status/123","author":{"handle":"person"},"text":"Root","selection":{"role":"primary","origin":"explicit","declaredIndex":1},"media":[{"ref":"1.1","kind":"image","url":"https://example.test/root.jpg","alt":"","width":640,"height":480}]},
          {"provider":"x","id":"124","canonicalUrl":"https://x.com/other/status/124","author":{"handle":"other"},"text":"Extra","selection":{"role":"extra","origin":"explicit","declaredIndex":2},"media":[{"ref":"2.1","kind":"image","url":"https://example.test/extra.jpg","alt":"","width":640,"height":480}]}
        ]
        """#.utf8))
        let expanded = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        [
          {"provider":"x","id":"123","canonicalUrl":"https://x.com/person/status/123","author":{"handle":"person"},"text":"Root","selection":{"role":"primary","origin":"explicit","declaredIndex":1},"media":[{"ref":"1.1","kind":"image","url":"https://example.test/root.jpg","alt":"","width":640,"height":480}]},
          {"provider":"x","id":"125","canonicalUrl":"https://x.com/person/status/125","author":{"handle":"person"},"text":"Connected","selection":{"role":"primary","origin":"expanded","parentUri":"https://x.com/person/status/123"},"media":[{"ref":"2.1","kind":"image","url":"https://example.test/connected.jpg","alt":"","width":640,"height":480}]},
          {"provider":"x","id":"124","canonicalUrl":"https://x.com/other/status/124","author":{"handle":"other"},"text":"Extra","selection":{"role":"extra","origin":"explicit","declaredIndex":2},"media":[{"ref":"3.1","kind":"image","url":"https://example.test/extra.jpg","alt":"","width":640,"height":480}]}
        ]
        """#.utf8))
        let preview = CapturePreview(kind: "social", url: "https://x.com/person/status/123", plan: .object(["sources": old]))
        var source = draft()
        source.input = "https://x.com/person/status/123\nhttps://x.com/other/status/124"
        source.sourceRoles = [.primary, .extra]
        source.threadExpansion = .on
        source.media = .selected; source.selectedMedia = ["2.1"]
        source.pendingMediaChoices = try CaptureMediaChoiceAnchors.capture(preview: preview, selected: ["2.1"], frames: nil)
        source.titleOverride = "Retained title"; source.descriptionOverride = "Retained writing"
        let snapshot = try CaptureSubmissionSnapshot(draft: source)
        let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: .init(fileURLWithPath: "/tmp"))
        let prepared = try preparation.compose(snapshot, sources: expanded)
        XCTAssertEqual(prepared.preview.selectedMedia, ["3.1"])
        XCTAssertEqual(prepared.prepared.update["title"], .string("Retained title"))
        XCTAssertThrowsError(try preparation.compose(snapshot, sources: .array(Array(expanded.array.prefix(2)))))
    }

    @MainActor
    func testSelectedMediaAndWritingRemainExactAndNoImplicitTextDowngrade() throws {
        let runtime = try CaptureRuntime()
        let preparation = CapturePreparation(runtime: runtime, container: .init(fileURLWithPath: "/tmp"))
        var source = draft(); source.media = .selected; source.selectedMedia = ["1.1"]
        source.titleOverride = "My title"; source.descriptionOverride = "My description"
        let result = try preparation.compose(.init(draft: source), sources: posts)
        XCTAssertEqual(result.preview.selectedMedia, ["1.1"])
        XCTAssertEqual(result.prepared.update["title"], .string("My title"))
        XCTAssertEqual(result.prepared.update["description"], .string("My description"))
        XCTAssertEqual(result.prepared.payload["original_source_url"], .string(source.input))
        XCTAssertNil(result.reusableRenderPath)
    }

    @MainActor
    func testOrdinaryLinkNeedsNoMetadataDownloadAndPreservesURL() async throws {
        let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: .init(fileURLWithPath: "/tmp"))
        var source = draft(); source.input = "https://example.com/article?source=share#part"
        source.titleOverride = "Title"; source.descriptionOverride = "Writing"
        let result = try await preparation.read(.init(draft: source))
        XCTAssertEqual(result.prepared.payload["value"], .string(source.input))
        XCTAssertEqual(result.prepared.payload["original_source_url"], .string(source.input))
        XCTAssertEqual(result.prepared.update["description"], .string("Writing"))
        XCTAssertTrue(result.preview.selectedMedia.isEmpty)
    }

    @MainActor
    func testNoReusableEarlierRenderWhilePreviewIsPreparing() throws {
        var source = draft(); source.renderPath = "/tmp/earlier.mp4"
        source.previewSnapshot = .init(kind: "social", url: source.input)
        source.phase = .preparing
        XCTAssertNil(try CaptureSubmissionSnapshot(draft: source).reusableRenderPath)
        source.phase = .ready
        XCTAssertEqual(try CaptureSubmissionSnapshot(draft: source).reusableRenderPath, source.renderPath)
        source.input = "https://x.com/person/status/changed"
        XCTAssertNil(try CaptureSubmissionSnapshot(draft: source).reusableRenderPath)
    }

    @MainActor
    func testNewSubmissionCreatesFirstTargetOnlyAndAddsExtrasInOrder() async throws {
        try await withDelivery { delivery, store, _ in
            var source = self.draft()
            source.selection = DestinationSelection(defaultChannel: nil); source.selection.toggle(self.channel(101))
            for id in 102...106 { source.selection.toggle(self.channel(id)) }
            _ = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString))
            job.stage = .create; job.prepared = .init(payload: ["value": .string(source.input)], update: [:])
            let create = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(delivery.request(job, token: "fixture").body))
            XCTAssertEqual(create["channel_ids"], .array([.number(101)]))
            job.draft.blockID = 900; job.contentVerified = true; job.stage = .connections; job.attemptedChannelIDs = [101]
            for id in 102...106 {
                let confirmed = Array(101..<id)
                delivery.consume(try self.members(confirmed), job: &job)
                XCTAssertEqual(job.stage, .connect)
                let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(delivery.request(job, token: "fixture").body))
                XCTAssertEqual(body["channel_ids"], .array([.number(Double(id))]))
                job.attemptedChannelIDs?.append(id)
                delivery.consume(.init(status: 201, body: Data(), error: nil, retryAfter: nil), job: &job)
                XCTAssertEqual(job.stage, .connections)
            }
            delivery.consume(try self.members(Array(101...106)), job: &job)
            XCTAssertEqual(job.stage, .done)
        }
    }

    @MainActor
    func testAmbiguousPlacementStopsBeforeRepeatingOrSendingLater() async throws {
        try await withDelivery { delivery, store, _ in
            var source = self.draft(); source.selection = DestinationSelection(defaultChannel: nil)
            for id in 101...103 { source.selection.toggle(self.channel(id)) }
            _ = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString))
            job.draft.blockID = 900; job.stage = .connect; job.attemptedChannelIDs = [101, 102]
            delivery.consume(.init(status: nil, body: Data(), error: "timeout", retryAfter: nil), job: &job)
            XCTAssertEqual(job.stage, .connections)
            delivery.consume(try self.members([101]), job: &job)
            XCTAssertEqual(job.stage, .attention)
            job.resumeAfterAttention()
            XCTAssertEqual(job.stage, .connections)
            delivery.consume(try self.members([101]), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(job.attemptedChannelIDs, [101, 102])
        }
    }

    @MainActor
    func testDefaultFirstEvenWhenExplicitlySelectedLater() throws {
        var selection = DestinationSelection(defaultChannel: nil)
        selection.toggle(channel(102)); selection.toggle(channel(101)); selection.toggle(channel(103))
        XCTAssertEqual(try CaptureDefaultRoute.destinations(selection, defaultChannel: channel(101), mode: .fallback).map(\.id), [101, 102, 103])
        XCTAssertEqual(try CaptureDefaultRoute.destinations(selection, defaultChannel: channel(104), mode: .always).map(\.id), [104, 102, 101, 103])
        var submitted = draft()
        submitted.selection = DestinationSelection(defaultChannel: nil)
        for id in [101, 102, 103] { submitted.selection.toggle(channel(id)) }
        submitted.submittedDefaultChannelID = 101; submitted.provenanceChannelID = nil
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(submitted))
        XCTAssertEqual(restored.selection.channels.map(\.id), [101, 102, 103])
        XCTAssertEqual(restored.statusChannels.map(\.id), [102, 103, 101])
        XCTAssertEqual(restored.submittedDefaultChannelID, 101)
    }

    @MainActor
    func testOfflineAndRetryRetainSameUUIDAndFrozenInput() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            delivery.readSource = { snapshot in
                XCTAssertEqual(snapshot.url, source.input)
                throw CaptureError.message("The source request timed out.")
            }
            await delivery.check(id)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(job.stage, .attention); XCTAssertEqual(job.resumeStage, .reading)
            XCTAssertNil(job.transferID); XCTAssertNil(job.draft.blockID)
            XCTAssertTrue(job.permitsEditing)
            await delivery.retry(id)
            job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(job.id, id); XCTAssertEqual(job.stage, .attention)
            XCTAssertEqual(try store.recordIDs(account: 0, kind: "delivery"), [id.uuidString])
            XCTAssertEqual(try store.recordIDs(account: source.accountID, kind: "draft"), [id.uuidString])
        }
    }

    @MainActor
    func testRenderFailureRetainsComposedPreviewAndNeverCreatesTextOnlyTransfer() async throws {
        try await withDelivery { delivery, store, root in
            let source = self.draft(); let id = try delivery.persistQueuedSubmission(draft: source)
            let result = try self.composed(source, root: root)
            delivery.readSource = { _ in result }
            delivery.renderSource = { _, _ in throw CaptureError.message("Selected media download failed.") }
            await delivery.check(id)
            let job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(job.stage, .attention); XCTAssertEqual(job.resumeStage, .rendering)
            XCTAssertEqual(job.draft.previewSnapshot?.selectedMedia, ["1.1"])
            XCTAssertEqual(job.prepared.payload, result.prepared.payload)
            XCTAssertNil(job.transferID); XCTAssertNil(job.draft.blockID)
            XCTAssertNil(job.mediaPath)
        }
    }

    @MainActor
    func testTargetIsDurablyJournaledBeforeTransportCanStart() async throws {
        try await withDelivery { delivery, store, root in
            var source = self.draft(); source.input = "https://example.com/article"
            let id = try delivery.persistQueuedSubmission(draft: source)
            try await delivery.preparePending(id)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            delivery.consume(.init(status: 200, body: Data(#"{"can":{"add_to":true}}"#.utf8), error: nil, retryAfter: nil), job: &job)
            // Retain the preceding destination observation, before reserving the next request.
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            let reserved = try XCTUnwrap(delivery.reserveTransfer(job, transferID: "create-request"))
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            let retained = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(retained.attemptedChannelIDs, [101])
            XCTAssertEqual(retained.transferID, "create-request")
            XCTAssertEqual(retained.revision, reserved.revision)
        }
    }

    @MainActor
    func testFirstDefaultProvenanceReadbackGatesLaterPlacements() async throws {
        try await withDelivery { delivery, store, _ in
            var source = self.draft(); source.input = "https://example.com/article"
            source.selection = DestinationSelection(defaultChannel: nil)
            source.selection.toggle(self.channel(101)); source.selection.toggle(self.channel(102))
            source.provenanceChannelID = 101
            let id = try delivery.persistQueuedSubmission(draft: source)
            try await delivery.preparePending(id)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.stage = .connections; job.draft.blockID = 900; job.attemptedChannelIDs = [101]
            delivery.consume(try self.members([101]), job: &job)
            XCTAssertEqual(job.stage, .provenanceContents)
            delivery.consume(try self.provenanceContents(), job: &job)
            XCTAssertEqual(job.stage, .provenanceRead)
            let provenance = try XCTUnwrap(job.provenance)
            delivery.consume(try self.connection(metadata: provenance.metadata), job: &job)
            XCTAssertEqual(job.stage, .connections); XCTAssertEqual(job.firstProvenanceVerified, true)
            delivery.consume(try self.members([101]), job: &job)
            XCTAssertEqual(job.stage, .connect)
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(delivery.request(job, token: "fixture").body))["channel_ids"], .array([.number(102)]))

            job.stage = .provenanceRead; job.verifyingFirstProvenance = true
            delivery.consume(try self.connection(metadata: [:]), job: &job)
            XCTAssertEqual(job.stage, .attention)
            XCTAssertTrue(job.problem?.contains("Later placements were not sent") == true)
        }
    }

    @MainActor
    func testFoundDefaultPlacementInLargeInboxVerifiesDirectlyBeforeLaterPlacement() async throws {
        try await withDelivery { delivery, store, _ in
            var source = self.draft(); source.input = "https://example.com/large-inbox"
            source.selection = DestinationSelection(defaultChannel: nil)
            source.selection.toggle(self.channel(101)); source.selection.toggle(self.channel(102))
            source.provenanceChannelID = 101
            let id = try delivery.persistQueuedSubmission(draft: source)
            try await delivery.preparePending(id)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.draft.blockID = 900; job.stage = .connections; job.attemptedChannelIDs = [101]
            delivery.consume(try self.members([101]), job: &job)
            XCTAssertEqual(job.stage, .provenanceContents)
            // Reproduce a retained job stopped by the old three-page scan.
            job.stage = .attention; job.resumeStage = .provenanceContents
            job.provenanceConnectionID = 500; job.page = 3
            job.resumeAfterAttention()
            XCTAssertEqual(job.stage, .provenanceContents)
            XCTAssertEqual(job.page, 1)
            XCTAssertEqual(job.draft.blockID, 900)
            let firstPage = JSONValue.object([
                "data": .array([.object(["id": .number(900), "type": .string("Link"), "connection": .object(["id": .number(500)])])]),
                "meta": .object(["has_more_pages": .bool(true), "next_page": .number(2)])
            ])
            delivery.consume(.init(status: 200, body: try JSONEncoder().encode(firstPage), error: nil, retryAfter: nil), job: &job)
            XCTAssertEqual(job.stage, .provenanceRead)
            XCTAssertEqual(job.provenanceConnectionID, 500)
            XCTAssertEqual(job.page, 1)
            XCTAssertTrue(try delivery.request(job, token: "fixture").request.url!.absoluteString.hasSuffix("/connections/500"))
            delivery.consume(try self.connection(metadata: try XCTUnwrap(job.provenance).metadata), job: &job)
            XCTAssertEqual(job.stage, .connections)
            XCTAssertEqual(job.firstProvenanceVerified, true)
            delivery.consume(try self.members([101]), job: &job)
            XCTAssertEqual(job.stage, .connect)
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(delivery.request(job, token: "fixture").body))["channel_ids"], .array([.number(102)]))
        }
    }

    @MainActor
    func testExistingDefaultOriginalMetadataIsUntouchedUntilFinalLatestEventPatch() async throws {
        try await withDelivery { delivery, store, _ in
            var source = self.draft(); source.input = "https://example.com/article"
            source.selection = DestinationSelection(defaultChannel: nil)
            source.selection.toggle(self.channel(101)); source.selection.toggle(self.channel(102))
            source.provenanceChannelID = 101
            let id = try delivery.persistQueuedSubmission(draft: source)
            try await delivery.preparePending(id)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.draft.blockID = 900; job.stage = .connections
            let original: [String: JSONValue] = ["ac_capture_id": .string("earlier-capture"), "ac_origin": .string("cli"), "unrelated": .string("keep")]
            delivery.consume(try self.members([101]), job: &job)
            delivery.consume(try self.provenanceContents(), job: &job)
            delivery.consume(try self.connection(metadata: original), job: &job)
            XCTAssertEqual(job.stage, .connections); XCTAssertNil(job.provenancePatch)
            delivery.consume(try self.members([101, 102]), job: &job)
            delivery.consume(try self.provenanceContents(), job: &job)
            delivery.consume(try self.connection(metadata: original), job: &job)
            XCTAssertEqual(job.stage, .provenanceWrite)
            XCTAssertNil(job.provenancePatch?["ac_capture_id"])
            XCTAssertEqual(job.provenancePatch?["ac_latest_capture_id"], .string(id.uuidString))
        }
    }

    @MainActor
    func testDifferentSelectedMediaCannotReuseAnEarlierPublishedCover() async throws {
        try await withDelivery { delivery, store, root in
            var post = self.posts.array[0].object
            var second = post["media"]!.array[0].object
            second["ref"] = .string("1.2"); second["url"] = .string("https://example.test/two.jpg")
            post["media"] = .array(post["media"]!.array + [.object(second)])
            let sources = JSONValue.array([.object(post)])
            let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: root)
            delivery.readSource = { try preparation.compose($0, sources: sources) }
            delivery.renderSource = { _, _ in throw CancellationError() }
            var first = self.draft(); first.media = .selected; first.selectedMedia = ["1.1"]
            let firstID = try delivery.persistQueuedSubmission(draft: first)
            do { try await delivery.preparePending(firstID) } catch is CancellationError { }
            let firstJob = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: firstID.uuidString))
            let firstKey = try XCTUnwrap(firstJob.draft.publicationKey)
            try store.save(900, account: first.accountID, kind: "published", id: firstKey)
            var next = self.draft(); next.media = .selected; next.selectedMedia = ["1.2"]
            let nextID = try delivery.persistQueuedSubmission(draft: next)
            do { try await delivery.preparePending(nextID) } catch is CancellationError { }
            let nextJob = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: nextID.uuidString))
            XCTAssertNotEqual(nextJob.draft.publicationKey, firstKey)
            XCTAssertEqual(nextJob.stage, .rendering)
            XCTAssertNil(nextJob.draft.blockID)
            XCTAssertEqual(nextJob.draft.previewSnapshot?.selectedMedia, ["1.2"])
        }
    }

    @MainActor
    func testRetainedProvenanceCompletionCannotRetireMissingExplicitDestination() async throws {
        try await withDelivery { delivery, store, _ in
            for flag in [Bool?.none, Bool?.some(false)] {
                var source = self.draft(); source.input = "https://example.com/article"
                source.selection = DestinationSelection(defaultChannel: nil)
                source.selection.toggle(self.channel(101)); source.selection.toggle(self.channel(102))
                source.provenanceChannelID = 101; source.requestedChannelIDs = [102]
                let id = try delivery.persistQueuedSubmission(draft: source)
                try await delivery.preparePending(id)
                var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
                job.draft.blockID = 900; job.contentVerified = true; job.connected = [101]
                job.provenanceConnectionID = 500; job.verifyingFirstProvenance = flag
                job.stage = .provenanceRead; job.transferID = "retained-provenance"
                try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
                let accepted = try XCTUnwrap(delivery.accept(try self.connection(metadata: job.provenance!.metadata), id: id, transferID: "retained-provenance"))
                XCTAssertEqual(accepted.stage, .connections)
                XCTAssertEqual(accepted.draft.blockID, 900)
                XCTAssertNotEqual(accepted.draft.phase, .saved)
                XCTAssertEqual(try delivery.request(accepted, token: "fixture").request.httpMethod, "GET")
                XCTAssertEqual(try delivery.request(accepted, token: "fixture").request.url?.path, "/v3/blocks/900/connections")
                XCTAssertNotNil(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
                // The helper deliberately reuses a source, but the test operations are independent.
                if let key = job.draft.publicationKey { try store.remove(account: source.accountID, kind: "publicationLock", id: key) }
            }
        }
    }

    @MainActor
    func testProvenanceVerificationRequiresContentAndEveryFrozenTargetBeforeSaved() async throws {
        try await withDelivery { delivery, store, _ in
            for (verified, confirmed, expected) in [(false, Set([101, 102]), CaptureDeliveryStage.read), (true, Set([101]), .connections), (true, Set([101, 102]), .done)] {
                var source = self.draft(); source.input = "https://example.com/article"
                source.selection = DestinationSelection(defaultChannel: nil)
                source.selection.toggle(self.channel(101)); source.selection.toggle(self.channel(102))
                source.provenanceChannelID = 101
                let id = try delivery.persistQueuedSubmission(draft: source)
                try await delivery.preparePending(id)
                var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
                job.draft.blockID = 900; job.contentVerified = verified; job.connected = confirmed
                job.provenanceConnectionID = 500; job.provenancePatch = job.provenance!.metadata
                job.stage = .provenanceVerify; job.transferID = "verify-provenance"
                try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
                let result = try XCTUnwrap(delivery.accept(try self.connection(metadata: job.provenancePatch!), id: id, transferID: "verify-provenance"))
                XCTAssertEqual(result.stage, expected)
                let retained = try XCTUnwrap(store.value(CaptureDraft.self, account: source.accountID, kind: "draft", id: id.uuidString))
                XCTAssertEqual(retained.phase == .saved, expected == .done)
                XCTAssertEqual(try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) == nil, expected == .done)
                if let key = job.draft.publicationKey { try store.remove(account: source.accountID, kind: "publicationLock", id: key) }
                if let key = job.draft.publicationKey { try store.remove(account: source.accountID, kind: "published", id: key) }
            }
        }
    }

    @MainActor
    func testDeniedRedditReadKeepsFrozenIntentAndNeverChecksOrRetriesSave() async throws {
        try await withDelivery { delivery, store, root in
            var source = self.draft()
            source.input = "https://www.reddit.com/r/slatestarcodex/s/7iPiVUIyix"
            source.selection.toggle(self.channel(102))
            source.titleOverride = "My title"; source.descriptionOverride = "My writing"
            let id = try delivery.persistQueuedSubmission(draft: source)
            var reads = 0
            delivery.readSource = { snapshot in
                reads += 1
                XCTAssertEqual(snapshot.url, source.input)
                throw CaptureError.message("Reddit's live metadata read returned HTTP 403; current content cannot be verified. No archive or block creation was attempted")
            }
            await delivery.check(id)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(job.preparationFailureStage, .reading)
            XCTAssertEqual(job.state.title, "Couldn’t read source")
            XCTAssertEqual(CaptureSourceAccess.message(job.problem ?? ""), "Couldn’t load this Reddit content.")
            XCTAssertTrue(job.problem?.contains("HTTP 403") == true)
            XCTAssertTrue(job.permitsEditing)
            XCTAssertNil(job.draft.blockID); XCTAssertNil(job.transferID)
            XCTAssertNil(job.draft.publicationKey)
            XCTAssertEqual(job.attemptedChannelIDs, [])
            await delivery.check(id); await delivery.retry(id); await delivery.resume()
            XCTAssertEqual(reads, 1)
            let reopened = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
            job = try XCTUnwrap(reopened.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(job.draft.input, source.input)
            XCTAssertEqual(job.draft.titleOverride, "My title")
            XCTAssertEqual(job.draft.descriptionOverride, "My writing")
            XCTAssertEqual(job.draft.selection.channels.map(\.id), [101, 102])
            XCTAssertEqual(job.draft.deliveryState?.preparationFailureStage, .reading)
            XCTAssertEqual(try reopened.recordIDs(account: 0, kind: "delivery"), [id.uuidString])
        }
    }

    @MainActor
    func testPreparationFailureProjectionBackfillsOldJobWithoutRequestsAndFailsClosed() async throws {
        try await withDelivery { delivery, store, _ in
            let source = self.draft()
            let id = try delivery.persistQueuedSubmission(draft: source)
            var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            job.stage = .attention; job.resumeStage = .reading; job.problem = "Source unavailable"
            job.draft.problem = job.problem
            job.draft.deliveryState = .init(operationID: id, stage: .attention)
            try store.save(job, account: 0, kind: "delivery", id: id.uuidString)
            delivery.readSource = { _ in XCTFail("Migration must not acquire source"); throw CancellationError() }
            try delivery.refreshPreparationFailures()
            let migrated = try XCTUnwrap(store.value(CaptureDraft.self, account: source.accountID, kind: "draft", id: id.uuidString))
            XCTAssertEqual(migrated.id, id); XCTAssertEqual(migrated.deliveryState?.preparationFailureStage, .reading)
            for stage in [CaptureDeliveryStage.create, .read, .connections, .reconcile] {
                var external = job; external.resumeStage = stage
                XCTAssertNil(external.preparationFailureStage)
                XCTAssertFalse(external.permitsEditing)
            }
            var uncertain = job; uncertain.draft.phase = .uncertain
            XCTAssertNil(uncertain.preparationFailureStage)
            var attempted = job; attempted.attemptedChannelIDs = [101]
            XCTAssertNil(attempted.preparationFailureStage)
            var active = job; active.transferID = "request"
            XCTAssertNil(active.preparationFailureStage)
            var identified = job; identified.draft.blockID = 900
            XCTAssertNil(identified.preparationFailureStage)
            let oldState = CaptureDeliveryState(operationID: id, stage: .attention)
            let roundtrip = try JSONDecoder().decode(CaptureDeliveryState.self, from: JSONEncoder().encode(oldState))
            XCTAssertNil(roundtrip.preparationFailureStage)
            XCTAssertEqual(roundtrip.title, "Save interrupted")
            XCTAssertFalse(CaptureSourceAccess.redditDenied("Are.na returned HTTP 403"))
            XCTAssertFalse(CaptureSourceAccess.redditDenied("Reddit's live metadata read returned HTTP 429; try later"))
        }
    }

    @MainActor
    func testExplicitOriginalLinkFreezesURLAndWritingAndPreparesOnlyLinkPayload() async throws {
        try await withDelivery { delivery, store, root in
            var source = self.draft()
            source.input = "https://www.reddit.com/r/slatestarcodex/s/7iPiVUIyix"
            source.originalLinkOnly = true
            source.titleOverride = "My link title"; source.descriptionOverride = "My own writing"
            source.selection.toggle(self.channel(102))
            let snapshot = try CaptureSubmissionSnapshot(draft: source)
            let runtime = try CaptureRuntime()
            let preparation = CapturePreparation(runtime: runtime, container: root)
            let result = try await preparation.read(snapshot)
            XCTAssertEqual(result.preview.kind, "url")
            XCTAssertNil(result.preview.plan); XCTAssertTrue(result.preview.selectedMedia.isEmpty)
            XCTAssertEqual(result.prepared.payload, ["value": .string(source.input), "original_source_url": .string(source.input), "title": .string("My link title"), "description": .string("My own writing")])
            let id = try delivery.persistQueuedSubmission(draft: source)
            try await delivery.preparePending(id) // Stops before any Are.na request.
            let job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))
            XCTAssertEqual(job.stage, .destinations)
            XCTAssertEqual(job.submission?.originalLinkOnly, true)
            XCTAssertEqual(job.submission?.url, source.input)
            XCTAssertEqual(job.prepared.payload, result.prepared.payload)
            XCTAssertNil(job.mediaPath); XCTAssertNil(job.transferID); XCTAssertNil(job.draft.blockID)
            XCTAssertEqual(job.attemptedChannelIDs, [])
            XCTAssertEqual(job.draft.selection.channels.map(\.id), [101, 102])
            let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(source))
            XCTAssertEqual(restored.originalLinkOnly, true)
            source.input += "\nhttps://x.com/person/status/124"
            XCTAssertThrowsError(try CaptureSubmissionSnapshot(draft: source))
            source.input = "arbitrary text"
            XCTAssertThrowsError(try CaptureSubmissionSnapshot(draft: source))
            source.input = "javascript:alert(1)"
            XCTAssertThrowsError(try CaptureSubmissionSnapshot(draft: source))
        }
    }

    @MainActor
    private func withDelivery(_ action: (CaptureDelivery, CaptureStore, URL) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: "https://ingest.example.test")
        try await action(delivery, store, root)
    }

    private func channel(_ id: Int) -> Channel {
        .init(id: id, title: "Channel", slug: "channel-\(id)", visibility: "private", owner: .init(id: 123456789, name: "Fixture", slug: "fixture", type: "User"))
    }
    private func draft() -> CaptureDraft {
        .init(accountID: 123456789, defaultChannel: channel(101), input: "https://x.com/person/status/123")
    }
    private var posts: JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(#"[{"provider":"x","id":"123","canonicalUrl":"https://x.com/person/status/123","author":{"handle":"person"},"text":"Source words","media":[{"ref":"1.1","kind":"image","url":"https://example.test/one.jpg","alt":"","width":640,"height":480}]}]"#.utf8))
    }
    @MainActor private func composed(_ source: CaptureDraft, root: URL) throws -> CapturePreparedSource {
        try CapturePreparation(runtime: CaptureRuntime(), container: root).compose(.init(draft: source), sources: posts)
    }
    private func members(_ ids: [Int]) throws -> BackgroundHTTPResult {
        .init(status: 200, body: try JSONEncoder().encode(JSONValue.object(["data": .array(ids.map { .object(["id": .number(Double($0))]) }), "meta": .object(["has_more_pages": .bool(false)])])), error: nil, retryAfter: nil)
    }
    private func provenanceContents() throws -> BackgroundHTTPResult {
        .init(status: 200, body: try JSONEncoder().encode(JSONValue.object(["data": .array([.object(["id": .number(900), "type": .string("Link"), "connection": .object(["id": .number(500)])])]), "meta": .object(["has_more_pages": .bool(false)])])), error: nil, retryAfter: nil)
    }
    private func connection(metadata: [String: JSONValue]) throws -> BackgroundHTTPResult {
        .init(status: 200, body: try JSONEncoder().encode(JSONValue.object(["id": .number(500), "connected_by": .object(["id": .number(123456789)]), "metadata": .object(metadata)])), error: nil, retryAfter: nil)
    }
}
