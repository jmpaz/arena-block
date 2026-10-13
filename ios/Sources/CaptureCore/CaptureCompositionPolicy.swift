import Foundation

public enum CaptureQuoteDepth: Hashable, Codable, Sendable {
    case levels(Int)
    case full

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let depth = try? value.decode(Int.self), (0...8).contains(depth) { self = .levels(depth) }
        else if (try? value.decode(String.self)) == "full" { self = .full }
        else { throw DecodingError.dataCorruptedError(in: value, debugDescription: "Expected quote depth 0...8 or full.") }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .levels(let depth): try value.encode(depth)
        case .full: try value.encode("full")
        }
    }

    public var title: String {
        switch self {
        case .levels(0): "Root only"
        case .levels(1): "1 level"
        case .levels(let depth): "Up to \(depth) levels"
        case .full: "All available"
        }
    }

    public var jsonValue: JSONValue {
        switch self {
        case .levels(let depth): .number(Double(depth))
        case .full: .string("full")
        }
    }
}

public extension CapturePreview {
    var mediaRefs: [String] {
        var seen = Set<String>()
        return media.compactMap { $0["ref"]?.string }.filter { seen.insert($0).inserted }
    }

    func orderedMediaRefs(_ refs: [String]) -> [String] {
        let chosen = Set(refs)
        return mediaRefs.filter { chosen.contains($0) }
    }

    var hasQuotes: Bool {
        plan?["sources"]?.array.contains { source in
            source["quote"]?.object.isEmpty == false
                || source["embeddedRecord"]?.object.isEmpty == false
                || (source["quoteCoverage"]?["actualDepth"]?.int ?? 0) > 0
                || source["quoteCoverage"]?["mayExpand"] == .bool(true)
        } ?? false
    }

    var availableQuoteDepth: Int {
        func depth(_ source: JSONValue) -> Int {
            guard let quote = source["quote"], !quote.object.isEmpty else { return 0 }
            return 1 + depth(quote)
        }
        return min(8, plan?["sources"]?.array.map { source in
            max(source["quoteCoverage"]?["actualDepth"]?.int ?? 0, depth(source))
        }.max() ?? 0)
    }

    var canExpandQuotes: Bool {
        plan?["sources"]?.array.contains { $0["quoteCoverage"]?["mayExpand"] == .bool(true) } ?? false
    }
}

/// Stable identity for a chosen asset while thread expansion changes its
/// positional `1.1`-style reference. A missing match stops preparation rather
/// than applying the choice to a different post's media.
public struct CaptureMediaAnchor: Codable, Hashable, Sendable {
    public let source: String
    public let url: String
    public let kind: String
    public let occurrence: Int
}

public struct CaptureMediaChoiceAnchors: Codable, Sendable {
    public let selected: [CaptureMediaAnchor]?
    public let frames: [CaptureMediaAnchor]?

    private static func indexes(in sources: JSONValue) throws ->
        (byRef: [String: CaptureMediaAnchor], byAnchor: [CaptureMediaAnchor: String]) {
        var byRef: [String: CaptureMediaAnchor] = [:]
        var byAnchor: [CaptureMediaAnchor: String] = [:]
        var occurrences: [String: Int] = [:]
        for source in sources.array {
            let media = source["media"]?.array ?? []
            guard media.isEmpty || source["canonicalUrl"]?.string != nil else {
                throw CaptureError.message("Couldn't identify the source for the selected media. No block was created.")
            }
            let sourceURL = source["canonicalUrl"]?.string ?? ""
            let identity = URL(string: sourceURL).map(CaptureInput.canonicalSourceIdentity) ?? sourceURL
            for asset in media {
                guard let ref = asset["ref"]?.string, let url = asset["url"]?.string,
                      let kind = asset["kind"]?.string else {
                    throw CaptureError.message("The source details for selected media are incomplete. No block was created.")
                }
                let key = "\(identity)\u{1F}\(url)\u{1F}\(kind)"
                let occurrence = occurrences[key, default: 0]
                occurrences[key] = occurrence + 1
                let anchor = CaptureMediaAnchor(source: identity, url: url, kind: kind, occurrence: occurrence)
                guard byRef.updateValue(anchor, forKey: ref) == nil,
                      byAnchor.updateValue(ref, forKey: anchor) == nil else {
                    throw CaptureError.message("Couldn't identify the selected media. No block was created.")
                }
            }
        }
        return (byRef, byAnchor)
    }

    public static func capture(preview: CapturePreview, selected: [String]?, frames: [String]?) throws -> Self {
        guard let sources = preview.plan?["sources"] else {
            throw CaptureError.message("Load the source before changing media or post options.")
        }
        let index = try indexes(in: sources).byRef
        func anchors(_ refs: [String]?) throws -> [CaptureMediaAnchor]? {
            try refs?.map { ref in
                guard let anchor = index[ref] else {
                    throw CaptureError.message("Selected media is missing from the source. Review it before saving.")
                }
                return anchor
            }
        }
        return try .init(selected: anchors(selected), frames: anchors(frames))
    }

    public func applying(to policy: JSONValue, sources: JSONValue) throws -> JSONValue {
        let index = try Self.indexes(in: sources).byAnchor
        func refs(_ anchors: [CaptureMediaAnchor]) throws -> [String] {
            try anchors.map { anchor in
                guard let ref = index[anchor] else {
                    throw CaptureError.message("Selected media changed after you changed the source options. Review your selection before saving. No block was created.")
                }
                return ref
            }
        }
        var object = policy.object
        if let selected { object["selectedMedia"] = .array(try refs(selected).map(JSONValue.string)) }
        if let frames { object["videoFrames"] = .array(try refs(frames).map(JSONValue.string)) }
        return .object(object)
    }
}

public extension CaptureDraft {
    var compositionPolicy: JSONValue {
        var policy: [String: JSONValue] = ["media": .string(media.rawValue)]
        if media == .selected { policy["selectedMedia"] = .array((selectedMedia ?? []).map(JSONValue.string)) }
        if let videoFrames, !videoFrames.isEmpty { policy["videoFrames"] = .array(videoFrames.map(JSONValue.string)) }
        if let videoFrameThresholdSeconds { policy["videoFrameThresholdSeconds"] = .number(Double(videoFrameThresholdSeconds)) }
        if let quoteDepth { policy["quoteDepth"] = quoteDepth.jsonValue }
        if let threadExpansion { policy["threadExpansion"] = .string(threadExpansion.rawValue) }
        return .object(policy)
    }

    func includedMedia(in preview: CapturePreview) -> [String] {
        switch media {
        case .auto: preview.orderedMediaRefs(preview.selectedMedia)
        case .all: preview.mediaRefs
        case .none: []
        case .selected: preview.orderedMediaRefs(selectedMedia ?? [])
        }
    }

    mutating func selectMedia(_ refs: [String], in preview: CapturePreview) {
        media = .selected
        selectedMedia = preview.orderedMediaRefs(refs)
    }

    mutating func toggleMedia(_ ref: String, in preview: CapturePreview) {
        guard preview.mediaRefs.contains(ref) else { return }
        var selected = Set(includedMedia(in: preview))
        if !selected.insert(ref).inserted { selected.remove(ref) }
        videoFrames?.removeAll { $0 == ref }
        selectMedia(Array(selected), in: preview)
    }
}

/// Preserve the resolved source roles whenever native code recomposes a plan.
/// Expansion can insert primary posts ahead of explicit media-only extras, so
/// their positions cannot be taken from the original entered URL indexes.
public enum CaptureSourcePolicy {
    public static func composing(_ policy: JSONValue, sources: JSONValue) throws -> JSONValue {
        let posts = sources.array
        let annotated = posts.contains { $0["selection"] != nil }
        guard annotated else { return policy }
        guard posts.allSatisfy({ ["primary", "extra"].contains($0["selection"]?["role"]?.string ?? "") }) else {
            throw CaptureError.message("Couldn't prepare every selected post. No block was created. Try again.")
        }
        var object = policy.object
        object["mediaOnlyPosts"] = .array(posts.enumerated().compactMap { index, post in
            post["selection"]?["role"]?.string == "extra" ? .number(Double(index + 1)) : nil
        })
        return .object(object)
    }
}
