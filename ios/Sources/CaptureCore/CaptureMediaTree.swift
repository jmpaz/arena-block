import Foundation

public struct CaptureMediaSource: Sendable {
    public let source: JSONValue
    public let rootIndex: Int
    public let quoteDepth: Int
    public var media: [JSONValue] {
        let assets = source["media"]?.array ?? []
        guard quoteDepth > 0 else { return assets }
        return assets.filter { asset in
            guard ["image", "video", "audio"].contains(asset["kind"]?.string ?? ""), asset["sourceRole"]?.string != "preview",
                  let ref = asset["ref"]?.string else { return false }
            return ref.hasPrefix("\(rootIndex + 1).") && ref.range(of: #"^\d+\.[1-9]\d*$"#, options: .regularExpression) != nil
        }
    }
    public var ownershipLabel: String? {
        guard quoteDepth > 0, let handle = source["author"]?["handle"]?.string else { return nil }
        let name = handle.hasPrefix("@") ? String(handle.dropFirst()) : handle
        return "Quoted from \(source["provider"]?.string == "reddit" ? name : "@" + name)"
    }
}

public enum CaptureMediaTree {
    public static func quoteDepth(in plan: JSONValue) -> Int {
        if plan["policy"]?["quote"]?.string == "omit" { return 0 }
        if plan["policy"]?["quoteDepth"]?.string == "full" { return 8 }
        return min(8, max(0, plan["policy"]?["quoteDepth"]?.int ?? 2))
    }
    public static func sources(in sources: JSONValue, maximumDepth: Int = 8) -> [CaptureMediaSource] {
        var result: [CaptureMediaSource] = []
        for (rootIndex, root) in sources.array.enumerated() {
            var node: JSONValue? = root
            for depth in 0...min(8, max(0, maximumDepth)) {
                guard let source = node, !source.object.isEmpty else { break }
                result.append(.init(source: source, rootIndex: rootIndex, quoteDepth: depth))
                node = source["quote"]
            }
        }
        return result
    }
    public static func sources(inPlan plan: JSONValue) -> [CaptureMediaSource] {
        sources(in: plan["sources"] ?? .array([]), maximumDepth: quoteDepth(in: plan))
    }
    public static func media(in plan: JSONValue) -> [JSONValue] {
        sources(inPlan: plan).flatMap(\.media)
    }
    public static func videoSoundtrackSources(in plan: JSONValue) -> [CaptureMediaSource] {
        let selected = Set((plan["block"]?["selectedMedia"]?.array ?? []).compactMap(\.string))
        let frames = Set((plan["block"]?["frameMedia"]?.array ?? []).compactMap { $0["ref"]?.string })
        return sources(inPlan: plan).compactMap { node in
            let media = node.media.filter { asset in
                guard let ref = asset["ref"]?.string else { return false }
                return asset["kind"]?.string == "video" && selected.contains(ref) && !frames.contains(ref)
            }
            guard !media.isEmpty else { return nil }
            var source = node.source.object; source["media"] = .array(media)
            return .init(source:.object(source),rootIndex:node.rootIndex,quoteDepth:node.quoteDepth)
        }
    }
}
