import CaptureCore
import CaptureRuntime
import Foundation
import CryptoKit
import Darwin

struct CreateReadbackWindow: Codable {
    var descendingPages = true
    var previousPageMinimum: Date?
    var candidateCreatedAt: Date?
    var candidateAccountID: Int?
}

struct DeliveryJob: Codable, Identifiable {
    typealias Stage = CaptureDeliveryStage
    var id: UUID
    var revision: Int?
    var receiptID: UUID?
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
    var placementValidationID: Int?
    var validatedChannelIDs: Set<Int>?
    /// Later placement cycles request additions, not restoration of old receipts.
    var requiredChannelIDs: Set<Int>?
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
    /// A terminal fence, retained outside the executable delivery queue.
    var canceledAt: Date?
    var canceledTransferStage: Stage?
    var canceledTransferResult: BackgroundHTTPResult?
    var canceledUnconfirmedBlockRequest: Bool?
    /// Once observed, a placement must never be silently restored after removal.
    var confirmedOnceChannelIDs: Set<Int>?
    /// One retry of exactly these missing targets was explicitly reaffirmed.
    /// Receipt readback and fresh actor/channel checks still precede dispatch.
    var reaffirmedChannelIDs: Set<Int>?
    /// A newly accepted Add-to delta can explicitly restore a historical target.
    /// This authority is separate from recovery and covers one admission only.
    var explicitlyAddedChannelIDs: Set<Int>?
    var connectionRetryCounts: [Int: Int]?
    var readOnlyReconciliation: Bool?
    var lastReadOnlyReconciliationAt: Date?
    var lastTransferProgress: CaptureTransferProgress?
    var lastTransferOutcome: CaptureTransferOutcome?
    var interruption: CaptureInterruption?
    var mediaUploadCompletedAt: Date?
    var uploadAuthorizationRenewals: Int?
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
    var reconcileWindow: CreateReadbackWindow?
    /// UUID readback recovered an existing create whose reply was unavailable.
    var reconciledCreate: Bool?
    /// One admission only: an unknown PUT cannot be replayed over a later edit,
    /// even when that edit happens to restore the generated placeholder.
    var initialFieldsAttemptedAt: Date?
    var block: JSONValue?
    var problem: String?
    var provenance: CaptureConnectionProvenance?
    var provenanceConnectionID: Int?
    var provenancePatch: [String: JSONValue]?
    var requiredChannels: [Channel] {
        guard let requiredChannelIDs else { return draft.selection.channels }
        return draft.selection.channels.filter { requiredChannelIDs.contains($0.id) }
    }
    var state: CaptureDeliveryState {
        var state = CaptureDeliveryState(operationID: id, receiptID: receiptID ?? id, stage: canceledAt == nil ? stage : .done,
            confirmedChannelIDs: connected.intersection(Set(draft.selection.channels.map(\.id))),
            contentVerified: contentVerified == true || (stage == .done && canceledAt == nil), notBefore: notBefore,
            stopRequested: stopRequestedAt != nil, canceledAt: canceledAt,
            canceledWithUnconfirmedRequest: canceledAt == nil ? nil : hasUnconfirmedBlockRequest,
            confirmedOnceChannelIDs: confirmedOnceChannelIDs, attemptedChannelIDs: attemptedChannelIDs,
            preparationFailureStage: preparationFailureStage)
        let effective = stage == .attention ? resumeStage : stage
        state.preparationCompleted = effective.map { ![.queued, .reading, .rendering, .attention].contains($0) } ?? false
        state.mediaUploadRequired = mediaPath != nil
        state.mediaUploadCompleted = mediaUploadCompletedAt != nil || (mediaPath != nil && effective.map { [.create, .read, .update, .verify, .connections, .connect, .provenanceContents, .provenanceRead, .provenanceWrite, .provenanceVerify, .done].contains($0) } == true)
        state.transferProgress = lastTransferProgress
        state.lastTransferOutcome = lastTransferOutcome; state.interruption = interruption
        return state
    }
    var hasUnconfirmedBlockRequest: Bool {
        guard draft.blockID == nil else { return false }
        if let canceledUnconfirmedBlockRequest { return canceledUnconfirmedBlockRequest }
        return draft.phase == .uncertain || draft.phase == .creating || attemptedChannelIDs?.isEmpty == false
            || (stage == .create && transferID != nil) || canceledTransferStage == .create || resumeStage == .reconcile
    }
    var writesAreFenced: Bool { canceledAt != nil || stopRequestedAt != nil || readOnlyReconciliation == true }
    var preparationFailureStage: Stage? {
        guard canceledAt == nil, stage == .attention, stopRequestedAt == nil, problem != nil,
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
        guard canceledAt == nil else { return }
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
    // Match the CLI's bounded placement lookup. A confirmed older block can
    // sit beyond the first 300 entries in a manually ordered default channel.
    private static let provenancePageLimit = 20
    // Admission precedes creation. Include five additional minutes for device
    // clock skew; a history too dense to cross this boundary remains uncertain.
    private static let createReadbackClockSkew: TimeInterval = 5 * 60
    let store: CaptureStore
    private let credentials: CredentialStore
    private let directory: URL
    private let group: String
    private let ownIdentifier: String
    private let ingestBase: String?
    private var transports: [String: BackgroundHTTP] = [:]
    private var running: Set<UUID> = []
    private var needsAdvance: Set<UUID> = []
    private var sessionLocks: [String: Int32] = [:]
    private var recoveryTasks: [UUID: Task<Void, Never>] = [:]
    private var progressStallTasks: [String: Task<Void, Never>] = [:]
    private var preparationTasks: [UUID: Task<Void, Error>] = [:]
    private var activeContinued: [UUID: UUID] = [:]
    private var retiring = false
    var changed: (() -> Void)?
    var progressChanged: (() -> Void)?
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
        guard retiring, (try? hasPendingWork()) == false else { return }
        for transport in transports.values { transport.finish() }
    }

    func hasPendingWork() throws -> Bool {
        for id in try store.recordIDs(account: 0, kind: "delivery") {
            if try store.projectedValue(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: id) != nil { continue }
            if try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id)?.hasPendingWork == true { return true }
        }
        return false
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
        guard media.map({ !NativeMediaWorkspace.isTemporaryPath($0) }) ?? true else { throw CaptureError.message("The media is still being prepared.") }
        var snapshot = draft
        guard snapshot.deliveryState?.canceledAt == nil else { throw CaptureError.message("This save was canceled. Start a new capture.") }
        snapshot.phase = .queued; snapshot.updatedAt = Date(); snapshot.problem = nil
        guard !snapshot.selection.channels.isEmpty, snapshot.selection.channels.count <= 20 else { throw CaptureError.message("Choose 1 to 20 channels.") }
        let provenance = snapshot.provenanceChannelID == nil ? nil : try CaptureConnectionProvenance(draft: snapshot, prepared: prepared)
        snapshot.provenanceSnapshotJSON = provenance?.snapshotJSON
        try store.transaction {
            guard try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: snapshot.id.uuidString) == nil else { throw CaptureError.message("This save was canceled. Start a new capture.") }
            guard try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: snapshot.id.uuidString) == nil else { return }
            if try store.value(CaptureDraft.self, account: snapshot.accountID, kind: "draft", id: snapshot.id.uuidString)?.phase == .saved { return }
            if let key = snapshot.publicationKey {
                guard try store.reservePublication(account: snapshot.accountID, key: key, draftID: snapshot.id) else {
                    throw CaptureError.message("An earlier save for this source is pending. Check History.")
                }
                snapshot.blockID = try store.value(Int.self, account: snapshot.accountID, kind: "published", id: key)
            }
            if snapshot.isPlacementOnly {
                guard snapshot.blockID != nil, media == nil, prepared.update.isEmpty else {
                    throw CaptureError.message("Edit the saved block in Are.na.")
                }
            }
            var job = DeliveryJob(id: snapshot.id, draft: snapshot, prepared: prepared, attemptedChannelIDs: [], mediaPath: media?.path, mediaType: contentType, ingestBase: ingestBase, reuseExisting: snapshot.blockID != nil, stage: .destinations)
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
        guard draft.deliveryState?.canceledAt == nil,
              try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: draft.id.uuidString) == nil else { throw CaptureError.message("This save was canceled. Start a new capture.") }
        if let existing = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: draft.id.uuidString) {
            guard existing.draft.accountID == draft.accountID else { throw CaptureError.message("Reconnect the account used for this save.") }
            return draft.id
        }
        if try store.value(CaptureDraft.self, account: draft.accountID, kind: "draft", id: draft.id.uuidString)?.phase == .saved { return draft.id }
        var snapshot = draft
        guard !snapshot.selection.channels.isEmpty, snapshot.selection.channels.count <= 20 else { throw CaptureError.message("Choose 1 to 20 channels.") }
        let submission = snapshot.isPlacementOnly ? nil : try CaptureSubmissionSnapshot(draft: snapshot)
        if snapshot.isPlacementOnly, snapshot.blockID == nil { throw CaptureError.message("The existing block is unavailable.") }
        snapshot.phase = .queued; snapshot.problem = nil; snapshot.updatedAt = Date()
        snapshot.renderPath = nil; snapshot.publicationKey = nil
        try store.transaction {
            guard try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: snapshot.id.uuidString) == nil else { throw CaptureError.message("This save was canceled. Start a new capture.") }
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

    /// Already sent and confirmed placements cannot be cancelled by a local toggle.
    /// Unsent choices remain editable, including while another request is in flight.
    func protectedPlacementIDs(_ id: UUID, account: Int) throws -> Set<Int> {
        guard let draft = try store.value(CaptureDraft.self, account: account, kind: "draft", id: id.uuidString) else { return [] }
        guard let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) else {
            return Set(draft.selection.channels.map(\.id))
        }
        guard job.draft.accountID == account else { throw CaptureError.message("Reconnect the account used for this save.") }
        // Legacy batched jobs cannot prove which selected targets were sent.
        let selected = Set(job.draft.selection.channels.map(\.id))
        var protected = job.connected.union(job.attemptedChannelIDs ?? Array(selected)).intersection(selected)
        if let channel = job.provenance?.channelID { protected.insert(channel) }
        return protected
    }

    /// Amend only placement intent. Source, media, block identity and outstanding
    /// request identity stay unchanged. Revision fencing prevents stale dispatch.
    @discardableResult func amendPlacements(_ id: UUID, account: Int, selection proposed: DestinationSelection, baseline: DestinationSelection? = nil) throws -> UUID {
        try store.transaction {
            guard try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: id.uuidString) == nil else { throw CaptureError.message("This save was canceled. Start a new capture.") }
            guard let before = try store.value(CaptureDraft.self, account: account, kind: "draft", id: id.uuidString),
                  before.canAddPlacements else { throw CaptureError.message("Wait until this block has been checked before adding channels.") }
            var selection = proposed
            if let baseline {
                // Apply this picker's delta to the latest selection. Concurrent
                // additions from another process are retained, never overwritten.
                let old = Set(baseline.channels.map(\.id)), chosen = Set(proposed.channels.map(\.id))
                let removed = old.subtracting(chosen)
                selection = DestinationSelection(defaultChannel: nil)
                for channel in before.selection.channels where !removed.contains(channel.id) { selection.toggle(channel, maxCount: Int.max) }
                for channel in proposed.channels where !old.contains(channel.id) && !selection.contains(channel) { selection.toggle(channel, maxCount: Int.max) }
                let expected = Set(before.selection.channels.map(\.id)).subtracting(removed).union(chosen.subtracting(old))
                guard Set(selection.channels.map(\.id)) == expected else { throw CaptureError.message("The selected channels changed. Reopen the picker and try again.") }
            }
            let ids = selection.channels.map(\.id)
            let observed = Set((baseline ?? before.selection).channels.map(\.id))
            guard !ids.isEmpty, Set(ids).count == ids.count,
                  Set(proposed.channels.map(\.id)).subtracting(observed).count <= 20,
                  Set(ids).subtracting(Set(before.selection.channels.map(\.id))).count <= 20 else {
                throw CaptureError.message("Choose up to 20 additional channels at a time.")
            }
            let protected = try protectedPlacementIDs(id, account: account)
            guard protected.isSubset(of: Set(ids)) else {
                throw CaptureError.message("A channel has already been sent or confirmed. Keep it selected, or remove the connection in Are.na.")
            }
            guard selection.channels.map(\.id) != before.selection.channels.map(\.id) else { return }
            let change = CapturePlacementChange(before: before, selectedChannels: selection.channels)
            let added = Set(ids).subtracting(Set(before.selection.channels.map(\.id)))
            if var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) {
                guard job.draft.accountID == account, job.contentVerified == true, job.draft.blockID == before.blockID,
                      (job.stage != .destinations || job.placementValidationID != nil),
                      (job.stage != .attention || job.resumeStage != .destinations || job.placementValidationID != nil) else {
                    throw CaptureError.message("The save changed. Reopen its channels and try again.")
                }
                if let required = job.requiredChannelIDs {
                    job.requiredChannelIDs = required.intersection(Set(ids)).union(Set(ids).subtracting(Set(before.selection.channels.map(\.id))))
                }
                job.explicitlyAddedChannelIDs = (job.explicitlyAddedChannelIDs ?? []).union(added)
                job.validatedChannelIDs = job.validatedChannelIDs?.subtracting(added)
                if !added.isDisjoint(with: job.confirmedOnceChannelIDs ?? []), job.transferID == nil, job.stage != .attention {
                    job.stage = .connections; job.page = 1; job.scanningConnected = nil
                }
                job.draft.selection = selection
                job.draft.requestedChannelIDs = ids.filter { $0 != job.draft.submittedDefaultChannelID }
                // Keep the original provenance snapshot immutable. The audit
                // records retain each later choice without rewriting its receipt.
                _ = try save(job)
            } else {
                guard before.phase == .saved, before.blockID != nil else { throw CaptureError.message("Check this save before adding channels.") }
                var next = before
                next.selection = selection; next.intent = .placements
                next.phase = .checking; next.problem = nil; next.updatedAt = Date()
                next.requestedChannelIDs = ids.filter { $0 != before.submittedDefaultChannelID }
                next.publicationKey = nil
                var job = DeliveryJob(id: id, receiptID: UUID(), draft: next, prepared: .init(payload: [:], update: [:]),
                    attemptedChannelIDs: before.deliveryState?.attemptedChannelIDs ?? [], reuseExisting: true, contentVerified: false, stage: .read,
                    connected: before.deliveryState?.confirmedChannelIDs ?? Set(before.selection.channels.map(\.id)), block: before.savedBlock)
                job.confirmedOnceChannelIDs = (before.deliveryState?.confirmedOnceChannelIDs ?? []).union(before.deliveryState?.confirmedChannelIDs ?? Set(before.selection.channels.map(\.id)))
                job.requiredChannelIDs = Set(ids).subtracting(Set(before.selection.channels.map(\.id)))
                job.explicitlyAddedChannelIDs = added
                next.deliveryState = job.state
                var queued = job; queued.draft = next
                try store.save(next, account: account, kind: "draft", id: id.uuidString)
                try store.save(queued, account: 0, kind: "delivery", id: id.uuidString)
            }
            try store.save(change, account: account, kind: "placementChange", id: change.id.uuidString)
            var submitted = before; submitted.selection = selection
            try rememberSubmittedChannels(submitted)
        }
        needsAdvance.insert(id)
        changed?()
        return id
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
        let created = CapturePreparation(runtime: try CaptureRuntime(), container: directory.deletingLastPathComponent(),
            soundCloudService: { [credentials, group] in
                let defaults = UserDefaults(suiteName: group)
                guard let address = defaults?.string(forKey: "soundCloudMediaService"), let endpoint = URL(string: address),
                      let token = try credentials.read("soundcloud-media-service") else {
                    throw CaptureError.message("Configure the SoundCloud media service in Settings before saving audio.")
                }
                return try SoundCloudAudioService(endpoint: endpoint, token: token)
            })
        sourcePreparation = created; return created
    }

    /// Restartable local stages; the cheap source preview is committed before rendering starts.
    func preparePending(_ id: UUID) async throws {
        guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString) else { return }
        if job.stage == .queued { job.stage = .reading; job = try save(job); changed?() }
        if job.stage == .reading {
            guard let submission = job.submission else { throw CaptureError.message("The source for this save is unavailable.") }
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
                guard try store.reservePublication(account: job.draft.accountID, key: key, draftID: job.id) else { throw CaptureError.message("An earlier save for this source is pending. Check History.") }
                job.draft.blockID = try store.value(Int.self, account: job.draft.accountID, kind: "published", id: key)
                job.reuseExisting = job.draft.blockID != nil
                if job.reuseExisting == true { job.stage = .destinations; job.mediaPath = nil }
                job = try save(job)
            }
            changed?()
        }
        if job.stage == .rendering {
            guard let plan = job.draft.previewSnapshot?.plan, !job.draft.previewSnapshot!.selectedMedia.isEmpty else { throw CaptureError.message("The selected media is unavailable. No block was created.") }
            if let path = job.mediaPath, FileManager.default.fileExists(atPath: path) {
                job.mediaType = URL(fileURLWithPath: path).pathExtension.lowercased() == "mp4" ? "video/mp4" : "image/jpeg"
            } else {
                let media: NativeRenderedMedia?
                if let renderSource { media = try await renderSource(plan, id) }
                else { media = try await preparation().render(plan: plan, draftID: id) }
                guard let media else { throw CaptureError.message("The selected media could not be prepared. No block was created.") }
                guard !NativeMediaWorkspace.isTemporaryPath(media.fileURL) else { throw CaptureError.message("The media is still being prepared.") }
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
            try await acceptCanceledResults()
            for id in try store.recordIDs(account: 0, kind: "delivery") {
                guard !Task.isCancelled else { return }
                guard let job = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id) else { continue }
                let stoppedUnknownCreate = job.stopRequestedAt != nil && (job.draft.phase == .uncertain || job.resumeStage == .reconcile)
                if job.stage == .attention, job.draft.blockID != nil || stoppedUnknownCreate, job.transferID == nil,
                   Date().timeIntervalSince(job.lastReadOnlyReconciliationAt ?? .distantPast) >= 60 {
                    await inspectRetained(job.id, minimumInterval: 60)
                    continue
                }
                guard job.hasPendingWork,
                      job.continuedRequestedAt == nil || activeContinued[job.id] == (job.receiptID ?? job.id) || job.stopRequestedAt != nil else { continue }
                if let identifier = job.transferSession, transports[identifier] == nil { try? attach(identifier) }
                await advance(job.id)
            }
            changed?()
        } catch { changed?() }
    }

    func continuedOperationIDs() throws -> [UUID] {
        try store.recordIDs(account: 0, kind: "delivery").compactMap { raw in
            guard let job = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: raw),
                  job.continuedRequestedAt != nil else { return nil }
            return job.id
        }
    }

    /// Reserve the process-owned runtime claim before scheduling the system task.
    func beginContinued(_ id: UUID, receiptID: UUID? = nil) throws -> Bool {
        var claimedReceipt: UUID?
        try store.transaction {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  ![.done, .attention].contains(job.stage), job.stopRequestedAt == nil else { return }
            let receipt = job.receiptID ?? job.id
            guard receiptID == nil || receiptID == receipt else { return }
            claimedReceipt = receipt
            if job.continuedRequestedAt != nil, activeContinued[id] == receipt { return }
            job.continuedRequestedAt = Date()
            _ = try save(job)
        }
        if let receipt = claimedReceipt { activeContinued[id] = receipt }
        return claimedReceipt != nil
    }

    func activateContinued(_ id: UUID, receiptID: UUID? = nil) {
        guard let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
              job.continuedRequestedAt != nil,
              receiptID == nil || receiptID == (job.receiptID ?? job.id) else { return }
        activeContinued[id] = job.receiptID ?? job.id
    }

    func deactivateContinued(_ id: UUID, receiptID: UUID? = nil) {
        guard receiptID == nil || activeContinued[id] == receiptID else { return }
        activeContinued.removeValue(forKey: id)
    }

    func endContinued(_ id: UUID, receiptID: UUID? = nil) throws {
        try store.transaction {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  job.continuedRequestedAt != nil,
                  receiptID == nil || receiptID == (job.receiptID ?? job.id) else { return }
            activeContinued.removeValue(forKey: id)
            job.continuedRequestedAt = nil
            _ = try save(job)
        }
        changed?()
    }

    /// A foreground scene has no proof that an unclaimed task still owns
    /// execution. Fence writes before ordinary recovery without inferring why.
    func prepareForeground(isMainApplication: Bool) throws -> [UUID] {
        // The Share extension has a separate runtime claim map. Its empty map
        // says nothing about a continued save owned by the main application.
        guard isMainApplication else { return [] }
        return try pauseUnclaimedContinued()
    }

    func pauseUnclaimedContinued() throws -> [UUID] {
        let unclaimed = try continuedOperationIDs().filter { id in
            guard let job = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString) else { return false }
            return activeContinued[id] != (job.receiptID ?? job.id)
        }
        for id in unclaimed { try requestStop(id, reason: .executionClaimLost) }
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
        if job.draft.blockID != nil, job.stage == .attention { await inspectRetained(id) }
        else if job.stopRequestedAt != nil { await inspectStopped(id) }
        else if job.stage == .attention { await retry(id) }
        else { await advance(id) }
    }

    /// Project older failures without reopening source or save requests.
    func refreshPreparationFailures() throws {
        for id in try store.recordIDs(account: 0, kind: "delivery") {
            guard let projection = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id),
                  let failedStage = projection.preparationFailureStage,
                  projection.draft.deliveryState?.preparationFailureStage != failedStage,
                  let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id),
                  job.draft.deliveryState?.preparationFailureStage != failedStage else { continue }
            _ = try save(job)
        }
        changed?()
    }

    /// Persist the request before any in-flight URLSession result is interpreted.
    /// The result can still have created a block or connection; neither is cancelled here.
    func requestStop(_ id: UUID, receiptID: UUID? = nil, reason: CaptureInterruptionReason = .userPause) throws {
        var accepted = false
        try store.transaction {
            guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  job.stage != .done, job.stopRequestedAt == nil,
                  receiptID == nil || receiptID == (job.receiptID ?? job.id) else { return }
            accepted = true
            job.interruption = .init(reason: reason, stage: job.stage, transferID: job.transferID)
            job.stopRequestedAt = Date()
            job.continuedRequestedAt = nil
            if job.stage != .attention { job.resumeStage = job.stage }
            if job.transferID == nil {
                if job.draft.blockID != nil, !job.stage.permitsStoppedRead { job.stage = .connections; job.page = 1; job.scanningConnected = nil }
                settleStop(&job)
            }
            _ = try save(job)
        }
        guard accepted else { return }
        preparationTasks[id]?.cancel()
        activeContinued.removeValue(forKey: id)
        changed?()
        Task {
            await cancelStoppedTransfer(id)
            await advance(id)
        }
    }

    /// Commit a terminal cancellation before touching an in-flight task. Moving
    /// the journal out of `delivery` also fences older app versions: they can
    /// decode the draft but cannot resume this command after a rollback.
    func cancel(_ id: UUID, accountID: Int? = nil, receiptID: UUID? = nil) throws {
        var canceled: DeliveryJob?
        try store.transaction {
            if let existing = try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: id.uuidString) {
                guard accountID == nil || existing.draft.accountID == accountID else { return }
                try store.remove(account: 0, kind: "delivery", id: id.uuidString)
                if let visible = try store.value(CaptureDraft.self, account: existing.draft.accountID, kind: "draft", id: id.uuidString), visible.deliveryState?.canceledAt == nil {
                    try store.save(existing.draft, account: existing.draft.accountID, kind: "draft", id: id.uuidString)
                }
                canceled = existing
                return
            }
            var retained = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)
            if retained == nil {
                let accounts = try accountID.map { [$0] } ?? store.values(Account.self, account: 0, kind: "account").map(\.id)
                for account in accounts {
                    guard let draft = try store.value(CaptureDraft.self, account: account, kind: "draft", id: id.uuidString),
                          draft.isActiveCapture, draft.deliveryState?.canceledAt == nil else { continue }
                    retained = DeliveryJob(id: id, receiptID: draft.deliveryState?.receiptID, draft: draft, prepared: .init(payload: [:], update: [:]),
                        attemptedChannelIDs: draft.deliveryState?.attemptedChannelIDs,
                        resumeStage: draft.blockID == nil ? .reconcile : .connections,
                        contentVerified: draft.deliveryState?.contentVerified,
                        stage: .attention, connected: draft.deliveryState?.confirmedChannelIDs ?? [], block: draft.savedBlock)
                    retained?.confirmedOnceChannelIDs = draft.deliveryState?.confirmedOnceChannelIDs
                    break
                }
            }
            guard var job = retained, job.stage != .done,
                  accountID == nil || job.draft.accountID == accountID,
                  receiptID == nil || receiptID == (job.receiptID ?? job.id) else { return }
            job.canceledUnconfirmedBlockRequest = job.hasUnconfirmedBlockRequest
            job.canceledAt = Date(); job.stopRequestedAt = job.canceledAt
            job.canceledTransferStage = job.transferID == nil ? nil : job.stage
            job.continuedRequestedAt = nil; job.notBefore = nil; job.reaffirmedChannelIDs = nil; job.explicitlyAddedChannelIDs = nil
            if job.stage != .attention { job.resumeStage = job.stage }
            job.stage = .attention
            job.revision = (job.revision ?? 0) + 1
            updateCanceledDraft(&job)
            try updateCanceledPublication(job)
            try store.save(job.draft, account: job.draft.accountID, kind: "draft", id: id.uuidString)
            try store.save(job, account: 0, kind: "canceledDelivery", id: id.uuidString)
            try store.remove(account: 0, kind: "delivery", id: id.uuidString)
            canceled = job
        }
        guard canceled != nil else { return }
        if let transfer = canceled?.transferID { progressStallTasks.removeValue(forKey: transfer)?.cancel() }
        preparationTasks[id]?.cancel(); recoveryTasks[id]?.cancel()
        activeContinued.removeValue(forKey: id); needsAdvance.remove(id)
        changed?()
        Task { await cancelCanceledTransfer(id) }
    }

    private func updateCanceledDraft(_ job: inout DeliveryJob) {
        // These are legacy-readable presentation values, not a successful
        // completion receipt. The optional cancellation fact takes precedence.
        job.draft.phase = .saved; job.draft.updatedAt = Date()
        job.problem = job.draft.blockID == nil
            ? (job.hasUnconfirmedBlockRequest
               ? "Canceled. No block has been confirmed. An already-sent request may still have reached Are.na."
               : "Canceled. No block was created.")
            : "Canceled. The existing block and confirmed connections remain in Are.na."
        job.draft.problem = job.problem; job.draft.deliveryState = job.state
        if let block = job.block { job.draft.savedBlock = block }
    }

    private func updateCanceledPublication(_ job: DeliveryJob) throws {
        guard let key = job.draft.publicationKey else { return }
        if let blockID = job.draft.blockID {
            // A later explicit capture of the same material must reuse this
            // known block even when the canceled command never completed.
            try store.save(blockID, account: job.draft.accountID, kind: "published", id: key)
            if try store.value(UUID.self, account: job.draft.accountID, kind: "publicationLock", id: key) == job.id {
                try store.remove(account: job.draft.accountID, kind: "publicationLock", id: key)
            }
        } else if job.attemptedChannelIDs?.isEmpty == true, !job.hasUnconfirmedBlockRequest {
            if try store.value(UUID.self, account: job.draft.accountID, kind: "publicationLock", id: key) == job.id {
                try store.remove(account: job.draft.accountID, kind: "publicationLock", id: key)
            }
        }
    }

    private func cancelCanceledTransfer(_ id: UUID) async {
        guard let job = try? store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: id.uuidString),
              job.canceledAt != nil, let transferID = job.transferID,
              let owner = try? transport(job.transferSession ?? ownIdentifier) else { return }
        for task in await owner.tasks() where task.taskDescription == transferID { task.cancel() }
    }

    /// Only consume receipts which already exist on disk. A canceled command
    /// never schedules readback, retry, source preparation, or a remote mutation.
    private func acceptCanceledResults() async throws {
        for id in try store.recordIDs(account: 0, kind: "canceledDelivery") {
            guard let job = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "canceledDelivery", id: id),
                  let transferID = job.transferID else { continue }
            let reader = try transport(ownIdentifier)
            if let result = try reader.result(transferID) {
                _ = try accept(result, id: job.id, transferID: transferID)
                reader.removeResult(transferID)
            } else {
                await cancelCanceledTransfer(job.id)
            }
        }
    }

    private func cancelStoppedTransfer(_ id: UUID) async {
        guard let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
              shouldCancelTransferOnStop(job), let transferID = job.transferID,
              let owner = try? transport(job.transferSession ?? ownIdentifier) else { return }
        for task in await owner.tasks() where task.taskDescription == transferID { task.cancel() }
    }

    func shouldCancelTransferOnStop(_ job: DeliveryJob) -> Bool {
        job.writesAreFenced && !job.stage.permitsStoppedRead
    }

    /// Return exactly the still-selected missing targets an explicit continuation
    /// can reaffirm. Previously confirmed removals remain protected.
    func continuationTargets(_ id: UUID) throws -> Set<Int>? {
        guard try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: id.uuidString) == nil,
              let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
              job.canceledAt == nil, job.stage == .attention, job.transferID == nil,
              job.stopRequestedAt != nil || (job.draft.blockID != nil && job.contentVerified == true) else { return nil }
        let missing = Set(job.requiredChannels.map(\.id)).subtracting(job.connected)
        guard missing.subtracting(job.explicitlyAddedChannelIDs ?? []).isDisjoint(with: job.confirmedOnceChannelIDs ?? []),
              missing.allSatisfy({ (job.connectionRetryCounts?[$0] ?? 0) < 3 }) else { return nil }
        return job.draft.blockID == nil ? [] : missing
    }

    /// Retain the exact user reaffirmation before any further execution.
    @discardableResult func reaffirmContinuation(_ id: UUID, channelIDs: Set<Int>) throws -> Bool {
        var accepted = false
        try store.transaction {
                guard var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                      let missing = try continuationTargets(id) else { return }
                let ambiguous = missing.intersection(Set(job.attemptedChannelIDs ?? Array(missing)))
                guard channelIDs == missing || (channelIDs.isEmpty && ambiguous.isEmpty) else { return }
                job.reaffirmedChannelIDs = channelIDs
                job.readOnlyReconciliation = nil
                job.validatedChannelIDs = job.validatedChannelIDs?.subtracting(missing)
                job.stopRequestedAt = nil; job.problem = nil; job.notBefore = nil; job.attempts = 0; job.page = 1
                job.interruption = nil; job.uploadAuthorizationRenewals = nil
                if job.draft.phase == .uncertain || (job.draft.blockID == nil && job.attemptedChannelIDs?.isEmpty == false) {
                    job.stage = .reconcile
                } else if job.draft.blockID != nil {
                    job.stage = job.contentVerified == true ? .connections : .read
                    job.scanningConnected = nil
                } else {
                    job.stage = job.resumeStage ?? .queued
                }
                _ = try save(job)
                accepted = true
        }
        return accepted
    }

    /// An explicit continuation reuses the frozen command and its original UUID.
    /// The caller presents these exact target names before supplying reaffirmation.
    func continueStopped(_ id: UUID, reaffirmingChannelIDs: Set<Int> = []) async {
        do {
            if try reaffirmContinuation(id, channelIDs: reaffirmingChannelIDs) { await advance(id) }
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

    /// Reopening the app can reconcile retained remote facts without restarting
    /// any mutation. The persisted fence survives another suspension or crash.
    private func inspectRetained(_ id: UUID, minimumInterval: TimeInterval = 0) async {
        do {
            if try prepareRetainedInspection(id, minimumInterval: minimumInterval) { await advance(id) }
        } catch { changed?() }
    }

    /// Receipt discovery needs no new user command. Keep both modern and legacy
    /// mutation fences while checking a stopped create whose response was lost.
    func prepareRetainedInspection(_ id: UUID, minimumInterval: TimeInterval = 0, now: Date = Date()) throws -> Bool {
        var accepted = false
        try store.transaction {
            guard try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: id.uuidString) == nil,
                  var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  job.canceledAt == nil, job.stage == .attention, job.transferID == nil,
                  job.draft.blockID != nil || (job.stopRequestedAt != nil && (job.draft.phase == .uncertain || job.resumeStage == .reconcile)),
                  now.timeIntervalSince(job.lastReadOnlyReconciliationAt ?? .distantPast) >= minimumInterval else { return }
            job.readOnlyReconciliation = true; job.lastReadOnlyReconciliationAt = now
            // Older readers understand Stop even if they ignore the newer field.
            job.stopRequestedAt = job.stopRequestedAt ?? now
            job.stage = job.draft.blockID == nil ? .reconcile : (job.contentVerified == true ? .connections : .read)
            job.page = 1; job.scanningConnected = nil; job.problem = nil; job.notBefore = nil
            _ = try save(job); accepted = true
        }
        return accepted
    }

    /// Read-only reconciliation is the only work permitted after Stop.
    private func settleStop(_ job: inout DeliveryJob) {
        guard job.writesAreFenced, job.transferID == nil, job.stage != .done else { return }
        if job.stage.permitsStoppedRead { return }
        if job.stage == .provenanceWrite {
            job.resumeStage = .provenanceRead; job.stage = .attention
            job.problem = "The block and selected channels are confirmed. Capture details still need attention."
            return
        }
        if job.draft.blockID != nil {
            if job.stage != .connections { job.stage = .connections; job.page = 1; job.scanningConnected = nil }
            job.problem = "Checking channels before pausing."
            return
        }
        if job.draft.phase == .uncertain {
            job.stage = .reconcile; job.page = 1
            job.problem = "Checking the save before pausing."
            return
        }
        if job.stage == .create, job.attemptedChannelIDs?.isEmpty == false {
            job.stage = .reconcile; job.page = 1; job.draft.phase = .uncertain
            job.problem = "Checking the save before pausing."
            return
        }
        if job.stage != .attention { job.resumeStage = job.stage }
        job.stage = .attention
        job.problem = job.draft.phase == .uncertain
            ? "The earlier save is unconfirmed. Check its status before continuing."
            : "No block was created."
        if let interruption = job.interruption { job.problem = interruption.message + " " + (job.problem ?? "") }
        if let outcome = job.lastTransferOutcome, outcome.errorCode != NSURLErrorCancelled,
           let reason = outcome.redactedReason { job.problem = (job.problem ?? "") + " " + reason }
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
        transport.onResult = { transferID in await self.resumeCompleted(transferID: transferID) }
        transport.onProgress = { progress in try? await self.recordProgress(progress) }
        transport.onInvalidated = { [weak self] in await self?.releaseSession(identifier) }
        transports[identifier] = transport
        return transport
    }

    private struct TransferOwner: Codable {
        var captureID: UUID
        var receiptID: UUID
    }
    private struct PendingTransfer: Decodable { var id: UUID; var transferID: String? }

    /// Compact observations are independent of frozen source payloads. The exact
    /// admitted transfer and receipt fence all late/reordered delegate callbacks.
    func recordProgress(_ observation: CaptureTransferProgress) throws {
        var owner = try store.value(TransferOwner.self, account: 0, kind: "deliveryTransfer", id: observation.transferID)
        if owner == nil {
            for raw in try store.recordIDs(account: 0, kind: "delivery") {
                if let job = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: raw), job.transferID == observation.transferID {
                    owner = .init(captureID: job.id, receiptID: job.receiptID ?? job.id); break
                }
            }
        }
        guard let owner, let job = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: owner.captureID.uuidString),
              job.transferID == observation.transferID, (job.receiptID ?? job.id) == owner.receiptID, job.canceledAt == nil else { return }
        let previous = try store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: observation.transferID)
        guard previous == nil || observation.observedAt >= previous!.observedAt else { return }
        guard previous == nil || observation.completedBytes >= previous!.completedBytes else { return }
        guard previous?.completedBytes != observation.completedBytes || previous?.expectedBytes != observation.expectedBytes
                || previous?.waitingForConnectivity != observation.waitingForConnectivity else { return }
        var progress = observation; progress.stage = job.stage
        try store.save(progress, account: 0, kind: "deliveryProgress", id: observation.transferID)
        scheduleStallDisplay(progress, operationID: job.id, receiptID: owner.receiptID)
        if let progressChanged { progressChanged() } else { changed?() }
    }

    /// A single display refresh can reveal a real stall. It never advances work
    /// units, writes a progress fact, schedules recovery, or sends a request.
    private func scheduleStallDisplay(_ progress: CaptureTransferProgress, operationID: UUID, receiptID: UUID) {
        progressStallTasks.removeValue(forKey: progress.transferID)?.cancel()
        guard progress.stage == .upload, (progress.fraction ?? 0) < 1 else { return }
        let delay = max(0, 30 - Date().timeIntervalSince(progress.observedAt))
        progressStallTasks[progress.transferID] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self,
                  let current = try? self.store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: operationID.uuidString),
                  current.transferID == progress.transferID, (current.receiptID ?? current.id) == receiptID,
                  current.stage == .upload, current.stopRequestedAt == nil, current.canceledAt == nil,
                  let latest = try? self.store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: progress.transferID),
                  latest.observedAt == progress.observedAt else { return }
            self.progressStallTasks.removeValue(forKey: progress.transferID)
            if let progressChanged = self.progressChanged { progressChanged() } else { self.changed?() }
        }
    }

    private func resumeCompleted(transferID: String) async {
        do {
            if let owner = try store.value(TransferOwner.self, account: 0, kind: "deliveryTransfer", id: transferID) {
                if let result = try transport(ownIdentifier).result(transferID),
                   try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: owner.captureID.uuidString)?.transferID == transferID {
                    _ = try accept(result, id: owner.captureID, transferID: transferID)
                    try transport(ownIdentifier).removeResult(transferID)
                } else { await advance(owner.captureID) }
                changed?(); return
            }
            // Older queued requests have no transfer index. Decode only their
            // tiny identity before loading the one matching executable journal.
            for id in try store.recordIDs(account: 0, kind: "delivery") {
                guard let job = try store.value(PendingTransfer.self, account: 0, kind: "delivery", id: id), job.transferID == transferID else { continue }
                await advance(job.id); changed?(); return
            }
            for id in try store.recordIDs(account: 0, kind: "canceledDelivery") {
                guard let job = try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: id), job.transferID == transferID,
                      let result = try transport(ownIdentifier).result(transferID) else { continue }
                _ = try accept(result, id: job.id, transferID: transferID)
                try transport(ownIdentifier).removeResult(transferID)
                break
            }
        } catch { }
        changed?()
    }

    func accept(_ result: BackgroundHTTPResult, id: UUID, transferID: String) throws -> DeliveryJob? {
        progressStallTasks.removeValue(forKey: transferID)?.cancel()
        var accepted: DeliveryJob?
        try store.transaction {
            guard var current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString), current.transferID == transferID else {
                guard var canceled = try store.value(DeliveryJob.self, account: 0, kind: "canceledDelivery", id: id.uuidString),
                      canceled.canceledAt != nil, canceled.transferID == transferID else { return }
                try retainOutcome(result, job: &canceled, transferID: transferID, stage: canceled.canceledTransferStage ?? canceled.resumeStage ?? canceled.stage)
                consumeCanceled(result, job: &canceled)
                canceled.transferID = nil; canceled.transferSession = nil; canceled.transferStarted = nil
                canceled.revision = (canceled.revision ?? 0) + 1
                updateCanceledDraft(&canceled)
                try updateCanceledPublication(canceled)
                if try store.value(CaptureDraft.self, account: canceled.draft.accountID, kind: "draft", id: id.uuidString) != nil {
                    try store.save(canceled.draft, account: canceled.draft.accountID, kind: "draft", id: id.uuidString)
                } else if let deleted = try store.value(DeletedCapture.self, account: canceled.draft.accountID, kind: "deletedDraft", id: id.uuidString) {
                    try store.save(DeletedCapture(draft: canceled.draft, deletedAt: deleted.deletedAt), account: canceled.draft.accountID, kind: "deletedDraft", id: id.uuidString)
                }
                try store.save(canceled, account: 0, kind: "canceledDelivery", id: id.uuidString)
                try store.remove(account: 0, kind: "deliveryTransfer", id: transferID)
                accepted = canceled
                return
            }
            try retainOutcome(result, job: &current, transferID: transferID, stage: current.stage)
            consume(result, job: &current)
            current.transferID = nil; current.transferSession = nil; current.transferStarted = nil
            if current.writesAreFenced, current.stage != .attention { settleStop(&current) }
            accepted = try save(current)
            try store.remove(account: 0, kind: "deliveryTransfer", id: transferID)
        }
        return accepted
    }

    private func retainOutcome(_ result: BackgroundHTTPResult, job: inout DeliveryJob, transferID: String, stage: DeliveryJob.Stage, responseMissing: Bool = false) throws {
        if stage == .update { job.initialFieldsAttemptedAt = job.initialFieldsAttemptedAt ?? job.transferStarted ?? Date() }
        var outcome = CaptureTransferOutcome(transferID: transferID, stage: stage, result: result)
        outcome.operationID = job.id; outcome.receiptID = job.receiptID ?? job.id
        outcome.startedAt = job.transferStarted
        if responseMissing { outcome.responseMissing = true; outcome.redactedReason = "The transfer result could not be recovered." }
        job.lastTransferProgress = try store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: transferID)
        outcome.progress = job.lastTransferProgress
        job.lastTransferOutcome = outcome
        try store.save(outcome, account: job.draft.accountID, kind: "deliveryAttempt", id: transferID)
    }

    private func consumeCanceled(_ result: BackgroundHTTPResult, job: inout DeliveryJob) {
        job.canceledTransferResult = result
        guard result.error == nil, let status = result.status, (200..<300).contains(status) else { return }
        let json = result.json
        switch job.canceledTransferStage {
        case .create:
            if let id = json?["id"]?.int, id > 0 { job.draft.blockID = id; job.block = json }
        case .read, .verify:
            if let id = job.draft.blockID, json?["id"]?.int == id { job.block = json }
        case .connections:
            guard let rows = json?["data"]?.array, json?["meta"]?["has_more_pages"] == .bool(false),
                  rows.allSatisfy({ ($0["id"]?.int ?? 0) > 0 }) else { return }
            let observed = (job.scanningConnected ?? []).union(rows.compactMap { $0["id"]?.int })
            job.confirmedOnceChannelIDs = (job.confirmedOnceChannelIDs ?? []).union(job.connected).union(observed)
            job.connected = observed; job.scanningConnected = nil
        default: break
        }
    }

    private func advance(_ id: UUID) async {
        guard (try? store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: id.uuidString)) == nil else { return }
        // A continued task with no live owner may have been cancelled by the
        // system without a callback. Keep its journal until a handler claims it
        // or a foreground launch durably pauses it.
        if let held = try? store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString),
           held.continuedRequestedAt != nil, held.stopRequestedAt == nil, activeContinued[id] != (held.receiptID ?? held.id) { return }
        guard running.insert(id).inserted else { return }
        defer {
            running.remove(id); changed?(); retireIfIdle()
            if needsAdvance.remove(id) != nil { Task { await self.advance(id) } }
        }
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
                        if let recovered = try recoverStaleForeignRead(id, transferID: transferID, receiptID: job.receiptID ?? job.id, sessionIdentifier: owner.identifier) {
                            // A read has no remote effects to undo. Durably fence
                            // its old identity before permitting a replacement GET.
                            task.cancel(); job = recovered
                        } else {
                            let current = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString)
                            let stopping = current == nil || current?.shouldCancelTransferOnStop == true
                            if stopping { task.cancel() }
                            else if task.state == .suspended { task.resume() }
                            if owner.identifier != ownIdentifier, job.stage.permitsStoppedRead, let started = job.transferStarted {
                                scheduleAdvance(id, after: max(1, 31 - Date().timeIntervalSince(started)))
                            }
                            return
                        }
                    } else {
                        let remaining = 30 - Date().timeIntervalSince(job.transferStarted ?? .distantPast)
                        if remaining > 0 {
                            scheduleAdvance(id, after: remaining + 1)
                            return
                        }
                        guard let recovered = try recoverMissingTransfer(id, transferID: transferID) else { return }
                        job = recovered
                    }
                }
            }
            guard ![.done, .attention].contains(job.stage) else { return }
            if job.writesAreFenced && !job.stage.permitsStoppedRead {
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
                job.resumeStage = job.stage; job.stage = .attention; job.problem = "Reconnect Are.na to finish saving."
                job = try save(job); return
            }
            if preparePlacementValidation(&job) { job = try save(job) }
            if [.create, .connect, .provenanceWrite].contains(job.stage) {
                let api = ArenaAPI(token: token)
                let account = try await api.me()
                guard account.id == job.draft.accountID else { throw CaptureError.message("Reconnect the account used for this save.") }
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
            guard let reserved = try reserveTransfer(job, transferID: transferID) else {
                if operation.body != nil, let file { try? FileManager.default.removeItem(at: file) }
                return
            }
            job = reserved
            let task = try transport(ownIdentifier).submit(id: transferID, request: operation.request, file: file, notBefore: job.notBefore)
            let admitted = try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString)
            let stopping = admitted?.shouldCancelTransferOnStop == true
            if admitted?.transferID != transferID || admitted?.receiptID != job.receiptID || stopping { task.cancel() }
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

    private func scheduleAdvance(_ id: UUID, after delay: TimeInterval) {
        recoveryTasks[id]?.cancel()
        recoveryTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.advance(id)
        }
    }

    /// A retained foreign GET can be replaced after the previous session lock
    /// has been acquired. Never apply elapsed-time replay to a mutation.
    func recoverStaleForeignRead(_ id: UUID, transferID: String, receiptID: UUID, sessionIdentifier: String, now: Date = Date()) throws -> DeliveryJob? {
        guard sessionIdentifier != ownIdentifier, sessionLocks[sessionIdentifier] != nil else { return nil }
        var recovered: DeliveryJob?
        try store.transaction {
            guard try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: id.uuidString) == nil,
                  let current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString),
                  current.canceledAt == nil, current.transferID == transferID, current.transferSession == sessionIdentifier,
                  (current.receiptID ?? current.id) == receiptID, current.stage.permitsStoppedRead,
                  let started = current.transferStarted, now.timeIntervalSince(started) > 30 else { return }
            recovered = try recoverMissingTransfer(id, transferID: transferID)
        }
        return recovered
    }

    /// Losing the task and its response does not prove that a write failed.
    /// Retain its known identity and read back before any further mutation.
    func recoverMissingTransfer(_ id: UUID, transferID: String) throws -> DeliveryJob? {
        var recovered: DeliveryJob?
        try store.transaction {
            guard var current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString), current.transferID == transferID else { return }
            try retainOutcome(.init(status: nil, body: Data(), error: nil, retryAfter: nil), job: &current, transferID: transferID, stage: current.stage, responseMissing: true)
            if current.stage == .create { current.stage = .reconcile; current.draft.phase = .uncertain }
            else if current.stage == .connect {
                current.stage = .connections; current.page = 1; current.scanningConnected = nil
                current.connectionAttempts = (current.connectionAttempts ?? 0) + 1
            } else if current.stage == .update { current.stage = .verify }
            else if current.stage == .provenanceWrite { current.stage = .provenanceRead }
            current.transferID = nil; current.transferSession = nil; current.transferStarted = nil
            if current.writesAreFenced { settleStop(&current) }
            recovered = try save(current)
            try store.remove(account: 0, kind: "deliveryTransfer", id: transferID)
        }
        return recovered
    }

    /// Reserve identity, target and revision before URLSession can transmit the request.
    func reserveTransfer(_ source: DeliveryJob, transferID: String) throws -> DeliveryJob? {
        var reserved: DeliveryJob?
        try store.transaction {
            guard try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: source.id.uuidString) == nil else { return }
            guard let current = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: source.id.uuidString), current.transferID == nil,
                  current.stage == source.stage, current.revision == source.revision else { return }
            guard !current.writesAreFenced || current.stage.permitsStoppedRead else { return }
            guard source.stage != .connect || source.requiredChannels.contains(where: { !source.connected.contains($0.id) }) else { return }
            var job = source
            if job.stage == .update {
                if job.reconciledCreate == true {
                    guard let observed = current.block, try recoveredCreateNeedsUpdate(current, block: observed) else { return }
                }
                job.initialFieldsAttemptedAt = job.initialFieldsAttemptedAt ?? Date()
            }
            if job.stage == .connect, job.attemptedChannelIDs == nil {
                let missing = Set(job.requiredChannels.map(\.id)).subtracting(job.connected)
                guard missing.isSubset(of: job.reaffirmedChannelIDs ?? []) else { throw CaptureError.message("An earlier channel addition is unconfirmed. Check this save before continuing.") }
                job.attemptedChannelIDs = Array(Set(job.draft.selection.channels.map(\.id))).sorted()
            }
            if job.attemptedChannelIDs != nil, [.create, .connect].contains(job.stage),
               let target = job.stage == .create ? job.draft.selection.channels.first?.id : job.requiredChannels.first(where: { !job.connected.contains($0.id) })?.id {
                if job.stage == .connect, job.attemptedChannelIDs?.contains(target) == true {
                    let explicitAddition = job.explicitlyAddedChannelIDs?.contains(target) == true
                    guard job.reaffirmedChannelIDs?.contains(target) == true || explicitAddition,
                          !(job.confirmedOnceChannelIDs ?? []).contains(target) || explicitAddition,
                          (job.connectionRetryCounts?[target] ?? 0) < 3 else { throw CaptureError.message("An earlier channel addition is unconfirmed. Check this save before continuing.") }
                    job.reaffirmedChannelIDs?.remove(target)
                    var retries = job.connectionRetryCounts ?? [:]; retries[target, default: 0] += 1
                    job.connectionRetryCounts = retries
                }
                // Consent covers one dispatch, including a first attempt of a
                // previously unsent target. A lost reply needs new reaffirmation.
                job.reaffirmedChannelIDs?.remove(target)
                job.explicitlyAddedChannelIDs?.remove(target)
                if job.attemptedChannelIDs?.contains(target) != true { job.attemptedChannelIDs?.append(target) }
            }
            job.transferID = transferID; job.transferSession = ownIdentifier; job.transferStarted = Date()
            job.lastTransferProgress = nil
            reserved = try save(job)
            try store.save(TransferOwner(captureID: job.id, receiptID: job.receiptID ?? job.id), account: 0, kind: "deliveryTransfer", id: transferID)
        }
        return reserved
    }

    /// A retained target makes a late permission response independent of an
    /// amended selection's order. No connection request precedes this read.
    @discardableResult func preparePlacementValidation(_ job: inout DeliveryJob) -> Bool {
        guard job.stage == .connect else { return false }
        guard let target = job.requiredChannels.first(where: { !job.connected.contains($0.id) }) else {
            // Cancelling the final unsent choice needs a readback, never an
            // empty POST or a claim of completion from an old observation.
            job.placementValidationID = nil; job.stage = .connections
            job.page = 1; job.scanningConnected = nil
            return true
        }
        guard job.validatedChannelIDs?.contains(target.id) != true else { return false }
        job.placementValidationID = target.id; job.stage = .destinations
        return true
    }

    func request(_ job: DeliveryJob, token: String) throws -> (request: URLRequest, body: Data?, file: URL?) {
        guard job.canceledAt == nil else { throw CaptureError.message("This save was canceled.") }
        if job.draft.isPlacementOnly, [.presign, .upload, .create, .update].contains(job.stage) {
            throw CaptureError.message("Edit the saved block in Are.na.")
        }
        let base = "https://api.are.na/v3/"
        var address: String
        var method = "GET"
        var body: JSONValue?
        var file: URL?
        switch job.stage {
        case .destinations:
            address = base + "channels/\(job.placementValidationID ?? job.draft.selection.channels[job.destinationIndex ?? 0].id)"
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
            let missing = job.requiredChannels.map(\.id).filter { !job.connected.contains($0) }
            let targets = Array(missing.prefix(job.attemptedChannelIDs == nil ? 20 : 1))
            guard !targets.isEmpty else { throw CaptureError.message("Check this capture's channels before continuing.") }
            var fields: [String: JSONValue] = ["connectable_id": .number(Double(job.draft.blockID!)), "connectable_type": .string("Block"), "channel_ids": .array(targets.map { .number(Double($0)) })]
            if let provenance = job.provenance, targets.first == provenance.channelID, job.attemptedChannelIDs != nil {
                fields.removeValue(forKey: "channel_ids")
                fields["channels"] = .array([.object(["id": .number(Double(provenance.channelID)), "metadata": .object(provenance.metadata)])])
            }
            body = .object(fields)
        case .reconcile: address = base + "users/\(job.draft.accountID)/contents?type=Block&sort=created_at_desc&per=100&page=\(job.page)"
        case .provenanceContents:
            guard let provenance = job.provenance else { throw CaptureError.message("The channel for capture details is unavailable.") }
            guard (1...Self.provenancePageLimit).contains(job.page) else { throw CaptureError.message("Couldn't confirm the default-channel save. Open the block in Are.na.") }
            address = base + "channels/\(provenance.channelID)/contents?per=100&page=\(job.page)&sort=position_desc"
        case .provenanceRead, .provenanceVerify:
            guard let connectionID = job.provenanceConnectionID else { throw CaptureError.message("The default-channel save is unconfirmed.") }
            address = base + "connections/\(connectionID)"
        case .provenanceWrite:
            guard let connectionID = job.provenanceConnectionID, let patch = job.provenancePatch else { throw CaptureError.message("The capture details are unavailable.") }
            address = base + "connections/\(connectionID)"; method = "PUT"; body = .object(["metadata": .object(patch)])
        case .queued, .reading, .rendering, .done, .attention: throw CaptureError.message("This capture has no pending transfer.")
        }
        guard let url = URL(string: address), url.scheme == "https", url.user == nil, url.password == nil else { throw CaptureError.message("The upload address is invalid.") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue(job.stage == .upload ? job.mediaType! : "application/json", forHTTPHeaderField: "Content-Type")
        if job.stage != .upload { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return (request, try body.map { try JSONEncoder().encode($0) }, file)
    }

    /// Recovered creates may finish only unchanged generated initial fields.
    /// Matching final fields need no PUT; an already admitted PUT is read-only
    /// thereafter, regardless of whether a placeholder later reappears.
    private func recoveredCreateNeedsUpdate(_ job: DeliveryJob, block: JSONValue) throws -> Bool {
        let actors = [block["user"]?["id"]?.int, block["owner"]?["id"]?.int].compactMap { $0 }
        guard let blockID = job.draft.blockID, block["id"]?.int == blockID, !actors.isEmpty,
              actors.allSatisfy({ $0 == job.draft.accountID }),
              block["metadata"]?["arena_capture_id"]?.string == job.id.uuidString else {
            throw CaptureError.message("Couldn't verify the recovered block's identity. Its content has not been changed.")
        }
        let hash = job.prepared.payload["metadata"]?["arena_block_plan"]?.string
        if let hash, block["metadata"]?["arena_block_plan"] != .string(hash) {
            throw CaptureError.message("The recovered block's capture details differ. Its content has not been changed.")
        }
        let generatedHash: String? = hash.flatMap { $0.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) == nil ? nil : $0 }
        var needsUpdate = false
        for (key, expected) in job.prepared.update {
            let actual = block[key]?["markdown"] ?? block[key]
            if actual == expected || (expected == .string("") && (actual == nil || actual == .null))
                || (expected == .null && actual == nil) { continue }
            var initial: JSONValue?
            if let generatedHash, block["metadata"]?["arena_block_plan"] == .string(generatedHash) {
                if key == "description", job.prepared.payload[key] == .string("arena-block description \(generatedHash)") { initial = job.prepared.payload[key] }
                if key == "content", job.prepared.payload["value"] == .string("arena-block text \(generatedHash)") { initial = job.prepared.payload["value"] }
            }
            guard let initial, actual == initial else {
                throw CaptureError.message("The saved \(key) differs from this capture. Its content has been left unchanged in Are.na.")
            }
            needsUpdate = true
        }
        guard !needsUpdate || job.initialFieldsAttemptedAt == nil else {
            throw CaptureError.message("An earlier content update is unconfirmed. The block has been left unchanged in Are.na.")
        }
        return needsUpdate
    }

    func consume(_ result: BackgroundHTTPResult, job: inout DeliveryJob) {
        if job.stage == .destinations, let target = job.placementValidationID,
           !job.requiredChannels.contains(where: { $0.id == target }) {
            // A permission read for a locally cancelled, unsent choice has no
            // bearing on the remaining destinations, even if its read failed.
            job.placementValidationID = nil; job.stage = .connect
            job.attempts = 0; job.notBefore = nil; job.problem = nil
            return
        }
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
                job.problem = "Checking the earlier save."
            } else if job.stage == .update, result.error != nil || result.status == nil || result.status == 408 || (result.status ?? 0) >= 500 {
                // An uncertain PUT may already have succeeded. Read the block
                // before deciding anything further; never overwrite a later edit.
                job.stage = .verify
                job.problem = "Checking the earlier update."
            } else if job.stage == .upload && result.status == 403 {
                let outcome = CaptureTransferOutcome(transferID: job.transferID ?? "unreserved", stage: .upload, result: result)
                if outcome.authorizationExpired, (job.uploadAuthorizationRenewals ?? 0) < 2 {
                    job.uploadAuthorizationRenewals = (job.uploadAuthorizationRenewals ?? 0) + 1
                    job.stage = .presign
                } else { fail(&job, outcome.redactedReason ?? "The media upload was rejected (HTTP 403).") }
            }
            else if result.status == 429 || result.status == nil || (result.status ?? 0) >= 500 {
                if job.attempts < 8 { job.notBefore = result.retryAfter ?? Date().addingTimeInterval(min(900, pow(2, Double(job.attempts)) * 5)) }
                else { job.resumeStage = job.stage; job.stage = .attention; job.problem = "Connection failed. Saving is paused." }
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
            if let target = job.placementValidationID {
                guard json?["id"]?.int == target, json?["can"]?["add_to"] == .bool(true) else {
                    fail(&job, "You can no longer add to a selected channel. Review this save's channels."); return
                }
                job.validatedChannelIDs = (job.validatedChannelIDs ?? []).union([target])
                job.placementValidationID = nil; job.stage = .connect
                return
            }
            guard json?["can"]?["add_to"] == .bool(true) else { fail(&job, "You can no longer add to a selected channel. Review this save in History."); return }
            if let provenance = job.provenance, job.draft.selection.channels[job.destinationIndex ?? 0].id == provenance.channelID,
               (json?["id"]?.int != provenance.channelID || json?["owner"]?["id"]?.int != job.draft.accountID || json?["owner"]?["type"]?.string != "User" || json?["visibility"]?.string != "private") {
                fail(&job, "Couldn't confirm your private default channel. Review this save in History.")
                return
            }
            job.validatedChannelIDs = (job.validatedChannelIDs ?? []).union([job.draft.selection.channels[job.destinationIndex ?? 0].id])
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
        case .upload: job.mediaUploadCompletedAt = Date(); job.stage = .create
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
            if job.writesAreFenced && !job.draft.isPlacementOnly {
                job.stage = .verify
            } else if job.draft.isPlacementOnly {
                job.contentVerified = true; job.stage = .connections; job.page = 1; job.scanningConnected = nil
            } else if job.reuseExisting == true || job.prepared.update.isEmpty { job.stage = .verify }
            else if job.reconciledCreate == true {
                do {
                    guard let observed = job.block else { throw CaptureError.message("The recovered block could not be read.") }
                    job.stage = try recoveredCreateNeedsUpdate(job, block: observed) ? .update : .verify
                }
                catch { fail(&job, error.localizedDescription) }
            } else { job.stage = .update }
        case .update: job.stage = .verify
        case .verify:
            guard let block = json else { fail(&job, "The saved block could not be read."); return }
            if let plan = job.draft.previewSnapshot?.plan {
                do {
                    let runtime = try CaptureRuntime()
                    try runtime.verify(planJSON: String(decoding: JSONEncoder().encode(plan), as: UTF8.self), blockJSON: String(decoding: JSONEncoder().encode(block), as: UTF8.self))
                    if ["link", "image"].contains(plan["block"]?["kind"]?.string ?? ""),
                       try runtime.copiedCover(blockJSON: String(decoding: JSONEncoder().encode(block), as: UTF8.self)).isEmpty {
                        fail(&job, "The saved cover image is missing. Open the block in Are.na."); return
                    }
                } catch { fail(&job, error.localizedDescription); return }
            }
            for (key, expected) in job.prepared.update where expected != .null {
                let actual = block[key]?["markdown"] ?? block[key]
                guard actual == expected || (expected == .string("") && (actual == nil || actual == .null)) else { fail(&job, "The saved \(key) differs from your capture. Open the block in Are.na."); return }
            }
            job.block = block; job.contentVerified = true; job.stage = .connections; job.page = 1; job.scanningConnected = nil
        case .connections:
            guard let data = json?["data"], case .array(let rows) = data,
                  let pagination = json?["meta"]?["has_more_pages"], case .bool(let hasMore) = pagination,
                  rows.allSatisfy({ ($0["id"]?.int ?? 0) > 0 }) else {
                fail(&job, "Couldn't check every channel. Review the block's channels in Are.na."); return
            }
            job.scanningConnected = (job.scanningConnected ?? []).union(rows.compactMap { $0["id"]?.int })
            if hasMore {
                guard let page = json?["meta"]?["next_page"]?.int, page > job.page else {
                    fail(&job, "Couldn't check every channel. Review the block's channels in Are.na."); return
                }
                job.page = page; return
            }
            job.confirmedOnceChannelIDs = (job.confirmedOnceChannelIDs ?? []).union(job.connected).union(job.scanningConnected ?? [])
            job.connected = job.scanningConnected ?? []
            job.scanningConnected = nil
            if let required = job.requiredChannelIDs {
                // A connection removed outside Capture is not silently recreated
                // by a later additive placement cycle. The old receipt is retained.
                var current = DestinationSelection(defaultChannel: nil)
                for channel in job.draft.selection.channels where required.contains(channel.id) || job.connected.contains(channel.id) { current.toggle(channel, maxCount: Int.max) }
                job.draft.selection = current
            }
            let missing = job.requiredChannels.map(\.id).filter { !job.connected.contains($0) }
            if job.writesAreFenced {
                if job.contentVerified != true { job.stage = .read; return }
                if missing.isEmpty {
                    job.stage = job.provenance == nil ? .done : (job.provenanceConnectionID == nil ? .provenanceContents : .provenanceRead)
                    job.page = 1
                    return
                }
                job.stage = .attention
                job.problem = job.connected.isEmpty
                    ? "The block exists. Check its channels in Are.na before continuing."
                    : "Continue uses the same block."
                return
            }
            if !Set(missing).subtracting(job.explicitlyAddedChannelIDs ?? []).isDisjoint(with: job.confirmedOnceChannelIDs ?? []) {
                fail(&job, "A previously confirmed connection is no longer present. It has been left removed in Are.na.")
                return
            }
            if job.attemptedChannelIDs != nil, let provenance = job.provenance,
               job.connected.contains(provenance.channelID), job.firstProvenanceVerified != true {
                job.verifyingFirstProvenance = true; job.stage = .provenanceContents; job.page = 1
            } else if missing.isEmpty {
                job.stage = job.provenance == nil ? .done : .provenanceContents; job.page = 1
            } else if let attempted = job.attemptedChannelIDs {
                if attempted.contains(missing[0]) && job.reaffirmedChannelIDs?.contains(missing[0]) != true && job.explicitlyAddedChannelIDs?.contains(missing[0]) != true { fail(&job, "An earlier channel addition is unconfirmed. Check the block's channels in Are.na before continuing.") }
                else { job.connectionAttempts = 0; job.stage = .connect }
            } else if Set(missing).isSubset(of: job.reaffirmedChannelIDs ?? []), (job.connectionAttempts ?? 0) < 3 { job.stage = .connect }
            else { fail(&job, "Some channels are unconfirmed. Check the block's channels in Are.na.") }
        case .connect:
            job.connectionAttempts = (job.connectionAttempts ?? 0) + 1
            job.stage = .connections; job.page = 1; job.scanningConnected = nil
        case .reconcile:
            // Restarting at page one must discard a candidate from an interrupted scan.
            if job.page == 1 { job.reconcileCandidateID = nil; job.reconcileWindow = .init() }
            guard let data = json?["data"], case .array(let rows) = data,
                  rows.count <= 100,
                  let pagination = json?["meta"]?["has_more_pages"], case .bool(let hasMore) = pagination,
                  json?["meta"]?["current_page"] == nil || json?["meta"]?["current_page"]?.int == job.page,
                  !hasMore || (!rows.isEmpty && json?["meta"]?["next_page"]?.int == job.page + 1) else {
                fail(&job, "Couldn't confirm this save. Check your channels in Are.na before saving again.")
                job.draft.phase = .uncertain; return
            }
            // Legacy scans resumed mid-page have no proof of the earlier
            // ordering. They must restart at page one before accepting a match.
            var window = job.reconcileWindow ?? .init(descendingPages: false)
            let standard = ISO8601DateFormatter()
            let fractional = ISO8601DateFormatter(); fractional.formatOptions.insert(.withFractionalSeconds)
            var dates: [Date] = []
            for row in rows {
                let created = row["created_at"]?.string.flatMap { standard.date(from: $0) ?? fractional.date(from: $0) }
                if let created { dates.append(created) } else { window.descendingPages = false }
                if (row["id"]?.int ?? 0) <= 0 { window.descendingPages = false }
                guard row["metadata"]?["arena_capture_id"]?.string == job.id.uuidString else { continue }
                guard let id = row["id"]?.int, id > 0,
                      job.reconcileCandidateID == nil || job.reconcileCandidateID == id else {
                    fail(&job, "Multiple blocks match this capture. Check your channels in Are.na before continuing.")
                    job.draft.phase = .uncertain; return
                }
                job.reconcileCandidateID = id
                window.candidateCreatedAt = created
                let actors = [row["user"]?["id"]?.int, row["owner"]?["id"]?.int].compactMap { $0 }
                window.candidateAccountID = !actors.isEmpty && actors.allSatisfy({ $0 == job.draft.accountID }) ? job.draft.accountID : nil
            }
            // The API ranks descending pages but hydrates each page in an
            // arbitrary row order. Validate whole page ranges, not row order.
            let previousMinimum = window.previousPageMinimum
            let pageMaximum = dates.max(), pageMinimum = dates.min()
            if let previousMinimum, let pageMaximum, pageMaximum > previousMinimum { window.descendingPages = false }
            window.previousPageMinimum = pageMinimum
            job.reconcileWindow = window
            let lowerBound = job.createdAt.addingTimeInterval(-Self.createReadbackClockSkew)
            // Require a wholly older sentinel page after a validated page.
            // Equal timestamps across a page edge need another strictly older
            // page, so a boundary tie cannot truncate the causal window.
            let causalWindowComplete: Bool
            if let previousMinimum, let pageMaximum {
                causalWindowComplete = window.descendingPages && pageMaximum < lowerBound && pageMaximum < previousMinimum
            } else { causalWindowComplete = false }
            let candidateInsideWindow = window.candidateAccountID == job.draft.accountID && window.candidateCreatedAt.map { $0 >= lowerBound } == true
            if hasMore && !(causalWindowComplete && candidateInsideWindow) {
                guard job.page < 10, let page = json?["meta"]?["next_page"]?.int else {
                    fail(&job, "Couldn't confirm this save. Check your channels in Are.na before saving again.")
                    job.draft.phase = .uncertain; return
                }
                job.page = page
            } else if let id = job.reconcileCandidateID, window.descendingPages, candidateInsideWindow {
                job.draft.blockID = id; job.reconcileCandidateID = nil; job.reconcileWindow = nil
                job.reconciledCreate = true; job.stage = .read
            } else {
                fail(&job, "Couldn't confirm this save. Check your channels in Are.na before saving again.")
                job.draft.phase = .uncertain
            }
        case .provenanceContents:
            guard let data = json?["data"], case .array(let rows) = data, rows.count <= 100 else {
                fail(&job, "Couldn't confirm the default-channel save. Open the block in Are.na."); return
            }
            let matches = rows.filter { $0["id"]?.int == job.draft.blockID && $0["type"]?.string != "Channel" }
            guard matches.count <= 1 else { fail(&job, "Couldn't confirm this block in the default channel. Capture details were not changed."); return }
            if let match = matches.first {
                guard let connectionID = match["connection"]?["id"]?.int, connectionID > 0,
                      job.provenanceConnectionID == nil || job.provenanceConnectionID == connectionID else {
                    fail(&job, "Couldn't confirm this block in the default channel. Capture details were not changed."); return
                }
                job.provenanceConnectionID = connectionID
                // A placement is unique within its channel. Once this row identifies
                // the connection, verify that connection directly; the rest of a
                // large Inbox cannot change the identity of this placement.
                job.stage = .provenanceRead
                return
            }
            if json?["meta"]?["has_more_pages"] == .bool(true) {
                guard job.page < Self.provenancePageLimit, let page = json?["meta"]?["next_page"]?.int, page == job.page + 1 else {
                    fail(&job, "Couldn't confirm the default-channel save. Open the block in Are.na."); return
                }
                job.page = page
            } else { fail(&job, "The default-channel save is unconfirmed. Capture details were not changed.") }
        case .provenanceRead, .provenanceVerify:
            guard let connectionID = job.provenanceConnectionID, json?["id"]?.int == connectionID,
                  json?["connected_by"]?["id"]?.int == job.draft.accountID, let provenance = job.provenance else {
                fail(&job, "Couldn't verify this block in the default channel. Capture details are unconfirmed."); return
            }
            let current = json?["metadata"]?.object ?? [:]
            if job.verifyingFirstProvenance == true {
                if job.attemptedChannelIDs?.contains(provenance.channelID) == true,
                   !provenance.metadata.allSatisfy({ current[$0.key] == $0.value }) {
                    fail(&job, "The default-channel capture details are unconfirmed. Other channels have not been added."); return
                }
                job.verifyingFirstProvenance = false; job.firstProvenanceVerified = true
                job.stage = .connections; job.page = 1; job.scanningConnected = nil; job.connectionAttempts = 0
                return
            }
            if job.stage == .provenanceVerify {
                guard let patch = job.provenancePatch, patch.allSatisfy({ current[$0.key] == $0.value }) else {
                    fail(&job, "Couldn't confirm the capture details. Retry this capture."); return
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
              (try? store.recordIDs(account: 0, kind: "delivery").contains { try store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: $0)?.mediaPath == path }) == false else { return }
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
            let complete = Set(job.requiredChannels.map(\.id)).isSubset(of: job.connected)
            if job.draft.blockID == nil {
                job.resumeStage = .reconcile; job.stage = .attention; job.draft.phase = .uncertain
                job.problem = "Couldn't confirm the block. Check this save before continuing."
            } else if job.contentVerified != true {
                job.stage = .read; job.page = 1
            } else if !complete {
                job.stage = .connections; job.page = 1; job.scanningConnected = nil
            }
        }
        try store.transaction {
            guard try store.value(PendingTransfer.self, account: 0, kind: "canceledDelivery", id: source.id.uuidString) == nil else { throw DeliveryCoordinationError.changed }
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
            if job.stage == .done {
                // Keep every completed operation available for audit while the
                // capture itself remains one row through later placement edits.
                try store.save(job, account: job.draft.accountID, kind: "deliveryReceipt", id: (job.receiptID ?? job.id).uuidString)
                try store.remove(account: 0, kind: "delivery", id: job.id.uuidString)
            }
            else { try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString) }
        }
        return job
    }
}

private enum DeliveryCoordinationError: Error { case changed }
