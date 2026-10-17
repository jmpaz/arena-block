import Foundation

enum CaptureMarkdownPreview {
    struct Block {
        var text: AttributedString
        let quoteDepth: Int
        let listDepth: Int
        let marker: String?
        let isCode: Bool
        let isRule: Bool
    }

    static func blocks(_ markdown: String) -> [Block] {
        guard let parsed = try? AttributedString(markdown: markdown,
                                                options: .init(interpretedSyntax: .full)) else {
            return [Block(text: AttributedString(markdown), quoteDepth: 0, listDepth: 0, marker: nil, isCode: false, isRule: false)]
        }
        var result: [Block] = []
        var previousIdentity: Int?
        var emittedListItems = Set<Int>()
        for run in parsed.runs {
            let components = run.presentationIntent?.components ?? []
            let identity = components.first?.identity ?? 0
            let quoteDepth = components.filter { if case .blockQuote = $0.kind { return true }; return false }.count
            let listDepth = components.filter {
                switch $0.kind { case .orderedList, .unorderedList: return true; default: return false }
            }.count
            var listItem: (identity: Int, ordinal: Int)?
            var isCode = false
            var isRule = false
            for component in components {
                switch component.kind {
                case .listItem(let ordinal):
                    if listItem == nil { listItem = (component.identity, ordinal) }
                case .codeBlock: isCode = true
                case .thematicBreak: isRule = true
                default: break
                }
            }
            // The nearest container determines the marker for nested mixed lists.
            let list = components.first {
                switch $0.kind { case .orderedList, .unorderedList: return true; default: return false }
            }
            let ordered = list.map { if case .orderedList = $0.kind { return true }; return false } ?? false
            var fragment = AttributedString(parsed[run.range])
            if run.inlinePresentationIntent?.contains(.softBreak) == true {
                fragment = AttributedString("\n")
            }
            if identity == previousIdentity, !result.isEmpty {
                result[result.count - 1].text.append(fragment)
            } else {
                let marker: String?
                if let listItem, emittedListItems.insert(listItem.identity).inserted {
                    marker = ordered ? "\(listItem.ordinal)." : "•"
                } else { marker = nil }
                result.append(Block(text: fragment, quoteDepth: quoteDepth, listDepth: listDepth, marker: marker, isCode: isCode, isRule: isRule))
                previousIdentity = identity
            }
        }
        return result
    }

    static func render(_ markdown: String) -> AttributedString {
        // The source Markdown remains intact for editing and publication.
        var result = AttributedString()
        for block in blocks(markdown) where !block.isRule {
            if !result.characters.isEmpty { result.append(AttributedString("\n\n")) }
            if let marker = block.marker { result.append(AttributedString(marker + " ")) }
            result.append(block.text)
        }
        return result
    }
}
