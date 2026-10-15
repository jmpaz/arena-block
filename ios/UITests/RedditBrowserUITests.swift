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
        XCTAssertTrue(app.staticTexts["Using a browser-observed Reddit snapshot."].exists)
        title.tap(); title.typeText(" Kept edit")
        if app.buttons["capture.keyboard.done"].exists { app.buttons["capture.keyboard.done"].tap() }
        let destination = app.buttons["capture.destinations"]
        for _ in 0..<5 where !destination.isHittable { app.swipeDown() }
        destination.tap()
        XCTAssertTrue(app.buttons["channel.select.102"].waitForExistence(timeout: 10))
        app.buttons["channel.select.102"].tap()
        app.buttons["channel.done"].tap()
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "reddit-browser-import-edited"; attachment.lifetime = .keepAlways; add(attachment)
        app.terminate()
        let reopened = launch("")
        let restored = reopened.textFields["capture.title"]
        XCTAssertTrue(restored.waitForExistence(timeout: 20))
        XCTAssertTrue((restored.value as? String ?? "").contains("Kept edit"))
        XCTAssertTrue(reopened.staticTexts["Using a browser-observed Reddit snapshot."].exists)
        XCTAssertTrue(reopened.staticTexts["Interface design"].exists)
        XCTAssertFalse(reopened.staticTexts["Couldn’t read this link"].exists)
    }
}
