import Foundation

/// User intent frozen at the local submit boundary. Preparation never reads the live editor.
public struct CaptureSubmissionSnapshot: Codable, Sendable {
    public let url: String
    public let originalLinkOnly: Bool?
    /// Present for multi-post captures; absent in older single-source jobs.
    public let refs: [String]?
    /// Supplementary media stays separate from text-bearing primary sources.
    public let extraRefs: [String]?
    public let policy: JSONValue
    public let pendingMediaChoices: CaptureMediaChoiceAnchors?
    public let title: String?
    public let description: String?
    public let preview: CapturePreview?
    public let reusableRenderPath: String?

    public var sourceRefs: [String] { refs ?? [url] }
    public var supplementaryRefs: [String] { extraRefs ?? [] }

    public init(draft: CaptureDraft) throws {
        let selected = try CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles)
        let submittedURLs = selected.primary
        let submitted = submittedURLs.map(\.absoluteString)
        let extras = selected.extra.map(\.absoluteString)
        if draft.originalLinkOnly == true {
            guard submitted.count == 1, extras.isEmpty,
                  ["https", "http"].contains(submittedURLs[0].scheme?.lowercased() ?? "") else {
                throw CaptureError.message("An original link capture needs exactly one web link.")
            }
        }
        originalLinkOnly = draft.originalLinkOnly
        url = submitted[0]
        refs = submitted.count > 1 ? submitted : nil
        extraRefs = extras.isEmpty ? nil : extras
        policy = draft.compositionPolicy
        pendingMediaChoices = draft.pendingMediaChoices
        title = draft.titleOverride; description = draft.descriptionOverride
        let sourceMatch: Bool
        if let candidate = draft.previewSnapshot, let previewURL = URL(string: candidate.url),
           CaptureInput.canonicalSourceIdentity(previewURL) == CaptureInput.canonicalSourceIdentity(submittedURLs[0]) {
            if let inputRefs = candidate.inputRefs {
                let entered = inputRefs.compactMap(URL.init(string:))
                let enteredExtras = (candidate.extraInputRefs ?? []).compactMap(URL.init(string:))
                sourceMatch = entered.count == submittedURLs.count &&
                    entered.map(CaptureInput.canonicalSourceIdentity) == submittedURLs.map(CaptureInput.canonicalSourceIdentity) &&
                    enteredExtras.count == selected.extra.count &&
                    enteredExtras.map(CaptureInput.canonicalSourceIdentity) == selected.extra.map(CaptureInput.canonicalSourceIdentity)
            } else if let sources = candidate.plan?["sources"]?.array {
                // Older previews lack the entered URL list. Expansion adds
                // resolved posts; match its annotated explicit primaries.
                let annotated = sources.contains { $0["selection"] != nil }
                let explicit = annotated ? sources.filter {
                    $0["selection"]?["origin"]?.string == "explicit" && $0["selection"]?["role"]?.string == "primary"
                } : sources
                let identities = explicit.compactMap { $0["canonicalUrl"]?.string }.compactMap(URL.init(string:)).map(CaptureInput.canonicalSourceIdentity)
                let explicitExtras = annotated ? sources.filter {
                    $0["selection"]?["origin"]?.string == "explicit" && $0["selection"]?["role"]?.string == "extra"
                } : []
                let extraIdentities = explicitExtras.compactMap { $0["canonicalUrl"]?.string }.compactMap(URL.init(string:)).map(CaptureInput.canonicalSourceIdentity)
                sourceMatch = identities == submittedURLs.map(CaptureInput.canonicalSourceIdentity) &&
                    extraIdentities == selected.extra.map(CaptureInput.canonicalSourceIdentity)
            } else { sourceMatch = submitted.count == 1 && extras.isEmpty }
        } else { sourceMatch = false }
        preview = sourceMatch ? draft.previewSnapshot : nil
        // A render in progress can belong to earlier media choices.
        reusableRenderPath = sourceMatch && draft.phase == .ready ? draft.renderPath : nil
    }
}
