import Foundation
import XCTest
@testable import CaptureUI

final class CaptureMarkdownPreviewTests: XCTestCase {
    func testReplyLinkShowsLabelAndKeepsSourceTarget() {
        let source = URL(string: "https://www.lesswrong.com/posts/TJjk5TRywhgrnhzn6/?commentId=hLcibt3RxuQXGhRK3")!
        let markdown = "*[Reply to comment hLcibt3RxuQXGhRK3](<\(source.absoluteString)>)*\n\nAuthored comment text"
        let preview = CaptureMarkdownPreview.render(markdown)
        let visible = String(preview.characters)

        XCTAssertEqual(visible, "Reply to comment hLcibt3RxuQXGhRK3\n\nAuthored comment text")
        XCTAssertEqual(preview.runs.compactMap(\.link), [source])
        XCTAssertFalse(visible.contains("lesswrong.com"))
    }

    func testMultipleCommentsShowNamesAndBodiesWithoutMarkdownDelimiters() {
        let markdown = "`@Nanashi` (2015-05-27)\nFirst **authored** response.\n\n---\n\n`@estimator` (2015-05-27)\nSecond _authored_ response."
        let visible = String(CaptureMarkdownPreview.render(markdown).characters)

        XCTAssertTrue(visible.contains("@Nanashi (2015-05-27)\nFirst authored response."))
        XCTAssertTrue(visible.contains("@estimator (2015-05-27)\nSecond authored response."))
        XCTAssertFalse(visible.contains("---"))
        XCTAssertFalse(visible.contains("`"))
    }

    func testQuotesListsAndOuterWritingHaveSeparateSemanticBlocks() {
        let source = URL(string: "https://substack.com/@lamblog/note/c-359890078")!
        let markdown = "> [`@lamblog`](\(source)) (Oct 13, 2026)\n>\n> First *quoted* paragraph.\n>\n> - First point\n> - Second point\n>\n>> Nested quote\n\nOuter authored paragraph."
        let blocks = CaptureMarkdownPreview.blocks(markdown)
        XCTAssertEqual(blocks.map(\.quoteDepth), [1, 1, 1, 1, 2, 0])
        XCTAssertEqual(blocks.map { String($0.text.characters) }, ["@lamblog (Oct 13, 2026)", "First quoted paragraph.", "First point", "Second point", "Nested quote", "Outer authored paragraph."])
        XCTAssertEqual(blocks.map(\.marker), [nil, nil, "•", "•", nil, nil])
        XCTAssertEqual(blocks[0].text.runs.compactMap(\.link), [source])
        XCTAssertFalse(String(CaptureMarkdownPreview.render(markdown).characters).contains(">"))
    }

    func testLiteralQuoteAndDividerSyntaxInsideCodeRemainAuthoredText() {
        let markdown = "Escaped \\> literal\nnext line\n\n```text\n> keep code\n---\n```\n\n---\n\n1. First\n2. Second"
        let blocks = CaptureMarkdownPreview.blocks(markdown)
        XCTAssertEqual(String(blocks[0].text.characters), "Escaped > literal\nnext line")
        XCTAssertTrue(blocks[1].isCode)
        XCTAssertEqual(blocks[1].quoteDepth, 0)
        XCTAssertTrue(String(blocks[1].text.characters).contains("> keep code\n---"))
        XCTAssertTrue(blocks[2].isRule)
        XCTAssertEqual(Array(blocks.suffix(2)).map(\.marker), ["1.", "2."])
    }

    func testNestedMixedListsKeepChildDepthAndContinuationParagraphs() {
        let markdown = "> - Parent\n>   1. Child\n>\n>      Child continuation\n>\n>      - Grandchild\n> - Sibling"
        let blocks = CaptureMarkdownPreview.blocks(markdown)
        XCTAssertEqual(blocks.map { String($0.text.characters) }, ["Parent", "Child", "Child continuation", "Grandchild", "Sibling"])
        XCTAssertEqual(blocks.map(\.listDepth), [1, 2, 2, 3, 1])
        XCTAssertEqual(blocks.map(\.marker), ["•", "1.", nil, "•", "•"])
        XCTAssertEqual(blocks.map(\.quoteDepth), [1, 1, 1, 1, 1])
    }

    func testParentItemResumesAfterNestedListWithoutRepeatingItsNumber() {
        let blocks = CaptureMarkdownPreview.blocks("1. Parent\n\n   - Child\n\n   Parent continuation\n2. Next")
        XCTAssertEqual(blocks.map { String($0.text.characters) }, ["Parent", "Child", "Parent continuation", "Next"])
        XCTAssertEqual(blocks.map(\.listDepth), [1, 2, 1, 1])
        XCTAssertEqual(blocks.map(\.marker), ["1.", "•", nil, "2."])
    }
}
