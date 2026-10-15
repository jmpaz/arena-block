import Foundation

public enum CaptureDeliveryStage: String, Codable, Sendable {
    case queued, reading, rendering, destinations, presign, upload, create, read, update, verify, connections, connect, reconcile, provenanceContents, provenanceRead, provenanceWrite, provenanceVerify, done, attention

    public var permitsStoppedRead: Bool {
        [.read, .verify, .connections, .reconcile, .provenanceContents, .provenanceRead, .provenanceVerify].contains(self)
    }

    public var title: String {
        switch self {
        case .queued: "Queued"
        case .reading: "Reading source"
        case .rendering: "Preparing media"
        case .destinations: "Checking destinations"
        case .presign, .upload: "Uploading media"
        case .create: "Saving to Are.na"
        case .read: "Processing block"
        case .update: "Updating block"
        case .verify: "Checking block"
        case .connections: "Checking channels"
        case .connect: "Adding to channels"
        case .reconcile: "Checking earlier save"
        case .provenanceContents, .provenanceRead, .provenanceVerify: "Finishing save"
        case .provenanceWrite: "Finishing save"
        case .done: "Saved to Are.na"
        case .attention: "Save interrupted"
        }
    }
}

/// A durable observation of one submission, never a lookup by source or plan.
public struct CaptureDeliveryState: Codable, Equatable, Sendable {
    public var operationID: UUID
    public var receiptID: UUID?
    public var stage: CaptureDeliveryStage
    public var confirmedChannelIDs: Set<Int>
    public var contentVerified: Bool
    public var observedAt: Date
    public var notBefore: Date?
    /// A retained request, not proof that an in-flight Are.na operation stopped.
    public var stopRequested: Bool?
    /// Terminal user cancellation. Kept optional so older receipts still decode.
    /// Legacy stage/phase values remain readable by the previous app version.
    public var canceledAt: Date?
    public var canceledWithUnconfirmedRequest: Bool?
    public var confirmedOnceChannelIDs: Set<Int>?
    public var attemptedChannelIDs: [Int]?
    public var preparationCompleted: Bool?
    public var mediaUploadRequired: Bool?
    public var mediaUploadCompleted: Bool?
    public var transferProgress: CaptureTransferProgress?
    public var lastTransferOutcome: CaptureTransferOutcome?
    public var interruption: CaptureInterruption?
    /// Only projected from a job whose local preparation failed before any block request.
    public var preparationFailureStage: CaptureDeliveryStage?

    public var title: String {
        if canceledAt != nil { return "Canceled" }
        if stopRequested == true, let interruption, stage != .done, !stage.permitsStoppedRead {
            if interruption.reason != .userPause { return "Save interrupted" }
            return stage == .attention ? "Save paused" : "Stopping save"
        }
        if stage == .attention, let interruption, interruption.reason != .userPause { return "Save interrupted" }
        if preparationFailureStage == .reading || preparationFailureStage == .queued { return "Couldn’t read source" }
        if preparationFailureStage == .rendering { return "Couldn’t prepare media" }
        return stage.title
    }

    public init(operationID: UUID, receiptID: UUID? = nil, stage: CaptureDeliveryStage, confirmedChannelIDs: Set<Int> = [], contentVerified: Bool = false, observedAt: Date = Date(), notBefore: Date? = nil, stopRequested: Bool? = nil, canceledAt: Date? = nil, canceledWithUnconfirmedRequest: Bool? = nil, confirmedOnceChannelIDs: Set<Int>? = nil, attemptedChannelIDs: [Int]? = nil, preparationFailureStage: CaptureDeliveryStage? = nil) {
        self.operationID = operationID; self.receiptID = receiptID; self.stage = stage
        self.confirmedChannelIDs = confirmedChannelIDs; self.contentVerified = contentVerified
        self.observedAt = observedAt; self.notBefore = notBefore; self.stopRequested = stopRequested
        self.canceledAt = canceledAt
        self.canceledWithUnconfirmedRequest = canceledWithUnconfirmedRequest
        self.confirmedOnceChannelIDs = confirmedOnceChannelIDs; self.attemptedChannelIDs = attemptedChannelIDs
        self.preparationFailureStage = preparationFailureStage
    }
}

/// Display verified content and confirmed destination counts in system progress.
public struct CaptureContinuedProgress: Equatable, Sendable {
    public let operationID: UUID
    public let receiptID: UUID
    public let title: String
    public let subtitle: String
    public let completedUnits: Int64
    public let totalUnits: Int64
    public let isQuantifiable: Bool
    /// System activity work units include actual preparation/upload work while
    /// confirmed channel counts retain their independent, strict meaning.
    public let activityCompletedUnits: Int64
    public let activityTotalUnits: Int64
    public let isDone: Bool
    public let isCanceled: Bool
    public var isTerminal: Bool { isDone || isCanceled || needsAttention }
    public let needsAttention: Bool
    public let waitingToRetry: Bool
    public let transferStalled: Bool

    public init(state: CaptureDeliveryState, selectedChannelIDs: Set<Int>, now: Date = Date()) {
        operationID = state.operationID
        receiptID = state.receiptID ?? state.operationID
        let confirmed = state.confirmedChannelIDs.intersection(selectedChannelIDs).count
        let selected = selectedChannelIDs.count
        totalUnits = Int64(selected + 1)
        completedUnits = Int64(confirmed + (state.contentVerified ? 1 : 0))
        isCanceled = state.canceledAt != nil
        let preparation = state.preparationCompleted == true ? Int64(1_000) : 0
        let hasUpload = state.mediaUploadRequired == true
        let upload = state.mediaUploadCompleted == true ? Int64(6_000) : Int64((state.transferProgress?.stage == .upload ? state.transferProgress?.fraction ?? 0 : 0) * 6_000)
        activityTotalUnits = 1_000 + (hasUpload ? 6_000 : 0) + 1_000 + Int64(selected) * 1_000
        isQuantifiable = state.contentVerified || (state.stage == .done && !isCanceled)
        isDone = state.stage == .done && !isCanceled && state.contentVerified
            && selectedChannelIDs.isSubset(of: state.confirmedChannelIDs)
        activityCompletedUnits = isDone ? activityTotalUnits : min(activityTotalUnits, preparation + (hasUpload ? upload : 0) + (state.contentVerified ? 1_000 : 0) + Int64(confirmed) * 1_000)
        needsAttention = state.stage == .attention && !isCanceled
        waitingToRetry = !isCanceled && !isDone && !needsAttention && (state.notBefore ?? .distantPast) > now
        transferStalled = !isCanceled && !needsAttention && state.stage == .upload
            && state.transferProgress.map { now.timeIntervalSince($0.observedAt) >= 30 && ($0.fraction ?? 0) < 1 } == true
        if isCanceled {
            title = "Canceled"
        } else if isDone {
            title = state.title
        } else if state.stopRequested == true {
            title = needsAttention ? (state.interruption?.reason == .continuedTaskEnded || state.interruption?.reason == .executionClaimLost ? "Save interrupted" : "Save paused") : state.title
        } else if state.transferProgress?.waitingForConnectivity == true {
            title = "Waiting for connection"
        } else if waitingToRetry {
            title = "Waiting to retry"
        } else if transferStalled {
            title = "Upload not progressing"
        } else {
            title = state.title
        }
        if state.stage == .upload, let transfer = state.transferProgress {
            let sent = ByteCountFormatter.string(fromByteCount: transfer.completedBytes, countStyle: .file)
            if let total = transfer.expectedBytes {
                subtitle = "\(sent) of \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file)) uploaded · \(confirmed)/\(selected) channels confirmed"
            } else { subtitle = "\(sent) uploaded · \(confirmed)/\(selected) channels confirmed" }
        } else { subtitle = "\(confirmed) of \(selected) channels confirmed" }
    }
}

/// Identify the provider's HTTP 403/429 denial messages.
public enum CaptureSourceAccess {
    public static func redditDenied(_ problem: String?) -> Bool {
        guard let problem else { return false }
        return ["metadata", "post"].contains { kind in
            [403, 429].contains { status in problem.hasPrefix("Reddit's live \(kind) read returned HTTP \(status);") }
        }
    }
    public static func message(_ problem: String) -> String {
        redditDenied(problem) ? "Reddit didn’t allow Capture to read this link. Open the post or comment in Safari, then choose Share → Capture." : problem
    }
}

public enum CaptureIntent: String, Codable, Sendable { case capture, placements }

/// The selected draft and prior result are independent identities, stored per account and composer.
public struct CaptureWorkspace: Codable, Sendable {
    public var shareInvocationID: UUID?
    public var activeDraftID: UUID?
    public var retainedResultID: UUID?
    public var emptySelection: DestinationSelection?
    public init(activeDraftID: UUID? = nil, retainedResultID: UUID? = nil, emptySelection: DestinationSelection? = nil, shareInvocationID: UUID? = nil) {
        self.shareInvocationID = shareInvocationID
        self.activeDraftID = activeDraftID; self.retainedResultID = retainedResultID; self.emptySelection = emptySelection
    }
}

extension CaptureDraft {
    /// Presentation order keeps the frozen standing default secondary; delivery retains selection order.
    public var statusChannels: [Channel] {
        guard let submittedDefaultChannelID else { return selection.channels }
        return selection.channels.filter { $0.id != submittedDefaultChannelID }
            + selection.channels.filter { $0.id == submittedDefaultChannelID }
    }
    public var isPlacementOnly: Bool { intent == .placements }
    public var canAddPlacements: Bool {
        deliveryState?.canceledAt == nil && blockID != nil && (phase == .saved || (deliveryState?.operationID == id && deliveryState?.contentVerified == true))
    }

    public func addingPlacements() -> CaptureDraft? {
        guard canAddPlacements else { return nil }
        var next = self
        // Keep the logical capture and its block identity. Delivery applies the
        // selection to the latest durable state, not this potentially old copy.
        next.intent = .placements; next.phase = .ready
        next.problem = nil; next.publicationKey = nil
        return next
    }
}
