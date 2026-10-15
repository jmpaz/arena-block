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

    public var hasPendingWork: Bool { canceledAt == nil && ![.done, .attention].contains(stage) }
    public var shouldCancelTransferOnStop: Bool { (stopRequestedAt != nil || readOnlyReconciliation == true || canceledAt != nil) && !stage.permitsStoppedRead }
    public var preparationFailureStage: CaptureDeliveryStage? {
        guard canceledAt == nil, stage == .attention, stopRequestedAt == nil, problem != nil,
              transferID == nil, draft.blockID == nil, draft.phase != .uncertain,
              contentVerified != true, connected.isEmpty, (attemptedChannelIDs ?? []).isEmpty,
              let resumeStage, [.queued, .reading, .rendering].contains(resumeStage) else { return nil }
        return resumeStage
    }
    public var progress: CaptureContinuedProgress {
        let selected = Set(draft.selection.channels.map(\.id))
        var state = draft.deliveryState ?? .init(operationID: id, stage: stage)
        state.receiptID = receiptID ?? id
        state.stage = canceledAt == nil ? stage : .done
        state.confirmedChannelIDs = connected.intersection(selected)
        state.contentVerified = contentVerified == true || (stage == .done && canceledAt == nil)
        state.stopRequested = stopRequestedAt != nil
        state.canceledAt = canceledAt ?? state.canceledAt
        state.notBefore = notBefore
        return .init(state: state, selectedChannelIDs: selected)
    }
}
