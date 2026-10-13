import XCTest

final class RedditSourceFailureUITests: XCTestCase {
    private func launch(store: String, large: Bool = false, share: Bool = false, writing: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "reddit-denied"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = store
        app.launchEnvironment["CAPTURE_UI_STYLE"] = "dark"
        app.launchEnvironment["CAPTURE_UI_PRESENTATION"] = share ? "share" : "app"
        app.launchEnvironment["CAPTURE_UI_LIVE_SOURCE"] = "0"
        app.launchEnvironment["CAPTURE_UI_REDDIT_WRITING"] = writing ? "1" : "0"
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.staticTexts["Couldn’t read source"].exists || app.staticTexts["Couldn’t read this link"].exists || app.staticTexts["capture.original-link.notice"].exists
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 10), .completed)
        return app
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testDeniedSourceShareHasAccurateActionsAndSurvivesRelaunch() throws {
        let store = UUID().uuidString
        var app = launch(store: store, share: true)
        XCTAssertTrue(app.buttons["Close"].exists)
        XCTAssertTrue(app.buttons["Done"].exists)
        XCTAssertFalse(app.buttons["Stop"].exists)
        XCTAssertFalse(app.buttons["Check save status"].exists)
        XCTAssertFalse(app.buttons["Try again"].exists)
        XCTAssertFalse(app.staticTexts["0 of 2 confirmed"].exists)
        XCTAssertFalse(app.staticTexts["Save interrupted"].exists)
        XCTAssertTrue(app.buttons["capture.preparation.edit"].isHittable)
        XCTAssertTrue(app.links["capture.failed-source.open"].exists || app.buttons["capture.failed-source.open"].exists)
        XCTAssertTrue(app.staticTexts["Nothing was sent to Are.na. Your link and destinations are kept."].exists)
        shot("reddit-denied-share-regular", app)
        if #available(iOS 17.0, *) {
            try app.performAccessibilityAudit(for: [.elementDetection, .hitRegion, .sufficientElementDescription, .trait])
        }
        app.terminate()
        app = launch(store: store, share: true)
        XCTAssertFalse(app.buttons["Stop"].exists)
        XCTAssertFalse(app.buttons["Try again"].exists)
        shot("reddit-denied-share-restored", app)
    }

    func testDeniedSourceCanReturnToEditorKeepDestinationsWithoutRetry() throws {
        let store = UUID().uuidString
        var app = launch(store: store, large: true)
        shot("reddit-denied-accessibility-size", app)
        let edit = app.buttons["capture.preparation.edit"]
        for _ in 0..<4 where !edit.isHittable { app.swipeUp() }
        XCTAssertTrue(edit.isHittable); edit.tap()
        XCTAssertTrue(app.staticTexts["Couldn’t read this link"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Try again"].exists)
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        let destinations = app.buttons["capture.destinations"]
        for _ in 0..<5 where !destinations.isHittable { app.swipeDown() }
        destinations.tap()
        XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Selected")
        XCTAssertEqual(app.buttons["channel.select.103"].value as? String, "Selected")
        shot("reddit-denied-editor-destinations", app)
        app.buttons["channel.done"].tap()
        app.terminate()
        app = launch(store: store)
        XCTAssertFalse(app.buttons["Try again"].exists)
        let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
        XCTAssertTrue(source.exists)
        XCTAssertEqual(source.value as? String, "https://www.reddit.com/r/slatestarcodex/s/7iPiVUIyix")
        shot("reddit-denied-editor-restored", app)
    }

    func testDeniedSourceKeepsManualWritingAndKeyboardEditsAcrossRelaunch() {
        let store = UUID().uuidString
        var app = launch(store: store, share: true, writing: true)
        app.buttons["capture.preparation.edit"].tap()
        let title = app.descendants(matching: .any)["capture.title"].firstMatch
        let body = app.descendants(matching: .any)["capture.description"].firstMatch
        for _ in 0..<5 where !title.isHittable { app.swipeUp() }
        XCTAssertEqual(title.value as? String, "Kept title")
        XCTAssertEqual(body.value as? String, "Kept writing")
        title.tap(); title.typeText(" and revision")
        let expectedTitle = try! XCTUnwrap(title.value as? String)
        XCTAssertTrue(expectedTitle.contains("Kept title")); XCTAssertTrue(expectedTitle.contains("revision"))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        shot("reddit-denied-manual-title-keyboard", app)
        app.terminate()
        app = launch(store: store, share: true)
        let restoredTitle = app.descendants(matching: .any)["capture.title"].firstMatch
        for _ in 0..<5 where !restoredTitle.isHittable { app.swipeUp() }
        XCTAssertEqual(restoredTitle.value as? String, expectedTitle)
        XCTAssertEqual(app.descendants(matching: .any)["capture.description"].firstMatch.value as? String, "Kept writing")
        XCTAssertFalse(app.buttons["Try again"].exists)
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        shot("reddit-denied-manual-writing-restored", app)
    }

    func testOriginalLinkChoiceIsExplicitRetainsIntentAndDoesNotPublish() {
        let store = UUID().uuidString
        var app = launch(store: store, share: true, writing: true)
        let choice = app.buttons["capture.original-link.choose"]
        XCTAssertTrue(choice.isHittable)
        shot("reddit-denied-explicit-original-link-choice", app)
        choice.tap()
        XCTAssertTrue(app.staticTexts["capture.original-link.notice"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Save"].isEnabled)
        XCTAssertFalse(app.buttons["Stop"].exists)
        XCTAssertFalse(app.staticTexts["Saved to Are.na"].exists)
        XCTAssertFalse(app.staticTexts["Saving to Are.na"].exists)
        XCTAssertEqual(app.descendants(matching: .any)["capture.source.1"].firstMatch.value as? String, "https://www.reddit.com/r/slatestarcodex/s/7iPiVUIyix")
        XCTAssertEqual(app.descendants(matching: .any)["capture.title"].firstMatch.value as? String, "Kept title")
        XCTAssertEqual(app.descendants(matching: .any)["capture.description"].firstMatch.value as? String, "Kept writing")
        shot("reddit-original-link-ready-for-save", app)
        app.terminate()
        app = launch(store: store, share: true)
        XCTAssertTrue(app.staticTexts["capture.original-link.notice"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Save"].isEnabled)
        XCTAssertEqual(app.descendants(matching: .any)["capture.source.1"].firstMatch.value as? String, "https://www.reddit.com/r/slatestarcodex/s/7iPiVUIyix")
        shot("reddit-original-link-restored", app)
    }
}
