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
}
