import Foundation

/// List presentation and lifecycle metadata. Source records, composition plans,
/// block bodies and receipts stay in the original draft and are loaded on demand.
public struct CaptureHistorySummary: Decodable, Identifiable, Sendable {
    public let id: UUID
    public let accountID: Int
    public let input: String
    public let selection: DestinationSelection
    public let phase: CapturePhase
    public let blockID: Int?
    public let deliveryState: CaptureDeliveryState?
    public let updatedAt: Date
    public let title: String
    public let imageURL: URL?
    public let hasProblem: Bool
    public let hasUserEdits: Bool

    public var isCanceled: Bool { deliveryState?.canceledAt != nil }
    public var isUnsubmittedDraft: Bool { !isCanceled && [.editing, .preparing, .ready, .failed].contains(phase) }
    public var isActiveCapture: Bool { captureIsActive(phase: phase, deliveryState: deliveryState) }
    public var isDraftCapture: Bool { !isCanceled && (isUnsubmittedDraft || deliveryState?.preparationFailureStage != nil) }

    func automaticDraftExpired(at date: Date) -> Bool {
        isUnsubmittedDraft && !hasUserEdits && blockID == nil && deliveryState == nil
            && date.timeIntervalSince(updatedAt) >= 24 * 60 * 60
    }

    public init(draft: CaptureDraft) {
        id = draft.id; accountID = draft.accountID; input = draft.input
        selection = draft.selection; phase = draft.phase; blockID = draft.blockID
        deliveryState = draft.deliveryState; updatedAt = draft.updatedAt
        title = draft.savedBlock?["title"]?.string ?? draft.titleOverride ?? draft.previewSnapshot?.title
            ?? URL(string: draft.input)?.host ?? draft.input
        let image = draft.savedBlock?["image"]
        let raw = image?["large"]?["url"]?.string ?? image?["original"]?["url"]?.string
            ?? image?["large"]?["src"]?.string ?? image?["medium"]?["src"]?.string ?? image?["src"]?.string
        imageURL = raw.flatMap(URL.init(string:))
        hasProblem = draft.problem != nil; hasUserEdits = draft.hasUserEdits
    }

    private enum CodingKeys: String, CodingKey {
        case id, accountID, input, selection, phase, blockID, deliveryState, updatedAt
        case titleOverride, descriptionOverride, previewSnapshot, savedBlock, problem
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        accountID = try c.decode(Int.self, forKey: .accountID)
        input = try c.decode(String.self, forKey: .input)
        selection = try c.decode(DestinationSelection.self, forKey: .selection)
        phase = try c.decode(CapturePhase.self, forKey: .phase)
        blockID = try c.decodeIfPresent(Int.self, forKey: .blockID)
        deliveryState = try c.decodeIfPresent(CaptureDeliveryState.self, forKey: .deliveryState)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        let override = try c.decodeIfPresent(String.self, forKey: .titleOverride)
        let descriptionOverride = try c.decodeIfPresent(String.self, forKey: .descriptionOverride)
        hasUserEdits = override != nil || descriptionOverride != nil
        hasProblem = try c.decodeIfPresent(String.self, forKey: .problem) != nil
        let block = try? c.decode(BlockHeading.self, forKey: .savedBlock)
        let preview = try c.decodeIfPresent(PreviewHeading.self, forKey: .previewSnapshot)
        title = block?.title ?? override ?? preview?.title ?? URL(string: input)?.host ?? input
        imageURL = block?.image?.url
    }

    private struct BlockHeading: Decodable {
        let title: String?
        let image: ImageHeading?
        enum CodingKeys: String, CodingKey { case title, image }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = try? c.decode(String.self, forKey: .title)
            image = try? c.decode(ImageHeading.self, forKey: .image)
        }
    }

    private struct ImageHeading: Decodable {
        struct Variant: Decodable {
            var url: String?
            var src: String?
            enum CodingKeys: String, CodingKey { case url, src }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                url = try? c.decode(String.self, forKey: .url)
                src = try? c.decode(String.self, forKey: .src)
            }
        }
        var large: Variant?
        var original: Variant?
        var medium: Variant?
        var src: String?
        enum CodingKeys: String, CodingKey { case large, original, medium, src }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            large = try? c.decode(Variant.self, forKey: .large)
            original = try? c.decode(Variant.self, forKey: .original)
            medium = try? c.decode(Variant.self, forKey: .medium)
            src = try? c.decode(String.self, forKey: .src)
        }
        var url: URL? {
            (large?.url ?? original?.url ?? large?.src ?? medium?.src ?? src).flatMap(URL.init(string:))
        }
    }

    private struct PreviewHeading: Decodable {
        struct PlanHeading: Decodable {
            struct Block: Decodable {
                var title: String?
                enum CodingKeys: String, CodingKey { case title }
                init(from decoder: Decoder) throws {
                    let c = try decoder.container(keyedBy: CodingKeys.self)
                    title = try? c.decode(String.self, forKey: .title)
                }
            }
            var block: Block?
        }
        var url: String
        var metadataTitle: String?
        var plan: PlanHeading?
        enum CodingKeys: String, CodingKey { case url, metadataTitle, plan }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            url = try c.decode(String.self, forKey: .url)
            metadataTitle = try c.decodeIfPresent(String.self, forKey: .metadataTitle)
            plan = try? c.decode(PlanHeading.self, forKey: .plan)
        }
        var title: String { plan?.block?.title ?? metadataTitle ?? URL(string: url)?.host ?? url }
    }
}

func captureIsActive(phase: CapturePhase, deliveryState: CaptureDeliveryState?) -> Bool {
    if deliveryState?.canceledAt != nil { return false }
    if deliveryState?.preparationFailureStage != nil { return false }
    return [.queued, .creating, .checking, .uncertain].contains(phase)
        || (deliveryState != nil && deliveryState?.stage != .done)
}
