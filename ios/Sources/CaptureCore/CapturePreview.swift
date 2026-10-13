import Foundation

public struct CapturePreview: Codable, Sendable {
    public var kind: String
    public var url: String
    public var plan: JSONValue?
    /// Normalized primary references, before provider reads or expansion.
    public var inputRefs: [String]?
    /// Explicit supplementary media references, frozen separately from primaries.
    public var extraInputRefs: [String]?
    public var metadataTitle: String?
    public var previewPath: String?
    public init(kind: String, url: String, plan: JSONValue? = nil, inputRefs: [String]? = nil, extraInputRefs: [String]? = nil, metadataTitle: String? = nil, previewPath: String? = nil) {
        self.kind = kind; self.url = url; self.plan = plan; self.inputRefs = inputRefs; self.extraInputRefs = extraInputRefs
        self.metadataTitle = metadataTitle; self.previewPath = previewPath
    }
    public var title: String { plan?["block"]?["title"]?.string ?? metadataTitle ?? URL(string: url)?.host ?? url }
    public var text: String { plan?["block"]?["markdown"]?.string ?? "The original link will be saved to Are.na." }
    public var media: [JSONValue] { plan?["sources"]?.array.flatMap { $0["media"]?.array ?? [] } ?? [] }
    public var selectedMedia: [String] { plan?["block"]?["selectedMedia"]?.array.compactMap(\.string) ?? [] }

    public static func originalLink(_ url: URL) -> CapturePreview {
        .init(kind: "url", url: url.absoluteString, plan: nil)
    }

    public var localPreparation: PreparedCapture? {
        guard kind == "url", plan == nil else { return nil }
        var payload: [String: JSONValue] = ["value": .string(url), "original_source_url": .string(url)]
        var update: [String: JSONValue] = [:]
        if let metadataTitle, !metadataTitle.isEmpty { payload["title"] = .string(metadataTitle); update["title"] = .string(metadataTitle) }
        return .init(payload: payload, update: update)
    }
}

/// What the resolved composition will take from each source, in final order.
public struct CaptureSourceReview: Sendable {
    public let url: String
    public let role: String
    public let origin: String
    public let availableMediaCount: Int
    public let includedMediaCount: Int

    public var roleLabel: String { role == "extra" ? "Media only" : "Text and media" }
    public var originLabel: String { origin == "expanded" ? "Connected post" : "Chosen post" }
    public var mediaLabel: String {
        availableMediaCount == 0 ? "No media" : "\(includedMediaCount) of \(availableMediaCount) media included"
    }
}

public extension CapturePreview {
    var sourceReviews: [CaptureSourceReview] {
        let selected = Set(selectedMedia)
        return (plan?["sources"]?.array ?? []).compactMap { source in
            guard let url = source["canonicalUrl"]?.string else { return nil }
            let media = Set((source["media"]?.array ?? []).compactMap { $0["ref"]?.string })
            return CaptureSourceReview(url: url,
                role: source["selection"]?["role"]?.string == "extra" ? "extra" : "primary",
                origin: source["selection"]?["origin"]?.string == "expanded" ? "expanded" : "explicit",
                availableMediaCount: media.count, includedMediaCount: media.intersection(selected).count)
        }
    }

    var sourceSummary: String? {
        let reviews = sourceReviews
        guard !reviews.isEmpty else { return nil }
        let primary = reviews.filter { $0.role == "primary" }.count
        let included = reviews.reduce(0) { $0 + $1.includedMediaCount }
        return "\(reviews.count) \(reviews.count == 1 ? "source" : "sources") · \(primary) in text · \(included) media included"
    }

    var threadCoverageNote: String? {
        guard (plan?["sources"]?.array ?? []).contains(where: {
            $0["threadCoverage"]?["replyGaps"]?.array.isEmpty == false
        }) else { return nil }
        return "Some replies are unavailable."
    }
}

public struct PreparedCapture: Codable, Sendable {
    public var payload: [String: JSONValue]
    public var update: [String: JSONValue]
    public init(payload: [String: JSONValue], update: [String: JSONValue]) { self.payload = payload; self.update = update }
}
