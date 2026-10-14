import Foundation

enum CaptureMarkdownPreview {
    static func render(_ markdown: String) -> AttributedString {
        // The source Markdown remains intact for editing and publication.
        let preview = markdown.replacingOccurrences(
            of: #"(?m)^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$"#,
            with: "",
            options: .regularExpression
        )
        return (try? AttributedString(markdown: preview,
                                      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(preview)
    }
}
