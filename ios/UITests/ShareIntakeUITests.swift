import XCTest

final class ShareIntakeUITests: XCTestCase {
    private func launch(store: String, fresh: Bool = true, url: String? = nil, error: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CAPTURE_UI_FIXTURE": "ready", "CAPTURE_UI_STORE_ID": store,
            "CAPTURE_UI_COMPOSER": "share", "CAPTURE_UI_PRESENTATION": "share", "CAPTURE_UI_LIVE_SOURCE": "0",
            "CAPTURE_UI_FRESH_SHARE": fresh ? "1" : "0", "CAPTURE_UI_SHARE_DELAY_MS": "4000"]
        if fresh {
            app.launchEnvironment["CAPTURE_UI_SHARE_INTAKE"] = error ? "error" : "url"
            app.launchEnvironment["CAPTURE_UI_SHARE_URL"] = url ?? "https://example.com/new-share"
        }
        app.launch()
        return app
    }

    private func source(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["capture.source.1"].firstMatch
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testFreshShareShowsCleanLoadingAndErrorInsteadOfPriorComposer() {
        let store = UUID().uuidString
        let old = launch(store: store, fresh: false)
        XCTAssertTrue(source(old).waitForExistence(timeout: 10))
        let oldSource = source(old).value as? String
        XCTAssertFalse(oldSource?.isEmpty ?? true)
        old.terminate()
        let app = launch(store: store, error: true)
        XCTAssertTrue(app.otherElements["capture.share.loading"].waitForExistence(timeout: 3)
            || app.descendants(matching: .any)["capture.share.loading"].firstMatch.exists)
        XCTAssertFalse(source(app).exists)
        XCTAssertFalse(app.descendants(matching: .any)["capture.media.asset.1.1"].firstMatch.exists)
        shot("share-fresh-loading", app)
        XCTAssertTrue(app.alerts["Capture"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Couldn’t read the shared link. Share the page again."].exists)
        app.alerts.buttons["OK"].tap()
        XCTAssertTrue(source(app).waitForExistence(timeout: 5))
        XCTAssertNotEqual(source(app).value as? String, oldSource)
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        shot("share-fresh-error", app)
    }

    func testConsecutiveSharesAndSameLinkReopenRemainIndependentAcrossForeground() {
        let store = UUID().uuidString
        let firstURL = "https://example.com/first-share", nextURL = "https://example.com/next-share"
        var app = launch(store: store, url: firstURL)
        XCTAssertTrue(source(app).waitForExistence(timeout: 10))
        XCTAssertEqual(source(app).value as? String, firstURL)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertEqual(source(app).value as? String, firstURL)
        app.terminate()
        app = launch(store: store, url: nextURL)
        XCTAssertTrue(app.descendants(matching: .any)["capture.share.loading"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(source(app).exists)
        XCTAssertTrue(source(app).waitForExistence(timeout: 10))
        XCTAssertEqual(source(app).value as? String, nextURL)
        app.terminate()
        app = launch(store: store, url: nextURL)
        XCTAssertTrue(app.descendants(matching: .any)["capture.share.loading"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(source(app).exists)
        XCTAssertTrue(source(app).waitForExistence(timeout: 10))
        XCTAssertEqual(source(app).value as? String, nextURL)
        shot("share-consecutive-same-link", app)
    }
}
