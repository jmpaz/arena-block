import Foundation

public enum CaptureDeliveryStage: String, Codable, Sendable {
    case queued, reading, rendering, destinations, presign, upload, create, read, update, verify, connections, connect, reconcile, provenanceContents, provenanceRead, provenanceWrite, provenanceVerify, done, attention

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
    public var stage: CaptureDeliveryStage
    public var confirmedChannelIDs: Set<Int>
    public var contentVerified: Bool
    public var observedAt: Date
    public var notBefore: Date?
    /// A retained request, not proof that an in-flight Are.na operation stopped.
    public var stopRequested: Bool?
    /// Only projected from a job whose local preparation failed before any block request.
    public var preparationFailureStage: CaptureDeliveryStage?

    public var title: String {
        if preparationFailureStage == .reading || preparationFailureStage == .queued { return "Couldn’t read source" }
        if preparationFailureStage == .rendering { return "Couldn’t prepare media" }
        return stage.title
    }

    public init(operationID: UUID, stage: CaptureDeliveryStage, confirmedChannelIDs: Set<Int> = [], contentVerified: Bool = false, observedAt: Date = Date(), notBefore: Date? = nil, stopRequested: Bool? = nil, preparationFailureStage: CaptureDeliveryStage? = nil) {
        self.operationID = operationID; self.stage = stage
        self.confirmedChannelIDs = confirmedChannelIDs; self.contentVerified = contentVerified
        self.observedAt = observedAt; self.notBefore = notBefore; self.stopRequested = stopRequested
        self.preparationFailureStage = preparationFailureStage
    }
}

/// Display verified content and confirmed destination counts in system progress.
public struct CaptureContinuedProgress: Equatable, Sendable {
    public let operationID: UUID
    public let title: String
    public let subtitle: String
    public let completedUnits: Int64
    public let totalUnits: Int64
    public let isQuantifiable: Bool
    public let isDone: Bool
    public let needsAttention: Bool
    public let waitingToRetry: Bool

    public init(state: CaptureDeliveryState, selectedChannelIDs: Set<Int>, now: Date = Date()) {
        operationID = state.operationID
        let confirmed = state.confirmedChannelIDs.intersection(selectedChannelIDs).count
        let selected = selectedChannelIDs.count
        totalUnits = Int64(selected + 1)
        completedUnits = Int64(confirmed + (state.contentVerified ? 1 : 0))
        isQuantifiable = state.contentVerified || state.stage == .done
        isDone = state.stage == .done
        needsAttention = state.stage == .attention
        waitingToRetry = !isDone && !needsAttention && (state.notBefore ?? .distantPast) > now
        if state.stopRequested == true {
            title = needsAttention ? "Save paused" : "Stopping save"
        } else if waitingToRetry {
            title = "Waiting to retry"
        } else {
            title = state.title
        }
        subtitle = "\(confirmed) of \(selected) channels confirmed"
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
        redditDenied(problem) ? "Share the page from Safari to Capture, or import a browser capture file. A pasted link does not include the browser record." : problem
    }
}

public enum CaptureIntent: String, Codable, Sendable { case capture, placements }

/// The selected draft and prior result are independent identities, stored per account and composer.
public struct CaptureWorkspace: Codable, Sendable {
    public var activeDraftID: UUID?
    public var retainedResultID: UUID?
    public var emptySelection: DestinationSelection?
    public init(activeDraftID: UUID? = nil, retainedResultID: UUID? = nil, emptySelection: DestinationSelection? = nil) {
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
        blockID != nil && (phase == .saved || (deliveryState?.operationID == id && deliveryState?.contentVerified == true))
    }

    public func addingPlacements() -> CaptureDraft? {
        guard canAddPlacements else { return nil }
        var next = CaptureDraft(accountID: accountID, defaultChannel: nil, input: input)
        next.intent = .placements; next.phase = .ready; next.blockID = blockID
        next.media = media; next.titleOverride = titleOverride; next.descriptionOverride = descriptionOverride
        next.previewSnapshot = previewSnapshot; next.savedBlock = savedBlock; next.renderPath = renderPath
        return next
    }
}
