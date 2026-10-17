import XCTest

final class RedditBrowserUITests: XCTestCase {
    func testBrowserImportRetainsWritingAndPickerAcrossRelaunch() throws {
        continueAfterFailure = false
        let store = UUID().uuidString
        let capture = #"{"schema":"arena-block/reddit-browser-capture","version":1,"sourceUrl":"https://www.reddit.com/comments/abc1234/","observedAt":"2026-10-01T00:00:00Z","post":{"id":"abc1234","title":"Browser snapshot fixture","author":"reader","permalink":"/r/test/comments/abc1234/fixture/","selftext":"A browser-observed paragraph.\n\nSecond paragraph with **emphasis** and [source](https://example.com/reference).","created_utc":1700000000,"subreddit_type":"public","is_self":true}}"#
        func launch(_ incoming: String) -> XCUIApplication {
            let app = XCUIApplication()
            app.launchEnvironment = ["CAPTURE_UI_FIXTURE": "empty", "CAPTURE_UI_STORE_ID": store,
                "CAPTURE_UI_LIVE_SOURCE": "1", "CAPTURE_UI_REDDIT_CAPTURE": incoming,
                "CAPTURE_UI_CLIPBOARD": "", "CAPTURE_UI_CLIPBOARD_URL": ""]
            app.launch()
            return app
        }
        let app = launch(capture)
        let title = app.textFields["capture.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 25))
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Browser snapshot fixture"), object: title)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 25), .completed)
        XCTAssertFalse(app.buttons["Import browser capture"].exists)
        XCTAssertFalse(app.staticTexts["Using a browser-observed Reddit snapshot."].exists)
        title.tap(); title.typeText(" Kept edit")
        if app.buttons["capture.keyboard.done"].exists { app.buttons["capture.keyboard.done"].tap() }
        let destination = app.buttons["capture.destinations"]
        for _ in 0..<5 where !destination.isHittable { app.swipeDown() }
        destination.tap()
        XCTAssertTrue(app.buttons["channel.select.102"].waitForExistence(timeout: 10))
        if app.keyboards.firstMatch.exists { app.textFields["channel.search"].typeText("\n") }
        let chosenChannel = app.buttons["channel.select.102"]
        for _ in 0..<5 where !chosenChannel.isHittable { app.swipeUp() }
        XCTAssertTrue(chosenChannel.isHittable)
        if chosenChannel.value as? String != "Selected" { chosenChannel.tap() }
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Selected"), object: chosenChannel)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)
        app.buttons["channel.done"].tap()
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "reddit-browser-import-edited"; attachment.lifetime = .keepAlways; add(attachment)
        app.terminate()
        let reopened = launch("")
        let restored = reopened.textFields["capture.title"]
        XCTAssertTrue(restored.waitForExistence(timeout: 20))
        XCTAssertTrue((restored.value as? String ?? "").contains("Kept edit"))
        XCTAssertFalse(reopened.buttons["Import browser capture"].exists)
        XCTAssertFalse(reopened.staticTexts["Using a browser-observed Reddit snapshot."].exists)
        XCTAssertFalse(reopened.staticTexts["Couldn’t read this link"].exists)
        let restoredDestinations = reopened.buttons["capture.destinations"]
        for _ in 0..<5 where !restoredDestinations.isHittable { reopened.swipeDown() }
        restoredDestinations.tap()
        let restoredChannel = reopened.buttons["channel.select.102"]
        XCTAssertTrue(restoredChannel.waitForExistence(timeout: 10))
        if reopened.keyboards.firstMatch.exists { reopened.textFields["channel.search"].typeText("\n") }
        for _ in 0..<5 where !restoredChannel.isHittable { reopened.swipeUp() }
        XCTAssertEqual(restoredChannel.value as? String, "Selected")
        let restoredAttachment = XCTAttachment(screenshot: reopened.screenshot())
        restoredAttachment.name = "reddit-shared-page-destination-restored"
        restoredAttachment.lifetime = .keepAlways; add(restoredAttachment)
    }
}
