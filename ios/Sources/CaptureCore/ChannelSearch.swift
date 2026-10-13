import Foundation

/// Ranks retained channels immediately while a paged Are.na search is in flight.
/// A typo may match a word, but every query word must match somewhere in the row.
public enum ChannelSearch {
    /// Retained owned channels follow Recents without implying collaborator/following membership.
    public static func retainedBrowse(_ channels: [Channel], accountID: Int?, excluding recent: [Channel]) -> [Channel] {
        let recentIDs = Set(recent.map(\.id))
        var seen = recentIDs
        return channels.filter {
            $0.owner.type == "User" && $0.owner.id == accountID && seen.insert($0.id).inserted
        }
    }

    /// Normalization and tokenization happen once per retained snapshot. The index
    /// is value-only, so ranking can run away from the UI actor.
    public struct Index: Sendable {
        private struct Field: Sendable { let text: String; let words: [String] }
        private struct Entry: Sendable { let channel: Channel; let fields: [Field] }
        private let entries: [Entry]

        public init(_ channels: [Channel]) {
            entries = channels.map { channel in
                Entry(channel: channel, fields: [channel.title, channel.slug, channel.owner.name].map {
                    let text = normalize($0)
                    return Field(text: text, words: tokens(text))
                })
            }
        }

        public func matches(query: String) -> [Channel] {
            let words = tokens(query)
            guard !words.isEmpty else { return entries.map(\.channel) }
            return entries.enumerated().compactMap { offset, entry -> (Int, Int, Channel)? in
                if Task.isCancelled { return nil }
                var total = 0
                for word in words {
                    guard let score = entry.fields.enumerated().compactMap({ field, value -> Int? in
                        guard let match = ChannelSearch.score(word, in: value.text, parts: value.words) else { return nil }
                        return match - field * 8
                    }).max() else { return nil }
                    total += score
                }
                return (total, offset, entry.channel)
            }
            .sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 > $1.0 }
            .map(\.2)
        }
    }

    public static func matches(_ channels: [Channel], query: String) -> [Channel] {
        Index(channels).matches(query: query)
    }

    private static func normalize(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).lowercased()
    }

    private static func tokens(_ text: String) -> [String] {
        normalize(text).split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    private static func score(_ word: String, in field: String, parts: [String]) -> Int? {
        if field == word { return 100 }
        if parts.contains(word) { return 95 }
        if field.hasPrefix(word) { return 90 }
        if parts.contains(where: { $0.hasPrefix(word) }) { return 78 }
        if field.contains(word) { return 65 }
        if word.count >= 3 && parts.contains(where: { subsequence(word, in: $0) }) { return 43 }
        if word.count >= 4 && parts.contains(where: { typoDistance(word, $0) <= (word.count >= 7 ? 2 : 1) }) { return 30 }
        return nil
    }

    private static func subsequence(_ needle: String, in haystack: String) -> Bool {
        var remaining = needle[...]
        for character in haystack where !remaining.isEmpty {
            if remaining.first == character { remaining.removeFirst() }
        }
        return remaining.isEmpty
    }

    private static func typoDistance(_ left: String, _ right: String) -> Int {
        let a = Array(left), b = Array(right)
        if abs(a.count - b.count) > 2 { return 3 }
        var previous = Array(0...b.count)
        for (i, character) in a.enumerated() {
            var current = [i + 1] + Array(repeating: 0, count: b.count)
            for (j, other) in b.enumerated() {
                current[j + 1] = min(previous[j + 1] + 1, current[j] + 1, previous[j] + (character == other ? 0 : 1))
            }
            if current.min()! > 2 { return 3 }
            previous = current
        }
        return previous[b.count]
    }
}
