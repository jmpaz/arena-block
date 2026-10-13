import CaptureCore
import CaptureRuntime
import Foundation
import CryptoKit
import Darwin

struct DeliveryJob: Codable, Identifiable {
    typealias Stage = CaptureDeliveryStage
    var id: UUID
    var revision: Int?
    var draft: CaptureDraft
    var prepared: PreparedCapture
    var submission: CaptureSubmissionSnapshot?
    // nil decodes legacy batched deliveries; new commands track every attempted target.
    var attemptedChannelIDs: [Int]?
    var firstProvenanceVerified: Bool?
    var verifyingFirstProvenance: Bool?
    var mediaPath: String?
    var mediaType: String?
    var ingestBase: String?
    var destinationIndex: Int?
    var resumeStage: Stage?
    var reuseExisting: Bool?
    var connectionAttempts: Int?
    var contentVerified: Bool?
    var stage: Stage
    var uploadedSource: String?
    var uploadURL: String?
    var uploadExpiry: Date?
    var transferID: String?
    var transferSession: String?
    var transferStarted: Date?
    var stopRequestedAt: Date?
    // Persisted before submitting a user-initiated continued-processing task.
    // An unclaimed marker fences automatic writes after an unclean process exit.
    var continuedRequestedAt: Date?
    var createdAt = Date()
    var notBefore: Date?
    var attempts = 0
    var page = 1
    var connected: Set<Int> = []
    // A paginated verification is provisional until its final page arrives.
    // Keep the last complete observation visible while checking again.
    var scanningConnected: Set<Int>?
    // A create readback is only decisive after the bounded scan finishes.
    var reconcileCandidateID: Int?
    var block: JSONValue?
    var problem: String?
    var provenance: CaptureConnectionProvenance?
    var provenanceConnectionID: Int?
    var provenancePatch: [String: JSONValue]?
    var state: CaptureDeliveryState {
        CaptureDeliveryState(operationID: id, stage: stage,
            confirmedChannelIDs: connected.intersection(Set(draft.selection.channels.map(\.id))),
            contentVerified: contentVerified == true || stage == .done, notBefore: notBefore,
            stopRequested: stopRequestedAt != nil, preparationFailureStage: preparationFailureStage)
    }
    var preparationFailureStage: Stage? {
        guard stage == .attention, stopRequestedAt == nil, problem != nil,
              transferID == nil, draft.blockID == nil, draft.phase != .uncertain,
              contentVerified != true, connected.isEmpty, (attemptedChannelIDs ?? []).isEmpty,
              let resumeStage, [.queued, .reading, .rendering].contains(resumeStage) else { return nil }
        return resumeStage
    }
    var permitsEditing: Bool {
        if preparationFailureStage != nil { return true }
        guard stopRequestedAt == nil, attemptedChannelIDs == nil, submission == nil, stage == .attention,
              transferID == nil, draft.blockID == nil, draft.phase != .uncertain, let resumeStage else { return false }
        return [Stage.destinations, .presign, .upload, .create].contains(resumeStage)
    }
    mutating func resumeAfterAttention() {
        stage = draft.phase == .uncertain ? .reconcile : (resumeStage == .connect ? .connections : (resumeStage ?? .destinations))
        if stage == .provenanceVerify { stage = .provenanceRead }
        if stage == .connections {
            if draft.blockID != nil, contentVerified == true { reuseExisting = true }
            scanningConnected = nil; connectionAttempts = 0
        }
        problem = nil; attempts = 0; page = 1; transferID = nil
    }
}

@MainActor
final class CaptureDelivery {
    let store: CaptureStore
    private let credentials: CredentialStore
    private let directory: URL
    private let group: String
    private let ownIdentifier: String
    private let ingestBase: String?
    private var transports: [String: BackgroundHTTP] = [:]
    private var running: Set<UUID> = []
    private var sessionLocks: [String: Int32] = [:]
    private var recoveryTasks: [UUID: Task<Void, Never>] = [:]
    private var preparationTasks: [UUID: Task<Void, Error>] = [:]
    private var activeContinued: Set<UUID> = []
    private var retiring = false
    var changed: (() -> Void)?
    var readSource: ((CaptureSubmissionSnapshot) async throws -> CapturePreparedSource)?
    var renderSource: ((JSONValue, UUID) async throws -> NativeRenderedMedia?)?
    private var sourcePreparation: CapturePreparation?

    init(store: CaptureStore, credentials: CredentialStore, directory: URL, group: String, identifier: String, ingestBase: String?) throws {
        self.store = store; self.credentials = credentials; self.directory = directory
        self.group = group; ownIdentifier = identifier + "." + UUID().uuidString + ".delivery"; self.ingestBase = ingestBase
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    deinit { for descriptor in sessionLocks.values { close(descriptor) } }

    func finishSharing() {
        retiring = true
        retireIfIdle()
    }

    private func retireIfIdle() {
        guard retiring,
              (try? store.containsValue(DeliveryJob.self, account: 0, kind: "delivery", matching: { ![.done, .attention].contains($0.stage) })) == false else { return }
        for transport in transports.values { transport.finish() }
    }

    func attach(_ identifier: String, completion: (@Sendable () -> Void)? = nil) throws {
        let transport = try transport(identifier)
        transport.onFinishedEvents = { [weak self] in
            await self?.finishAdoptedSession(identifier)
            completion?()
        }
        transport.connect()
    }

    func enqueue(draft: CaptureDraft, prepared: PreparedCapture, media: URL?, contentType: String?) async throws {
        let id = try persistSubmission(draft: draft, prepared: prepared, media: media, contentType: contentType)
        await advance(id)
    }

    func persistSubmission(draft: CaptureDraft, prepared: PreparedCapture, media: URL?, contentType: String?) throws -> UUID {
        var snapshot = draft
        snapshot.phase = .queued; snapshot.updatedAt = Date(); snapshot.problem = nil
        guard !snapshot.selection.channels.isEmpty, snapshot.selection.channels.count <= 20 else { throw CaptureError.message("Choose between one and twenty destinations before submitting.") }
        let provenance = snapshot.provenanceChannelID == nil ? nil : try CaptureConnectionProvenance(draft: snapshot, prepared: prepared)
        snapshot.provenanceSnapshotJSON = provenance?.snapshotJSON
        try store.transaction {
            guard try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: snapshot.id.uuidString) == nil else { return }
            if try store.value(CaptureDraft.self, account: snapshot.accountID, kind: "draft", id: snapshot.id.uuidString)?.phase == .saved { return }
            if let key = snapshot.publicationKey {
                guard try store.reservePublication(account: snapshot.accountID, key: key, draftID: snapshot.id) else {
                    throw CaptureError.message("This source already has a pending capture. Check its progress in History.")
                }
                snapshot.blockID = try store.value(Int.self, account: snapshot.accountID, kind: "published", id: key)
            }
            if snapshot.isPlacementOnly {
                guard snapshot.blockID != nil, media == nil, prepared.update.isEmpty else {
                    throw CaptureError.message("Choose placements for the existing block without changing its content.")
                }
            }
            var job = DeliveryJob(id: snapshot.id, draft: snapshot, prepared: prepared, mediaPath: media?.path, mediaType: contentType, ingestBase: ingestBase, reuseExisting: snapshot.blockID != nil, stage: .destinations)
            job.provenance = provenance
            snapshot.deliveryState = job.state; job.draft = snapshot
            try store.save(snapshot, account: snapshot.accountID, kind: "draft", id: snapshot.id.uuidString)
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            try rememberSubmittedChannels(snapshot)
        }
        return snapshot.id
    }

    /// Synchronous transaction: no provider, media, credential or Are.na read before acceptance.
    func persistQueuedSubmission(draft: CaptureDraft) throws -> UUID {
        if let existing = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: draft.id.uuidString) {
            guard existing.draft.accountID == draft.accountID else { throw CaptureError.message("This submission belongs to a different account.") }
            return draft.id
        }
        if try store.value(CaptureDraft.self, account: draft.accountID, kind: "draft", id: draft.id.uuidString)?.phase == .saved { return draft.id }
        var snapshot = draft
        guard !snapshot.selection.channels.isEmpty, snapshot.selection.channels.count <= 20 else { throw CaptureError.message("Choose between one and twenty destinations before submitting.") }
        let submission = snapshot.isPlacementOnly ? nil : try CaptureSubmissionSnapshot(draft: snapshot)
        if snapshot.isPlacementOnly, snapshot.blockID == nil { throw CaptureError.message("The existing block is unavailable.") }
        snapshot.phase = .queued; snapshot.problem = nil; snapshot.updatedAt = Date()
        snapshot.renderPath = nil; snapshot.publicationKey = nil
        try store.transaction {
            guard try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: snapshot.id.uuidString) == nil else { return }
            if try store.value(CaptureDraft.self, account: snapshot.accountID, kind: "draft", id: snapshot.id.uuidString)?.phase == .saved { return }
            var job = DeliveryJob(id: snapshot.id, draft: snapshot, prepared: .init(payload: [:], update: [:]), submission: submission,
                attemptedChannelIDs: [], firstProvenanceVerified: false, ingestBase: ingestBase,
                reuseExisting: snapshot.blockID != nil, stage: submission == nil ? .destinations : .queued)
            if snapshot.isPlacementOnly, snapshot.provenanceChannelID != nil {
                job.provenance = try CaptureConnectionProvenance(draft: snapshot, prepared: job.prepared)
                snapshot.provenanceSnapshotJSON = job.provenance?.snapshotJSON
            }
            snapshot.deliveryState = job.state; job.draft = snapshot
            try store.save(snapshot, account: snapshot.accountID, kind: "draft", id: snapshot.id.uuidString)
            try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
            try rememberSubmittedChannels(snapshot)
        }
        return snapshot.id
    }

    /// Recents describe a durable local choice, so remote completion must not
    /// reorder them later. Reverse the writes to keep the first choice on top.
    private func rememberSubmittedChannels(_ draft: CaptureDraft) throws {
        for channel in draft.selection.channels.reversed() {
            try store.save(channel, account: draft.accountID, kind: "recent", id: String(channel.id))
        }
        try store.prune(account: draft.accountID, kind: "recent", keeping: 100)
    }

    private func preparation() throws -> CapturePreparation {
        if let sourcePreparation { return sourcePreparation }
        let created = CapturePreparation(runtime: try CaptureRuntime(), container: directory.deletingLastPathComponent())
        sourcePreparation = created; return created
    }

    /// Restartable local stages; the cheap source preview is committed before rendering starts.
    func preparePending(_ id: UUID) async throws {
        guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) else { return }
        if job.stage == .queued { job.stage = .reading; job = try save(job); changed?() }
        if job.stage == .reading {
            guard let submission = job.submission else { throw CaptureError.message("The submitted source snapshot is unavailable.") }
            try Task.checkCancellation()
            let result: CapturePreparedSource
            if let readSource { result = try await readSource(submission) }
            else { result = try await preparation().read(submission) }
            try Task.checkCancellation()
            job.prepared = result.prepared; job.draft.previewSnapshot = result.preview
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            // Include the exact composed source/media plan: equal text payloads can have different covers.
            struct Material: Encodable { let prepared: PreparedCapture; let plan: JSONValue?; let policy: JSONValue }
            let material = try encoder.encode(Material(prepared: result.prepared, plan: result.preview.plan, policy: submission.policy))
            let key = "capture-v2:" + SHA256.hash(data: material).map { String(format: "%02x", $0) }.joined()
            job.draft.publicationKey = key
            let hasMedia = !result.preview.selectedMedia.isEmpty
            job.mediaPath = hasMedia ? result.reusableRenderPath : nil
            job.stage = hasMedia ? .rendering : .destinations
            if job.draft.provenanceChannelID != nil {
                job.provenance = try CaptureConnectionProvenance(draft: job.draft, prepared: job.prepared)
                job.draft.provenanceSnapshotJSON = job.provenance?.snapshotJSON
            }
            try store.transaction {
                guard try store.reservePublication(account: job.draft.accountID, key: key, draftID: job.id) else { throw CaptureError.message("This source already has a pending capture. Check its progress in History.") }
                job.draft.blockID = try store.value(Int.self, account: job.draft.accountID, kind: "published", id: key)
                job.reuseExisting = job.draft.blockID != nil
                if job.reuseExisting == true { job.stage = .destinations; job.mediaPath = nil }
                job = try save(job)
            }
            changed?()
        }
        if job.stage == .rendering {
            guard let plan = job.draft.previewSnapshot?.plan, !job.draft.previewSnapshot!.selectedMedia.isEmpty else { throw CaptureError.message("The queued media plan is unavailable. No block was created.") }
            if let path = job.mediaPath, FileManager.default.fileExists(atPath: path) {
                job.mediaType = URL(fileURLWithPath: path).pathExtension.lowercased() == "mp4" ? "video/mp4" : "image/jpeg"
            } else {
                let media: NativeRenderedMedia?
                if let renderSource { media = try await renderSource(plan, id) }
                else { media = try await preparation().render(plan: plan, draftID: id) }
                guard let media else { throw CaptureError.message("The selected media could not be prepared. No block was created.") }
                do {
                    try Task.checkCancellation()
                    job.mediaPath = media.fileURL.path; job.mediaType = media.contentType
                    job.draft.renderPath = media.fileURL.path; job.stage = .destinations
                    job = try save(job)
                } catch { try? FileManager.default.removeItem(at: media.fileURL); throw error }
                changed?(); return
            }
            try Task.checkCancellation()
            job.draft.renderPath = job.mediaPath; job.stage = .destinations; _ = try save(job); changed?()
        }
    }

    func resume() async {
        do {
            try refreshPreparationFailures()
            try attach(ownIdentifier)
            for id in try store.recordIDs(account: 0, kind: "delivery") {
                guard !Task.isCancelled else { return }
                guard let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id), ![.done, .attention].contains(job.stage),
                      job.continuedRequestedAt == nil || activeContinued.contains(job.id) || job.stopRequestedAt != nil else { continue }
                if let identifier = job.transferSession, transports[identifier] == nil { try? attach(identifier) }
                await advance(job.id)
            }
            changed?()
        } catch { changed?() }
    }

    func continuedOperationIDs() throws -> [UUID] {
        try store.recordIDs(account: 0, kind: "delivery").compactMap { raw in
            guard let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: raw),
                  job.continuedRequestedAt != nil else { return nil }
            return job.id
        }
    }

    /// Reserve the process-owned runtime claim before scheduling the system task.
    func beginContinued(_ id: UUID) throws -> Bool {
        var claimed = false
        try store.transaction {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  ![.done, .attention].contains(job.stage), job.stopRequestedAt == nil else { return }
            job.continuedRequestedAt = Date()
            _ = try save(job)
            claimed = true
        }
        if claimed { activeContinued.insert(id) }
        return claimed
    }

    func activateContinued(_ id: UUID) {
        guard (try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString))?.continuedRequestedAt != nil else { return }
        activeContinued.insert(id)
    }

    func deactivateContinued(_ id: UUID) { activeContinued.remove(id) }

    func endContinued(_ id: UUID) throws {
        activeContinued.remove(id)
        try store.transaction {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  job.continuedRequestedAt != nil else { return }
            job.continuedRequestedAt = nil
            _ = try save(job)
        }
        changed?()
    }

    /// Force-quit gives no expiration callback. A foreground relaunch treats any
    /// unclaimed task as stopped before ordinary recovery can write again.
    func pauseUnclaimedContinued() throws -> [UUID] {
        let unclaimed = try continuedOperationIDs().filter { !activeContinued.contains($0) }
        for id in unclaimed { try requestStop(id) }
        return unclaimed
    }

    func retry(_ id: UUID) async {
        do {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString), job.stage == .attention,
                  job.stopRequestedAt == nil else { return }
            // Reopening or checking a retained failure cannot retry denied provider access.
            if job.preparationFailureStage == .reading, CaptureSourceAccess.redditDenied(job.problem) { return }
            try store.transaction {
                guard let current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString), current.stage == .attention else { return }
                job = current
                job.resumeAfterAttention()
                job = try save(job)
            }
            await advance(id)
        } catch { changed?() }
    }

    func check(_ id: UUID) async {
        guard let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) else { return }
        if job.stopRequestedAt != nil { await inspectStopped(id) }
        else if job.stage == .attention { await retry(id) }
        else { await advance(id) }
    }

    /// Project older failures without reopening source or save requests.
    func refreshPreparationFailures() throws {
        for id in try store.recordIDs(account: 0, kind: "delivery") {
            guard let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id),
                  let failedStage = job.preparationFailureStage,
                  job.draft.deliveryState?.preparationFailureStage != failedStage else { continue }
            _ = try save(job)
        }
        changed?()
    }

    /// Persist the request before any in-flight URLSession result is interpreted.
    /// The result can still have created a block or connection; neither is cancelled here.
    func requestStop(_ id: UUID) throws {
        try store.transaction {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  job.stage != .done, job.stopRequestedAt == nil else { return }
            job.stopRequestedAt = Date()
            job.continuedRequestedAt = nil
            if job.stage != .attention { job.resumeStage = job.stage }
            if job.transferID == nil {
                if job.draft.blockID != nil { job.stage = .connections; job.page = 1; job.scanningConnected = nil }
                settleStop(&job)
            }
            _ = try save(job)
        }
        preparationTasks[id]?.cancel()
        activeContinued.remove(id)
        changed?()
        Task {
            await cancelStoppedTransfer(id)
            await advance(id)
        }
    }

    private func cancelStoppedTransfer(_ id: UUID) async {
        guard let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
              shouldCancelTransferOnStop(job), let transferID = job.transferID,
              let owner = try? transport(job.transferSession ?? ownIdentifier) else { return }
        for task in await owner.tasks() where task.taskDescription == transferID { task.cancel() }
    }

    func shouldCancelTransferOnStop(_ job: DeliveryJob) -> Bool {
        job.stopRequestedAt != nil && ![.reconcile, .connections].contains(job.stage)
    }

    /// An explicit continuation reuses the frozen command and its original UUID.
    func continueStopped(_ id: UUID) async {
        do {
            try store.transaction {
                guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                      job.stopRequestedAt != nil, job.stage == .attention, job.transferID == nil else { return }
                job.stopRequestedAt = nil; job.problem = nil; job.notBefore = nil; job.attempts = 0; job.page = 1
                if job.draft.phase == .uncertain || (job.draft.blockID == nil && job.attemptedChannelIDs?.isEmpty == false) {
                    job.stage = .reconcile
                } else if job.draft.blockID != nil {
                    job.stage = job.contentVerified == true ? .connections : .read
                    job.scanningConnected = nil
                } else {
                    job.stage = job.resumeStage ?? .queued
                }
                _ = try save(job)
            }
            await advance(id)
        } catch { changed?() }
    }

    private func inspectStopped(_ id: UUID) async {
        do {
            try store.transaction {
                guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                      job.stopRequestedAt != nil, job.stage == .attention else { return }
                guard job.draft.phase == .uncertain || job.draft.blockID != nil else { return }
                job.stage = job.draft.blockID == nil ? .reconcile : .connections
                job.page = 1; job.scanningConnected = nil; job.problem = nil; job.notBefore = nil
                _ = try save(job)
            }
            await advance(id)
        } catch { changed?() }
    }

    /// Read-only reconciliation is the only work permitted after Stop.
    private func settleStop(_ job: inout DeliveryJob) {
        guard job.stopRequestedAt != nil, job.transferID == nil, job.stage != .done else { return }
        if job.stage == .reconcile { return }
        if job.draft.blockID != nil {
            if job.stage != .connections { job.stage = .connections; job.page = 1; job.scanningConnected = nil }
            job.problem = "Stopping: checking the block's actual placements before pausing."
            return
        }
        if job.draft.phase == .uncertain {
            job.stage = .reconcile; job.page = 1
            job.problem = "Stopping: checking whether Are.na created the block."
            return
        }
        if job.stage == .create, job.attemptedChannelIDs?.isEmpty == false {
            job.stage = .reconcile; job.page = 1; job.draft.phase = .uncertain
            job.problem = "Stopping: checking whether Are.na created the block."
            return
        }
        if job.stage != .attention { job.resumeStage = job.stage }
        job.stage = .attention
        job.problem = job.draft.phase == .uncertain
            ? "Stopped with an unconfirmed earlier create. Check status before continuing."
            : "Stopped before a block was created. Continue Save resumes this same submission."
    }

    private func finishAdoptedSession(_ identifier: String) {
        guard identifier != ownIdentifier else { return }
        transports[identifier]?.finish()
    }

    private func releaseSession(_ identifier: String) {
        transports.removeValue(forKey: identifier)
        if let descriptor = sessionLocks.removeValue(forKey: identifier) { close(descriptor) }
    }

    private func transport(_ identifier: String) throws -> BackgroundHTTP {
        if let transport = transports[identifier] { return transport }
        guard identifier.hasSuffix(".delivery"), !identifier.contains("/"), !identifier.contains("..") else { throw CaptureError.message("The background session identifier is invalid.") }
        let lock = directory.appendingPathComponent(identifier + ".lock")
        let descriptor = open(lock.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw CaptureError.message("Could not open the background delivery lock.") }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            throw CaptureError.message("Another Capture process is handling this background session.")
        }
        sessionLocks[identifier] = descriptor
        let transport: BackgroundHTTP
        do { transport = try BackgroundHTTP(identifier: identifier, group: group, directory: directory) }
        catch { sessionLocks.removeValue(forKey: identifier); close(descriptor); throw error }
        transport.onResult = { _ in await self.resumeCompleted() }
        transport.onInvalidated = { [weak self] in await self?.releaseSession(identifier) }
        transports[identifier] = transport
        return transport
    }

    private func resumeCompleted() async {
        do {
            for id in try store.recordIDs(account: 0, kind: "delivery") {
                guard let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id), job.transferID != nil else { continue }
                await advance(job.id)
            }
        } catch { }
        changed?()
    }

    func accept(_ result: BackgroundHTTPResult, id: UUID, transferID: String) throws -> DeliveryJob? {
        var accepted: DeliveryJob?
        try store.transaction {
            guard var current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString), current.transferID == transferID else { return }
            consume(result, job: &current)
            current.transferID = nil; current.transferSession = nil; current.transferStarted = nil
            if current.stopRequestedAt != nil, current.stage != .attention { settleStop(&current) }
            accepted = try save(current)
        }
        return accepted
    }

    private func advance(_ id: UUID) async {
        // A continued task with no live owner may have been cancelled by the
        // system without a callback. Keep its journal until a handler claims it
        // or a foreground launch durably pauses it.
        if let held = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
           held.continuedRequestedAt != nil, held.stopRequestedAt == nil, !activeContinued.contains(id) { return }
        guard running.insert(id).inserted else { return }
        defer { running.remove(id); changed?(); retireIfIdle() }
        do {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString), ![.done, .attention].contains(job.stage) else { return }
            if let transferID = job.transferID {
                let reader = try transport(ownIdentifier)
                if let result = try reader.result(transferID) {
                    guard let accepted = try accept(result, id: id, transferID: transferID) else { return }
                    job = accepted
                    reader.removeResult(transferID)
                    if job.stage == .done { cleanupCompleted(job) }
                } else {
                    guard job.transferSession == ownIdentifier || transports[job.transferSession ?? ""] != nil else { return }
                    let owner = try transport(job.transferSession ?? ownIdentifier)
                    let tasks = await owner.tasks()
                    if let task = tasks.first(where: { $0.taskDescription == transferID }) {
                        let stopping = (try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)).map(shouldCancelTransferOnStop) == true
                        if stopping { task.cancel() }
                        else if task.state == .suspended { task.resume() }
                        return
                    }
                    let remaining = 30 - Date().timeIntervalSince(job.transferStarted ?? .distantPast)
                    if remaining > 0 {
                        recoveryTasks[id]?.cancel()
                        recoveryTasks[id] = Task { [weak self] in
                            try? await Task.sleep(for: .seconds(remaining + 1))
                            guard !Task.isCancelled else { return }
                            await self?.advance(id)
                        }
                        return
                    }
                    var recovered = false
                    try store.transaction {
                        guard var current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString), current.transferID == transferID else { return }
                        if current.stage == .create { current.stage = .reconcile; current.draft.phase = .uncertain }
                        else if current.stage == .connect {
                            current.stage = .connections; current.page = 1; current.scanningConnected = nil
                            current.connectionAttempts = (current.connectionAttempts ?? 0) + 1
                        } else if current.stage == .provenanceWrite { current.stage = .provenanceRead }
                        current.transferID = nil; current.transferSession = nil; current.transferStarted = nil
                        if current.stopRequestedAt != nil { settleStop(&current) }
                        current = try save(current); job = current; recovered = true
                    }
                    guard recovered else { return }
                }
            }
            guard ![.done, .attention].contains(job.stage) else { return }
            if job.stopRequestedAt != nil && ![.reconcile, .connections].contains(job.stage) {
                settleStop(&job); job = try save(job)
                guard ![.done, .attention].contains(job.stage) else { return }
            }
            if [.queued, .reading, .rendering].contains(job.stage) {
                let preparation = Task { try await self.preparePending(id) }
                preparationTasks[id] = preparation
                do { try await preparation.value }
                catch { preparationTasks.removeValue(forKey: id); throw error }
                preparationTasks.removeValue(forKey: id)
                guard let prepared = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) else { return }
                job = prepared
            }
            guard ![.done, .attention].contains(job.stage) else { return }
            try Task.checkCancellation()
            guard let token = try credentials.read("arena.\(job.draft.accountID)"), !token.isEmpty else {
                job.resumeStage = job.stage; job.stage = .attention; job.problem = "Reconnect this Are.na account to finish saving."
                job = try save(job); return
            }
            if [.create, .connect, .provenanceWrite].contains(job.stage) {
                let api = ArenaAPI(token: token)
                let account = try await api.me()
                guard account.id == job.draft.accountID else { throw CaptureError.message("The authenticated account changed. Reconnect the original account to finish this capture.") }
                if let provenance = job.provenance {
                    _ = try CaptureDefaultRoute.verifiedProvenanceChannel(try await api.channel(String(provenance.channelID)), accountID: job.draft.accountID, expectedChannelID: provenance.channelID)
                }
            }
            if job.stage == .upload, (job.uploadExpiry ?? .distantPast) <= Date().addingTimeInterval(30) { job.stage = .presign; job = try save(job) }
            let operation = try request(job, token: token)
            let transferID = UUID().uuidString
            var file: URL?
            if let media = operation.file { file = media }
            else if let body = operation.body {
                file = directory.appendingPathComponent(transferID).appendingPathExtension("request.json")
                #if os(iOS)
                try body.write(to: file!, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                #else
                try body.write(to: file!, options: .atomic)
                #endif
            }
            guard let reserved = try reserveTransfer(job, transferID: transferID) else { return }
            job = reserved
            let task = try transport(ownIdentifier).submit(id: transferID, request: operation.request, file: file, notBefore: job.notBefore)
            let stopping = (try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)).map(shouldCancelTransferOnStop) == true
            if stopping { task.cancel() }
            else { task.resume() }
        } catch is CancellationError {
            // BGProcessing expiration suspends preparation; it does not cancel the submitted save.
            return
        } catch DeliveryCoordinationError.changed {
            return
        } catch {
            if var job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) {
                if job.transferID == nil { job.resumeStage = job.stage; job.stage = .attention }
                job.problem = error.localizedDescription
                _ = try? save(job)
            }
        }
    }

    /// Reserve identity, target and revision before URLSession can transmit the request.
    func reserveTransfer(_ source: DeliveryJob, transferID: String) throws -> DeliveryJob? {
        var reserved: DeliveryJob?
        try store.transaction {
            guard let current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString), current.transferID == nil,
                  current.stage == source.stage, current.revision == source.revision else { return }
            guard current.stopRequestedAt == nil || [.reconcile, .connections].contains(current.stage) else { return }
            var job = source
            if job.attemptedChannelIDs != nil, [.create, .connect].contains(job.stage),
               let target = job.stage == .create ? job.draft.selection.channels.first?.id : job.draft.selection.channels.first(where: { !job.connected.contains($0.id) })?.id {
                if job.stage == .connect, job.attemptedChannelIDs?.contains(target) == true { throw CaptureError.message("The earlier placement is unconfirmed. Check this capture before continuing.") }
                if job.attemptedChannelIDs?.contains(target) != true { job.attemptedChannelIDs?.append(target) }
            }
            job.transferID = transferID; job.transferSession = ownIdentifier; job.transferStarted = Date()
            reserved = try save(job)
        }
        return reserved
    }

    func request(_ job: DeliveryJob, token: String) throws -> (request: URLRequest, body: Data?, file: URL?) {
        if job.draft.isPlacementOnly, [.presign, .upload, .create, .update].contains(job.stage) {
            throw CaptureError.message("This operation only adds placements to the existing block.")
        }
        let base = "https://api.are.na/v3/"
        var address: String
        var method = "GET"
        var body: JSONValue?
        var file: URL?
        switch job.stage {
        case .destinations:
            address = base + "channels/\(job.draft.selection.channels[job.destinationIndex ?? 0].id)"
        case .presign:
            address = base + "uploads/presign"; method = "POST"
            body = .object(["files": .array([.object(["filename": .string(URL(fileURLWithPath: job.mediaPath!).lastPathComponent), "content_type": .string(job.mediaType!)])])])
        case .upload:
            guard let upload = job.uploadURL else { throw CaptureError.message("Upload instructions are missing.") }
            address = upload; method = "PUT"; file = URL(fileURLWithPath: job.mediaPath!)
        case .create:
            address = base + "blocks"; method = "POST"
            var payload = job.prepared.payload
            let creationChannels = job.attemptedChannelIDs == nil ? job.draft.selection.channels : Array(job.draft.selection.channels.prefix(1))
            payload["channel_ids"] = .array(creationChannels.map { .number(Double($0.id)) })
            if let provenance = job.provenance {
                payload.removeValue(forKey: "channel_ids")
                payload["channels"] = .array(creationChannels.map { channel in
                    .object(["id": .number(Double(channel.id))].merging(channel.id == provenance.channelID ? ["metadata": .object(provenance.metadata)] : [:]) { _, new in new })
                })
            }
            payload["metadata"] = .object(payload["metadata"]?.object.merging(["arena_capture_id": .string(job.id.uuidString)]) { _, new in new } ?? ["arena_capture_id": .string(job.id.uuidString)])
            if let source = job.uploadedSource {
                if job.mediaType?.hasPrefix("image/") == true {
                    guard let base = job.ingestBase, let ingest = URL(string: base), ingest.scheme == "https", ingest.host != nil, ingest.query == nil, ingest.fragment == nil, ingest.user == nil, ingest.password == nil else { throw CaptureError.message("The public source-link service is not configured for this build.") }
                    let descriptor = ["source": job.prepared.payload["original_source_url"]?.string ?? job.draft.input, "cover": source, "title": job.prepared.payload["title"]?.string ?? ""]
                    let encoded = try JSONEncoder().encode(descriptor).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
                    payload["value"] = .string(ingest.appendingPathComponent("ingest-native").appendingPathComponent(encoded).absoluteString)
                    payload["cover_url"] = .string(source)
                }
                else { payload["value"] = .string(source) }
            }
            body = .object(payload)
        case .read, .verify: address = base + "blocks/\(job.draft.blockID!)"
        case .update:
            address = base + "blocks/\(job.draft.blockID!)"; method = "PUT"; body = .object(job.prepared.update)
        case .connections: address = base + "blocks/\(job.draft.blockID!)/connections?per=100&page=\(job.page)"
        case .connect:
            address = base + "connections"; method = "POST"
            let missing = job.draft.selection.channels.map(\.id).filter { !job.connected.contains($0) }
            let targets = job.attemptedChannelIDs == nil ? missing : Array(missing.prefix(1))
            var fields: [String: JSONValue] = ["connectable_id": .number(Double(job.draft.blockID!)), "connectable_type": .string("Block"), "channel_ids": .array(targets.map { .number(Double($0)) })]
            if let provenance = job.provenance, targets.first == provenance.channelID, job.attemptedChannelIDs != nil {
                fields.removeValue(forKey: "channel_ids")
                fields["channels"] = .array([.object(["id": .number(Double(provenance.channelID)), "metadata": .object(provenance.metadata)])])
            }
            body = .object(fields)
        case .reconcile: address = base + "users/\(job.draft.accountID)/contents?type=Block&sort=created_at_desc&per=100&page=\(job.page)"
        case .provenanceContents:
            guard let provenance = job.provenance else { throw CaptureError.message("The retained provenance target is missing.") }
            address = base + "channels/\(provenance.channelID)/contents?per=100&page=\(job.page)"
        case .provenanceRead, .provenanceVerify:
            guard let connectionID = job.provenanceConnectionID else { throw CaptureError.message("The default connection is unconfirmed.") }
            address = base + "connections/\(connectionID)"
        case .provenanceWrite:
            guard let connectionID = job.provenanceConnectionID, let patch = job.provenancePatch else { throw CaptureError.message("The retained provenance update is missing.") }
            address = base + "connections/\(connectionID)"; method = "PUT"; body = .object(["metadata": .object(patch)])
        case .queued, .reading, .rendering, .done, .attention: throw CaptureError.message("This capture has no pending transfer.")
        }
        guard let url = URL(string: address), url.scheme == "https", url.user == nil, url.password == nil else { throw CaptureError.message("The upload address is invalid.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(job.stage == .upload ? job.mediaType! : "application/json", forHTTPHeaderField: "Content-Type")
        if job.stage != .upload { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return (request, try body.map { try JSONEncoder().encode($0) }, file)
    }

    func consume(_ result: BackgroundHTTPResult, job: inout DeliveryJob) {
        let success = result.status.map { (200..<300).contains($0) } == true && result.error == nil
        guard success else {
            job.attempts += 1
            if job.stage == .provenanceWrite, result.error != nil || result.status == nil || result.status == 408 || (result.status ?? 0) >= 500 {
                job.stage = .provenanceRead
                job.notBefore = result.retryAfter ?? Date().addingTimeInterval(5)
            } else if job.stage == .connect {
                job.connectionAttempts = (job.connectionAttempts ?? 0) + 1
                job.stage = .connections; job.page = 1; job.scanningConnected = nil
                if result.status == 401 || result.status == 403 || result.status == 404 || result.status == 422 {
                    fail(&job, result.status == 401 ? "Reconnect Are.na to finish this capture." : "The block could not be connected to every destination. Check its channels before retrying.")
                } else {
                    job.notBefore = result.retryAfter ?? Date().addingTimeInterval(5)
                }
            } else if job.stage == .create, result.error != nil || result.status == nil || result.status == 408 || (result.status ?? 0) >= 500 {
                job.stage = .reconcile; job.draft.phase = .uncertain; job.page = 1
                job.problem = "Checking Are.na before retrying this submission."
            } else if job.stage == .upload && result.status == 403 { job.stage = .presign }
            else if result.status == 429 || result.status == nil || (result.status ?? 0) >= 500 {
                if job.attempts < 8 { job.notBefore = result.retryAfter ?? Date().addingTimeInterval(min(900, pow(2, Double(job.attempts)) * 5)) }
                else { job.resumeStage = job.stage; job.stage = .attention; job.problem = "Saving paused after repeated connection failures." }
            } else {
                job.resumeStage = job.stage; job.stage = .attention
                job.problem = result.status == 401 ? "Reconnect Are.na to finish this capture." : "Are.na could not finish this capture (HTTP \(result.status ?? 0))."
            }
            return
        }
        job.attempts = 0; job.notBefore = nil; job.problem = nil
        let received = result.json
        let json: JSONValue?
        if [.provenanceRead, .provenanceVerify].contains(job.stage), let wrapped = received?["data"], wrapped["id"]?.int != nil {
            json = wrapped
        } else { json = received }
        switch job.stage {
        case .destinations:
            guard json?["can"]?["add_to"] == .bool(true) else { fail(&job, "You can no longer add to one of the selected channels. Your submitted capture is retained in History."); return }
            if let provenance = job.provenance, job.draft.selection.channels[job.destinationIndex ?? 0].id == provenance.channelID,
               (json?["id"]?.int != provenance.channelID || json?["owner"]?["id"]?.int != job.draft.accountID || json?["owner"]?["type"]?.string != "User" || json?["visibility"]?.string != "private") {
                fail(&job, "The default is no longer verified as your private channel. Your submitted capture is retained in History.")
                return
            }
            job.destinationIndex = (job.destinationIndex ?? 0) + 1
            if job.destinationIndex! >= job.draft.selection.channels.count {
                job.stage = job.reuseExisting == true ? .read : (job.mediaPath == nil ? .create : .presign)
            }
        case .presign:
            guard let file = json?["files"]?.array.first, let url = file["upload_url"]?.string,
                  let key = file["key"]?.string, !key.split(separator: "/").contains(".."),
                  file["content_type"]?.string == job.mediaType else { fail(&job, "Are.na returned incomplete upload instructions."); return }
            job.uploadURL = url
            job.uploadedSource = URL(string: "https://s3.amazonaws.com/arena_images-temp/")!.appendingPathComponent(key).absoluteString
            job.uploadExpiry = Date().addingTimeInterval(Double(json?["expires_in"]?.int ?? 3600))
            job.stage = .upload
        case .upload: job.stage = .create
        case .create:
            guard let id = json?["id"]?.int else { job.stage = .reconcile; job.draft.phase = .uncertain; return }
            job.draft.blockID = id; job.stage = .read; job.block = json
        case .read:
            guard json?["state"]?.string == "available" else {
                if json?["state"]?.string == "failed" { fail(&job, "Are.na could not process the block. Open the saved block to inspect it.") }
                else { job.notBefore = Date().addingTimeInterval(5) }
                return
            }
            job.block = json
            if job.draft.isPlacementOnly {
                job.contentVerified = true; job.stage = .connections; job.page = 1; job.scanningConnected = nil
            } else { job.stage = job.reuseExisting == true || job.prepared.update.isEmpty ? .verify : .update }
        case .update: job.stage = .verify
        case .verify:
            guard let block = json else { fail(&job, "The saved block could not be read."); return }
            if let plan = job.draft.previewSnapshot?.plan {
                do {
                    let runtime = try CaptureRuntime()
                    try runtime.verify(planJSON: String(decoding: JSONEncoder().encode(plan), as: UTF8.self), blockJSON: String(decoding: JSONEncoder().encode(block), as: UTF8.self))
                    if ["link", "image"].contains(plan["block"]?["kind"]?.string ?? ""),
                       try runtime.copiedCover(blockJSON: String(decoding: JSONEncoder().encode(block), as: UTF8.self)).isEmpty {
                        fail(&job, "Are.na did not retain the approved cover image. Open the block to inspect it."); return
                    }
                } catch { fail(&job, error.localizedDescription); return }
            }
            for (key, expected) in job.prepared.update where expected != .null {
                let actual = block[key]?["markdown"] ?? block[key]
                guard actual == expected || (expected == .string("") && (actual == nil || actual == .null)) else { fail(&job, "The saved \(key) differs from the approved capture. Open the block to inspect it."); return }
            }
            job.block = block; job.contentVerified = true; job.stage = .connections; job.page = 1; job.scanningConnected = nil
        case .connections:
            guard let data = json?["data"], case .array(let rows) = data,
                  let pagination = json?["meta"]?["has_more_pages"], case .bool(let hasMore) = pagination,
                  rows.allSatisfy({ ($0["id"]?.int ?? 0) > 0 }) else {
                fail(&job, "Are.na returned an incomplete connections page. Confirmed placements are retained for review."); return
            }
            job.scanningConnected = (job.scanningConnected ?? []).union(rows.compactMap { $0["id"]?.int })
            if hasMore {
                guard let page = json?["meta"]?["next_page"]?.int, page > job.page else {
                    fail(&job, "Are.na returned incomplete connections pagination. Confirmed placements are retained for review."); return
                }
                job.page = page; return
            }
            job.connected = job.scanningConnected ?? []
            job.scanningConnected = nil
            if job.stopRequestedAt != nil {
                job.stage = .attention
                job.problem = job.connected.isEmpty
                    ? "Stopped. The block exists, but no selected placement was confirmed. Continue Save uses this same block."
                    : "Stopped after checking the block. Confirmed placements are shown; Continue Save uses this same block."
                return
            }
            let missing = job.draft.selection.channels.map(\.id).filter { !job.connected.contains($0) }
            if job.attemptedChannelIDs != nil, let provenance = job.provenance,
               job.connected.contains(provenance.channelID), job.firstProvenanceVerified != true {
                job.verifyingFirstProvenance = true; job.stage = .provenanceContents; job.page = 1
            } else if missing.isEmpty {
                job.stage = job.provenance == nil ? .done : .provenanceContents; job.page = 1
            } else if let attempted = job.attemptedChannelIDs {
                if attempted.contains(missing[0]) { fail(&job, "The earlier placement is unconfirmed. Inspect its connections in Are.na before continuing.") }
                else { job.connectionAttempts = 0; job.stage = .connect }
            } else if job.reuseExisting == true, (job.connectionAttempts ?? 0) < 3 { job.stage = .connect }
            else { fail(&job, "The block exists, but some destinations were not confirmed. Inspect its connections in Are.na.") }
        case .connect:
            job.connectionAttempts = (job.connectionAttempts ?? 0) + 1
            job.stage = .connections; job.page = 1; job.scanningConnected = nil
        case .reconcile:
            // Restarting at page one must discard a candidate from an interrupted scan.
            if job.page == 1 { job.reconcileCandidateID = nil }
            guard let data = json?["data"], case .array(let rows) = data,
                  let pagination = json?["meta"]?["has_more_pages"], case .bool(let hasMore) = pagination else {
                fail(&job, "Are.na returned an incomplete creation readback. Check your destinations before deciding to submit again.")
                job.draft.phase = .uncertain; return
            }
            for row in rows where row["metadata"]?["arena_capture_id"]?.string == job.id.uuidString {
                guard let id = row["id"]?.int, id > 0,
                      job.reconcileCandidateID == nil || job.reconcileCandidateID == id else {
                    fail(&job, "More than one block matches this capture. Check your destinations before continuing.")
                    job.draft.phase = .uncertain; return
                }
                job.reconcileCandidateID = id
            }
            if hasMore {
                guard job.page < 10, let page = json?["meta"]?["next_page"]?.int, page > job.page else {
                    fail(&job, "Are.na did not complete the creation readback. Check your destinations before deciding to submit again.")
                    job.draft.phase = .uncertain; return
                }
                job.page = page
            } else if let id = job.reconcileCandidateID {
                job.draft.blockID = id; job.reconcileCandidateID = nil; job.stage = .read
            } else {
                fail(&job, "Are.na did not confirm whether this capture was created. Check your destinations before deciding to submit again.")
                job.draft.phase = .uncertain
            }
        case .provenanceContents:
            let matches = json?["data"]?.array.filter { $0["id"]?.int == job.draft.blockID && $0["type"]?.string != "Channel" } ?? []
            guard matches.count <= 1 else { fail(&job, "The default has ambiguous connections for this block. Provenance was not changed."); return }
            if let match = matches.first {
                guard let connectionID = match["connection"]?["id"]?.int, connectionID > 0,
                      job.provenanceConnectionID == nil || job.provenanceConnectionID == connectionID else {
                    fail(&job, "The default connection could not be identified. Provenance was not changed."); return
                }
                job.provenanceConnectionID = connectionID
                // A placement is unique within its channel. Once this row identifies
                // the connection, verify that connection directly; the rest of a
                // large Inbox cannot change the identity of this placement.
                job.stage = .provenanceRead
                return
            }
            if json?["meta"]?["has_more_pages"] == .bool(true) {
                guard job.page < 3, let page = json?["meta"]?["next_page"]?.int, page > job.page else {
                    fail(&job, "The default connection exceeded the bounded verification scan. The block is retained."); return
                }
                job.page = page
            } else { fail(&job, "The default placement is unconfirmed. Provenance was not changed.") }
        case .provenanceRead, .provenanceVerify:
            guard let connectionID = job.provenanceConnectionID, json?["id"]?.int == connectionID,
                  json?["connected_by"]?["id"]?.int == job.draft.accountID, let provenance = job.provenance else {
                fail(&job, "The default connection belongs to a different actor. Provenance was not changed."); return
            }
            let current = json?["metadata"]?.object ?? [:]
            if job.verifyingFirstProvenance == true {
                if job.attemptedChannelIDs?.contains(provenance.channelID) == true,
                   !provenance.metadata.allSatisfy({ current[$0.key] == $0.value }) {
                    fail(&job, "The first placement's provenance is unconfirmed. Later placements were not sent."); return
                }
                job.verifyingFirstProvenance = false; job.firstProvenanceVerified = true
                job.stage = .connections; job.page = 1; job.scanningConnected = nil; job.connectionAttempts = 0
                return
            }
            if job.stage == .provenanceVerify {
                guard let patch = job.provenancePatch, patch.allSatisfy({ current[$0.key] == $0.value }) else {
                    fail(&job, "Save provenance was not confirmed. The block is retained; retry the same capture."); return
                }
                job.draft.provenanceConnectionID = connectionID; job.stage = .done
            } else {
                do {
                    let patch = try provenance.patch(current: current)
                    job.provenancePatch = patch
                    if patch.allSatisfy({ current[$0.key] == $0.value }) { job.draft.provenanceConnectionID = connectionID; job.stage = .done }
                    else { job.stage = .provenanceWrite }
                } catch { fail(&job, error.localizedDescription) }
            }
        case .provenanceWrite: job.stage = .provenanceVerify
        case .queued, .reading, .rendering, .done, .attention: break
        }
    }

    private func cleanupCompleted(_ job: DeliveryJob) {
        guard let path = job.mediaPath else { return }
        let root = directory.deletingLastPathComponent().appendingPathComponent("renders").standardizedFileURL.path + "/"
        let file = URL(fileURLWithPath: path).standardizedFileURL
        guard file.path.hasPrefix(root),
              (try? store.containsValue(DeliveryJob.self, account: 0, kind: "delivery", matching: { $0.mediaPath == path })) == false else { return }
        try? FileManager.default.removeItem(at: file)
        if (try? FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path).isEmpty) == true {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
    }

    private func fail(_ job: inout DeliveryJob, _ message: String) { job.resumeStage = job.stage; job.stage = .attention; job.problem = message }

    @discardableResult
    private func save(_ source: DeliveryJob) throws -> DeliveryJob {
        var job = source
        // Every route to completion (including retained provenance-only recovery)
        // must satisfy the entire frozen command, rather than just the default.
        if job.stage == .done {
            let complete = Set(job.draft.selection.channels.map(\.id)).isSubset(of: job.connected)
            if job.draft.blockID == nil {
                job.resumeStage = .reconcile; job.stage = .attention; job.draft.phase = .uncertain
                job.problem = "The block identity is unconfirmed. Check this capture before continuing."
            } else if job.contentVerified != true {
                job.stage = .read; job.page = 1
            } else if !complete {
                job.stage = .connections; job.page = 1; job.scanningConnected = nil
            }
        }
        try store.transaction {
            guard let current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString), current.revision == source.revision else { throw DeliveryCoordinationError.changed }
            job.revision = (source.revision ?? 0) + 1
            job.draft.updatedAt = Date(); job.draft.problem = job.problem
            job.draft.deliveryState = job.state
            if let block = job.block { job.draft.savedBlock = block }
            if job.stage == .done {
                job.draft.phase = .saved; job.draft.savedBlock = job.block; job.draft.renderPath = nil
                if let key = job.draft.publicationKey, let id = job.draft.blockID {
                    try store.save(id, account: job.draft.accountID, kind: "published", id: key)
                    try store.remove(account: job.draft.accountID, kind: "publicationLock", id: key)
                }
            } else if job.stage == .attention {
                if job.draft.phase != .uncertain { job.draft.phase = job.draft.blockID == nil ? .queued : .checking }
            } else if job.stage == .reconcile { job.draft.phase = .uncertain }
            else { job.draft.phase = job.draft.blockID == nil ? .queued : .checking }
            try store.save(job.draft, account: job.draft.accountID, kind: "draft", id: job.id.uuidString)
            if job.stage == .done { try store.remove(account: 0, kind: "delivery", id: job.id.uuidString) }
            else { try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString) }
        }
        return job
    }
}

private enum DeliveryCoordinationError: Error { case changed }
