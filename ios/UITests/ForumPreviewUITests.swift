import XCTest

final class ForumPreviewUITests: XCTestCase {
    func testPublicCommentPreviewShowsContentAndRetainsContextChoice() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else {
            throw XCTSkip("Set CAPTURE_LIVE_SOURCE_CHECK=1 to check a public Forum comment in the simulator.")
        }
        continueAfterFailure = false
        let store = UUID().uuidString
        let source = "https://www.lesswrong.com/posts/TJjk5TRywhgrnhzn6/andrew_critch-s-shortform?commentId=eFwRurEDaCxCLTyR4"
        func launch(_ clipboard: String) -> XCUIApplication {
            let app = XCUIApplication()
            app.launchEnvironment = ["CAPTURE_UI_FIXTURE":"empty", "CAPTURE_UI_STORE_ID":store,
                "CAPTURE_UI_LIVE_SOURCE":"1", "CAPTURE_UI_CLIPBOARD":clipboard,
                "CAPTURE_UI_CLIPBOARD_URL":"", "CAPTURE_UI_STYLE":"light"]
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 15))
            return app
        }
        let app = launch(source)
        app.buttons["capture.paste"].firstMatch.tap()
        let picker = app.descendants(matching: .any)["capture.comment-context"].firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 15))
        let body = app.staticTexts["capture.text.content"]
        let prepared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: picker)
        XCTAssertEqual(XCTWaiter.wait(for: [prepared], timeout: 60), .completed)
        XCTAssertTrue(body.waitForExistence(timeout: 10))
        let expandedText = body.label
        XCTAssertTrue(expandedText.contains("Reply to"))
        XCTAssertTrue(expandedText.contains("What's something you believe"))
        XCTAssertFalse(expandedText.contains("`"))
        XCTAssertFalse(expandedText.contains("---"))
        let expanded = XCTAttachment(screenshot: app.screenshot())
        expanded.name = "forum-native-parents"; expanded.lifetime = .keepAlways; add(expanded)
        picker.tap()
        XCTAssertTrue(app.buttons["Selected only"].waitForExistence(timeout: 5))
        app.buttons["Selected only"].tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", expandedText), object: body)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 60), .completed)
        let selectedText = body.label
        XCTAssertTrue(selectedText.contains("Reply to"))
        XCTAssertTrue(selectedText.contains("Morality is a constructed"))
        XCTAssertFalse(selectedText.contains("[Reply to"))
        XCTAssertFalse(selectedText.contains("commentId=hLcibt3RxuQXGhRK3"))
        XCTAssertLessThan(selectedText.count, expandedText.count)
        let selected = XCTAttachment(screenshot: app.screenshot())
        selected.name = "forum-native-selected"; selected.lifetime = .keepAlways; add(selected)
        app.buttons["capture.destinations"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["channel.block-preview"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["channel.done"].tap()
        app.terminate()
        let reopened = launch("")
        let restoredBody = reopened.staticTexts["capture.text.content"]
        XCTAssertTrue(restoredBody.waitForExistence(timeout: 15))
        XCTAssertEqual(restoredBody.label, selectedText)
        let restoredPicker = reopened.descendants(matching: .any)["capture.comment-context"].firstMatch
        restoredPicker.tap()
        XCTAssertTrue(reopened.buttons["Nearby replies"].waitForExistence(timeout: 5))
        reopened.buttons["Nearby replies"].tap()
        let replies = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", selectedText), object: restoredBody)
        XCTAssertEqual(XCTWaiter.wait(for: [replies], timeout: 60), .completed)
        let nearby = XCTAttachment(screenshot: reopened.screenshot())
        nearby.name = "forum-native-nearby-replies"; nearby.lifetime = .keepAlways; add(nearby)
    }
}
