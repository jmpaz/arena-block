import XCTest

/// Isolated fixture drafts only. These checks never tap Save.
final class MosaicLayoutUITests: XCTestCase {
    private func launch(_ fixture: String, store: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["CAPTURE_UI_FIXTURE": fixture, "CAPTURE_UI_STORE_ID": store]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 15))
        return app
    }

    private func control(_ app: XCUIApplication) -> XCUIElement {
        let item = app.buttons["capture.mosaic-layout"].firstMatch
        for _ in 0..<8 where !item.isHittable { app.swipeUp() }
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        return item
    }

    private func choose(_ title: String, in app: XCUIApplication) {
        control(app).tap()
        let option = app.buttons[title].firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
        let value = control(app)
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", title, title), object: value)
        XCTAssertEqual(XCTWaiter.wait(for: [chosen], timeout: 8), .completed)
    }

    func testLayoutChoicesRestoreWithoutSaving() {
        continueAfterFailure = false
        let store = UUID().uuidString, app = launch("multi-post", store: store)
        choose("Compact", in: app)
        choose("Balanced", in: app)
        choose("Source order", in: app)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "mosaic-source-order-preview"; shot.lifetime = .keepAlways; add(shot)
        app.terminate()
        let restored = launch("multi-post", store: store), choice = control(restored)
        XCTAssertTrue(choice.label.contains("Source order") || (choice.value as? String)?.contains("Source order") == true)
        restored.terminate()
    }

    func testPosterLayoutPreviewKeepsMovingVideoSelected() {
        continueAfterFailure = false
        let app = launch("mosaic-video", store: UUID().uuidString)
        choose("Source order", in: app)
        XCTAssertTrue(app.staticTexts["Layout preview · videos shown as posters"].exists)
        for _ in 0..<5 where !app.buttons["capture.media.frame.1.1"].isHittable { app.swipeDown() }
        XCTAssertTrue(app.buttons["capture.media.frame.1.1"].label.contains("Video"))
        choose("Compact", in: app)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "video-mosaic-poster-preview"; shot.lifetime = .keepAlways; add(shot)
        app.terminate()
    }
}
