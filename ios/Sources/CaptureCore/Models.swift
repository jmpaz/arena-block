import Foundation

public struct Owner: Codable, Equatable, Sendable {
    public var id: Int
    public var name: String
    public var slug: String
    public var type: String
    public init(id: Int, name: String, slug: String, type: String) {
        self.id = id; self.name = name; self.slug = slug; self.type = type
    }
}

public struct Channel: Codable, Identifiable, Equatable, Sendable {
    public struct Counts: Codable, Equatable, Sendable {
        public var contents: Int?
    }
    public struct Abilities: Codable, Equatable, Sendable {
        public var addTo: Bool
        public init(addTo: Bool) { self.addTo = addTo }
        enum CodingKeys: String, CodingKey { case addTo = "add_to" }
    }
    public var id: Int
    public var title: String
    public var slug: String
    public var visibility: String
    public var owner: Owner
    public var can: Abilities?
    public var counts: Counts?
    public var label: String { "\(owner.name) / \(title)" }
    public var url: URL { URL(string: "https://www.are.na/\(owner.slug)/\(slug)")! }

    public init(id: Int, title: String, slug: String, visibility: String, owner: Owner, can: Abilities? = nil, counts: Counts? = nil) {
        self.id = id; self.title = title; self.slug = slug
        self.visibility = visibility; self.owner = owner; self.can = can; self.counts = counts
    }
}

public struct Account: Codable, Identifiable, Equatable, Sendable {
    public var id: Int
    public var name: String
    public var slug: String
    public var tier: String
    public var supportsSearch: Bool { ["premium", "supporter"].contains(tier) }
}

public struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    public struct Meta: Decodable, Sendable {
        public var nextPage: Int?
        public var hasMorePages: Bool
        enum CodingKeys: String, CodingKey {
            case nextPage = "next_page", hasMorePages = "has_more_pages"
        }
    }
    public var data: [Item]
    public var meta: Meta
}

public enum SearchScope: String, CaseIterable, Codable, Sendable {
    case my, following, all
    public var title: String {
        switch self { case .my: "My Are.na"; case .following: "My network"; case .all: "All" }
    }
}

public enum MediaPolicy: String, CaseIterable, Codable, Sendable {
    case auto, all, none, selected
    public var title: String {
        switch self { case .auto: "Automatic"; case .all: "All media"; case .none: "Text only"; case .selected: "Selected media" }
    }
}

public struct DestinationSelection: Codable, Equatable, Sendable {
    public private(set) var channels: [Channel]
    public private(set) var implicitDefault: Bool

    public init(defaultChannel: Channel?) {
        channels = defaultChannel.map { [$0] } ?? []
        implicitDefault = defaultChannel != nil
    }

    public func contains(_ channel: Channel) -> Bool { channels.contains { $0.id == channel.id } }

    public mutating func toggle(_ channel: Channel, maxCount: Int = 20) {
        if contains(channel) {
            channels.removeAll { $0.id == channel.id }
        } else {
            guard channels.count < maxCount else { return }
            channels.append(channel)
        }
        implicitDefault = false
    }

    public mutating func includeAutomatic(_ channel: Channel) throws {
        channels.removeAll { $0.id == channel.id }
        guard channels.count < 20 else { throw CaptureError.message("Choose at most 19 other channels when the default channel is also included.") }
        channels.insert(channel, at: 0)
    }
}

public enum DefaultChannelMode: String, Codable, Sendable { case fallback, always }

public struct DefaultChannelPolicy: Codable, Equatable, Sendable {
    public var mode: DefaultChannelMode
    public var provenance: Bool
    public init(mode: DefaultChannelMode = .fallback, provenance: Bool = true) { self.mode = mode; self.provenance = provenance }
}

public enum CaptureDefaultRoute {
    public static func initialPolicy(stored: DefaultChannelPolicy?, initialMode: DefaultChannelMode, configuredAccountID: Int?) -> DefaultChannelPolicy {
        stored ?? DefaultChannelPolicy(mode: configuredAccountID == nil ? initialMode : .fallback)
    }

    public static func shouldApplyInitialDefault(accountID: Int, configuredAccountID: Int?, targetChannelID: Int?,
                                                 replacingChannelID: Int?, currentDefaultID: Int?, alreadyConfigured: Bool) -> Bool {
        guard configuredAccountID == accountID, let targetChannelID, targetChannelID > 0, !alreadyConfigured else { return false }
        guard let currentDefaultID else { return true }
        return currentDefaultID == targetChannelID || (replacingChannelID == currentDefaultID && (replacingChannelID ?? 0) > 0)
    }

    public static func destinations(_ selection: DestinationSelection, defaultChannel: Channel?, mode: DefaultChannelMode) throws -> [Channel] {
        var routed = selection
        if let defaultChannel, mode == .always || selection.contains(defaultChannel) { try routed.includeAutomatic(defaultChannel) }
        return routed.channels
    }

    public static func verifiedProvenanceChannel(_ channel: Channel, accountID: Int, expectedChannelID: Int) throws -> Channel {
        guard channel.id == expectedChannelID, channel.owner.id == accountID, channel.owner.type == "User",
              channel.visibility == "private", channel.can?.addTo == true else {
            throw CaptureError.message("Choose a private default channel on your account with write access.")
        }
        return channel
    }
}

public enum CapturePhase: String, Codable, Sendable {
    case editing, preparing, ready, queued, creating, checking, saved, failed, uncertain
}

public enum CaptureThreadExpansion: String, Codable, Sendable { case auto, off, on }
public enum CaptureSourceRole: String, Codable, Sendable { case primary, extra }

public struct CaptureSelectedPosts: Sendable {
    public let primary: [URL]
    public let extra: [URL]
    public var all: [URL] { primary + extra }
}

public struct CaptureDraft: Codable, Identifiable, Sendable {
    public var id: UUID
    public var accountID: Int
    public var input: String
    /// Explicit user choice to capture one original URL without provider content or metadata.
    public var originalLinkOnly: Bool?
    /// Sanitized public records observed in the user-invoked browser share, without browser session data.
    public var redditCapturesJSON: String?
    public var substackCapturesJSON: String?
    public var media: MediaPolicy
    public var selectedMedia: [String]?
    public var videoFrames: [String]?
    /// Video soundtrack policy: auto, mix, or a selected moving video's ref.
    public var audio: String?
    public var videoFrameThresholdSeconds: Int?
    public var quoteDepth: CaptureQuoteDepth?
    /// Nil retains legacy quote credits; an explicit choice applies only to this draft.
    public var quoteAuthorLink: CaptureQuoteAuthorLink?
    /// Nil decodes older drafts as the shared core's default automatic mode.
    public var threadExpansion: CaptureThreadExpansion?
    /// One role per visible input row. Missing entries from older drafts are primary.
    public var sourceRoles: [CaptureSourceRole]?
    /// Keeps explicit media choices attached to their original source while
    /// a changed thread scope or source role is being resolved.
    public var pendingMediaChoices: CaptureMediaChoiceAnchors?
    public var selection: DestinationSelection
    public var requestedChannelIDs: [Int]?
    public var submittedDefaultChannelID: Int?
    public var provenanceChannelID: Int?
    public var defaultChannelMode: DefaultChannelMode?
    public var provenanceSnapshotJSON: String?
    public var provenanceConnectionID: Int?
    public var phase: CapturePhase
    public var blockID: Int?
    public var publicationKey: String?
    public var intent: CaptureIntent?
    public var deliveryState: CaptureDeliveryState?
    public var titleOverride: String?
    public var descriptionOverride: String?
    public var previewSnapshot: CapturePreview?
    public var savedBlock: JSONValue?
    public var renderPath: String?
    public var problem: String?
    public var updatedAt: Date

    public init(accountID: Int, defaultChannel: Channel?, input: String = "") {
        id = UUID(); self.accountID = accountID; self.input = input
        media = .auto; selection = .init(defaultChannel: defaultChannel); requestedChannelIDs = nil
        phase = .editing; updatedAt = Date()
    }

    public mutating func recoverAfterInterruption() {
        if phase == .creating {
            phase = .uncertain
            problem = "The app closed before the save could be confirmed. Check your destinations in Are.na before trying again."
        }
        else if phase == .checking { phase = blockID == nil ? .uncertain : .checking }
        else if phase == .preparing || phase == .ready { phase = isPlacementOnly ? .ready : .editing }
    }
}

public enum CaptureInput {
    /// Note identity is in its verified path. Remove sharing parameters before
    /// displaying intake, while leaving other providers' query/fragment IDs intact.
    public static func canonicalSourceURL(_ url: URL) -> URL {
        guard url.scheme?.lowercased() == "https", ["substack.com", "www.substack.com"].contains(url.host?.lowercased() ?? ""),
              url.user == nil, url.password == nil, url.port == nil,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.percentEncodedPath.range(of: #"^/(?:(@[A-Za-z0-9_]+|profile/[1-9][0-9]*(?:-[A-Za-z0-9_-]+)?)/)?note/c-[1-9][0-9]*/?$"#, options: .regularExpression) != nil else { return url }
        components.scheme = "https"; components.host = "substack.com"
        components.query = nil; components.fragment = nil
        if components.path.hasSuffix("/") { components.path.removeLast() }
        return components.url ?? url
    }

    public static func canonicalSourceText(_ text: String) -> String {
        text.components(separatedBy: "\n").map { line in
            let value = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
                  let url = URL(string: value) else { return line }
            let canonical = canonicalSourceURL(url)
            return canonical == url ? line : canonical.absoluteString
        }.joined(separator: "\n")
    }

    /// Local preflight identity for post variants. The shared resolver remains
    /// authoritative for provider canonicalization and coverage.
    public static func canonicalSourceIdentity(_ url: URL) -> String {
        let parts = url.path.split(separator: "/").map(String.init)
        if url.scheme?.lowercased() == "at", parts.count == 2,
           ["app.bsky.feed.post", "town.delve.feed.post"].contains(parts[0]), let author = url.host {
            let provider = parts[0] == "town.delve.feed.post" ? "delve" : "bluesky"
            return "\(provider):\(author.lowercased())/\(parts[1])"
        }
        let host = (url.host ?? "").lowercased().replacingOccurrences(of: #"^www\."#, with: "", options: .regularExpression)
        if host == "substack.com", let range = url.path.range(of: #"/note/c-([1-9][0-9]*)/?$"#, options: .regularExpression) {
            let identity = String(url.path[range]).replacingOccurrences(of: "/note/c-", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return "substack:\(identity)"
        }
        if ["x.com", "twitter.com", "fixupx.com", "fxtwitter.com", "vxtwitter.com", "twittpr.com"].contains(host),
           let index = parts.firstIndex(of: "status"), parts.indices.contains(index + 1),
           !parts[index + 1].isEmpty, parts[index + 1].allSatisfy(\.isNumber) {
            return "x:\(parts[index + 1])"
        }
        if ["bsky.app", "delve.town"].contains(host), parts.count == 4, parts[0] == "profile", parts[2] == "post" {
            let provider = host == "delve.town" ? "delve" : "bluesky"
            return "\(provider):\(parts[1].replacingOccurrences(of: "@", with: "").lowercased())/\(parts[3])"
        }
        if ["reddit.com", "old.reddit.com", "new.reddit.com", "redd.it"].contains(host),
           url.scheme?.lowercased() == "https", url.user == nil, url.password == nil, url.port == nil {
            let path = url.path
            if parts.count == 2, parts[0] == "gallery", parts[1].range(of: #"^[a-z0-9]+$"#, options: .regularExpression) != nil {
                return "reddit:\(parts[1]):"
            }
            let pattern = host == "redd.it" ? #"^/([a-z0-9]+)/?$"# : #"^/(?:r/[A-Za-z0-9_]+/)?comments/([a-z0-9]+)(?:/[^/]+(?:/([a-z0-9]+))?)?/?$"#
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
               let postRange = Range(match.range(at: 1), in: path) {
                let comment = match.numberOfRanges > 2 ? Range(match.range(at: 2), in: path).map { String(path[$0]) } : nil
                return "reddit:\(path[postRange]):\(comment ?? "")"
            }
        }
        if let site = ["lesswrong.com": "lesswrong", "greaterwrong.com": "lesswrong",
                       "alignmentforum.org": "alignment_forum", "forum.effectivealtruism.org": "ea_forum"][host] {
            // Match the shared resolver's public post and comment routes. Keep
            // malformed links distinct so the resolver can reject them later.
            guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
                  url.port == nil else { return url.absoluteString }
            let validID = { (value: String) in value.range(of: #"^[A-Za-z0-9]+$"#, options: .regularExpression) != nil }
            let postID: String?
            let pathComment: String?
            switch parts.count {
            case 2 where parts[0] == "posts" || parts[0] == "p":
                postID = parts[1]; pathComment = nil
            case 3 where parts[0] == "posts":
                postID = parts[1]
                pathComment = nil
            case 4 where parts[0] == "s" && parts[2] == "p":
                postID = parts[3]; pathComment = nil
            case 5 where parts[0] == "posts" && parts[3] == "comment":
                postID = parts[1]; pathComment = parts[4]
            default:
                postID = nil; pathComment = nil
            }
            guard let postID, validID(postID), pathComment.map(validID) != false else { return url.absoluteString }
            let queries = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                .filter { $0.name == "commentId" }.map { $0.value ?? "" } ?? []
            let fragment = url.fragment ?? ""
            let fragmentID: String?
            if fragment.hasPrefix("comment-") {
                let candidate = String(fragment.dropFirst("comment-".count))
                guard (12...30).contains(candidate.count), validID(candidate) else { return url.absoluteString }
                fragmentID = candidate
            }
            else if (12...30).contains(fragment.count), validID(fragment) { fragmentID = fragment }
            else { fragmentID = nil }
            var comments: [String] = []
            if let pathComment { comments.append(pathComment) }
            comments.append(contentsOf: queries)
            if let fragmentID { comments.append(fragmentID) }
            guard comments.allSatisfy({ validID($0) && $0 == comments.first }) else { return url.absoluteString }
            let target = comments.first.map { "comment:\(postID):\($0)" } ?? "post:\(postID)"
            return "forum-magnum:\(site):\(target)"
        }
        var normalized = URLComponents(url: url, resolvingAgainstBaseURL: false)
        normalized?.fragment = nil
        return normalized?.url?.absoluteString ?? url.absoluteString
    }

    public static func isAtprotoPost(_ url: URL) -> Bool {
        let identity = canonicalSourceIdentity(url)
        return identity.hasPrefix("bluesky:") || identity.hasPrefix("delve:")
    }

    public static func isBlueskyPost(_ url: URL) -> Bool { canonicalSourceIdentity(url).hasPrefix("bluesky:") }

    public static func isForumMagnumComment(_ url: URL) -> Bool {
        canonicalSourceIdentity(url).range(of: #"^forum-magnum:[^:]+:comment:"#, options: .regularExpression) != nil
    }

    public static func urls(in text: String) -> [URL] {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let matches = detector?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? []
        var seen = Set<String>()
        return matches.compactMap { match in
            guard let url = match.url, ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
                  url.user == nil, url.password == nil, seen.insert(url.absoluteString).inserted else { return nil }
            return canonicalSourceURL(url)
        }
    }

    /// Clipboard intake may discard surrounding prose, but must never place
    /// that prose in the source editor or silently truncate a set of links.
    public static func pasteableSourceText(_ text: String) -> String? {
        let range = NSRange(text.startIndex..., in: text)
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        var candidates: [(Int, URL)] = []
        for match in detector?.matches(in: text, range: range) ?? [] {
            guard let sourceRange = Range(match.range, in: text), let url = match.url else { continue }
            let source = text[sourceRange].lowercased()
            guard source.hasPrefix("https://") || source.hasPrefix("http://"),
                  ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
                  url.host?.isEmpty == false, url.user == nil, url.password == nil else { continue }
            candidates.append((match.range.location, url))
        }
        let atPattern = try? NSRegularExpression(pattern: #"at://[A-Za-z0-9.:%_-]+/(?:app\.bsky|town\.delve)\.feed\.post/[A-Za-z0-9._~:-]+"#)
        for match in atPattern?.matches(in: text, range: range) ?? [] {
            guard let sourceRange = Range(match.range, in: text),
                  let url = try? singleURL(String(text[sourceRange])),
                  isAtprotoPost(url) else { continue }
            candidates.append((match.range.location, url))
        }
        var seen = Set<String>()
        let links = candidates.sorted { $0.0 < $1.0 }.compactMap { _, url -> String? in
            seen.insert(canonicalSourceIdentity(url)).inserted ? canonicalSourceURL(url).absoluteString : nil
        }
        guard !links.isEmpty, links.count <= 20 else { return nil }
        return links.joined(separator: "\n")
    }

    public static func singleURL(_ text: String) throws -> URL {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("at://"),
           value.range(of: #"^at://[a-zA-Z0-9.:%_-]+/(?:app\.bsky|town\.delve)\.feed\.post/[a-zA-Z0-9._~:-]+$"#, options: .regularExpression) != nil {
            if let url = URL(string: value) { return url }
            let parts = value.dropFirst(5).split(separator: "/")
            if parts.count == 3 {
                let host = parts[1] == "town.delve.feed.post" ? "delve.town" : "bsky.app"
                let actor = parts[0].replacingOccurrences(of: "%", with: "%25")
                if let url = URL(string: "https://\(host)/profile/\(actor)/post/\(parts[2])") { return url }
            }
        }
        let found = urls(in: value)
        guard found.count == 1 else { throw CaptureError.message(found.isEmpty ? "Paste a link to capture." : "Choose one link for this capture.") }
        return found[0]
    }

    /// A capture may contain several intentional source posts in their entered order.
    /// Blank rows are allowed while editing; each filled row must identify one source.
    public static func postURLs(_ text: String) throws -> [URL] {
        try selectedPosts(text, roles: nil).primary
    }

    /// Resolve explicit roles before de-duplication so a primary copy wins
    /// over the same URL entered earlier as supplementary media.
    public static func selectedPosts(_ text: String, roles: [CaptureSourceRole]?) throws -> CaptureSelectedPosts {
        let rows = text.components(separatedBy: "\n")
        guard rows.count <= 20 else { throw CaptureError.message("Choose at most 20 source posts.") }
        var primary: [URL] = [], extra: [URL] = []
        for (index, row) in rows.enumerated() {
            let value = row.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { continue }
            let url = try singleURL(value)
            if roles?.indices.contains(index) == true && roles?[index] == .extra { extra.append(url) }
            else { primary.append(url) }
        }
        guard !primary.isEmpty else {
            throw CaptureError.message(extra.isEmpty ? "Paste a link to capture." : "Include text from at least one post.")
        }
        var seen = Set<String>()
        return CaptureSelectedPosts(primary: primary.filter { seen.insert(canonicalSourceIdentity($0)).inserted },
                                    extra: extra.filter { seen.insert(canonicalSourceIdentity($0)).inserted })
    }

    public static func channelIdentifier(_ input: String) throws -> String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: value), let host = url.host {
            guard ["are.na", "www.are.na"].contains(host.lowercased()),
                  ["https", "http"].contains(url.scheme ?? ""), url.user == nil, url.password == nil else {
                throw CaptureError.message("Use an Are.na channel URL or slug.")
            }
            let parts = url.path.split(separator: "/").map(String.init)
            guard parts.count == 2, !["block", "developers", "settings", "oauth"].contains(parts[0]) else {
                throw CaptureError.message("This is not a channel URL.")
            }
            return parts[1]
        }
        guard value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw CaptureError.message("Use an Are.na channel URL or slug.")
        }
        return value
    }
}

public enum CaptureError: LocalizedError, Sendable {
    case message(String)
    case http(Int, String)
    case rateLimited(Date)
    public var errorDescription: String? {
        switch self {
        case .message(let text): text
        case .http(401, _): "Are.na did not accept this token (HTTP 401)."
        case .http(403, _): "This account does not have access to that action."
        case .http(404, _): "This item is unavailable or private."
        case .http(_, let text): text
        case .rateLimited(let date): "Are.na is receiving too many requests. Try again after \(date.formatted(date: .omitted, time: .standard))."
        }
    }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(key: String) -> JSONValue? { if case .object(let value) = self { value[key] } else { nil } }
    public var string: String? { if case .string(let value) = self { value } else { nil } }
    public var int: Int? { if case .number(let value) = self { Int(exactly: value) } else { nil } }
    public var array: [JSONValue] { if case .array(let value) = self { value } else { [] } }
    public var object: [String: JSONValue] { if case .object(let value) = self { value } else { [:] } }
}
