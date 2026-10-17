import Foundation

/// Execution and progress metadata only. Decoding this view does not materialize
/// frozen provider records, plans, prepared content, media, or receipt bodies.
public struct CaptureDeliveryProjection: Decodable, Sendable {
    public struct Draft: Decodable, Sendable {
        public var accountID: Int
        public var selection: DestinationSelection
        public var phase: CapturePhase
        public var blockID: Int?
        public var deliveryState: CaptureDeliveryState?
    }
    public var id: UUID
    public var receiptID: UUID?
    public var revision: Int?
    public var stage: CaptureDeliveryStage
    public var draft: Draft
    public var stopRequestedAt: Date?
    public var canceledAt: Date?
    public var continuedRequestedAt: Date?
    public var transferID: String?
    public var transferSession: String?
    public var mediaPath: String?
    public var connected: Set<Int>
    public var contentVerified: Bool?
    public var notBefore: Date?
    public var resumeStage: CaptureDeliveryStage?
    public var problem: String?
    public var attemptedChannelIDs: [Int]?
    public var readOnlyReconciliation: Bool?
    public var lastReadOnlyReconciliationAt: Date?
    public var lastTransferProgress: CaptureTransferProgress?
    public var lastTransferOutcome: CaptureTransferOutcome?
    public var interruption: CaptureInterruption?
    public var mediaUploadCompletedAt: Date?

    public var hasPendingWork: Bool { canceledAt == nil && ![.done, .attention].contains(stage) }
    public var shouldCancelTransferOnStop: Bool { (stopRequestedAt != nil || readOnlyReconciliation == true || canceledAt != nil) && !stage.permitsStoppedRead }
    public var preparationFailureStage: CaptureDeliveryStage? {
        guard canceledAt == nil, stage == .attention, stopRequestedAt == nil, problem != nil,
              transferID == nil, draft.blockID == nil, draft.phase != .uncertain,
              contentVerified != true, connected.isEmpty, (attemptedChannelIDs ?? []).isEmpty,
              let resumeStage, [.queued, .reading, .rendering].contains(resumeStage) else { return nil }
        return resumeStage
    }
    public var progress: CaptureContinuedProgress { progress(observation: nil) }
    public func progress(observation: CaptureTransferProgress?) -> CaptureContinuedProgress {
        let selected = Set(draft.selection.channels.map(\.id))
        var state = draft.deliveryState ?? .init(operationID: id, stage: stage)
        state.receiptID = receiptID ?? id
        state.stage = canceledAt == nil ? stage : .done
        state.confirmedChannelIDs = connected.intersection(selected)
        state.contentVerified = contentVerified == true || (stage == .done && canceledAt == nil)
        state.stopRequested = stopRequestedAt != nil
        state.canceledAt = canceledAt ?? state.canceledAt
        state.notBefore = notBefore
        let effective = stage == .attention ? resumeStage : stage
        state.preparationCompleted = effective.map { ![.queued, .reading, .rendering, .attention].contains($0) } ?? false
        state.mediaUploadRequired = mediaPath != nil
        state.mediaUploadCompleted = mediaUploadCompletedAt != nil || (mediaPath != nil && effective.map { [.create, .read, .update, .verify, .connections, .connect, .provenanceContents, .provenanceRead, .provenanceWrite, .provenanceVerify, .done].contains($0) } == true)
        if let observation, let transferID, observation.transferID == transferID {
            state.transferProgress = observation
        } else { state.transferProgress = lastTransferProgress }
        state.lastTransferOutcome = lastTransferOutcome ?? state.lastTransferOutcome
        state.interruption = interruption ?? state.interruption
        return .init(state: state, selectedChannelIDs: selected)
    }
}
