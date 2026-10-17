import XCTest

final class StorageReportUITests: XCTestCase {
    private func application(delay: Int = 0) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CAPTURE_UI_FIXTURE": "ready", "CAPTURE_UI_STORE_ID": UUID().uuidString,
            "CAPTURE_UI_LIVE_SOURCE": "0", "CAPTURE_UI_CLIPBOARD": "", "CAPTURE_UI_CLIPBOARD_URL": "",
            "CAPTURE_UI_STORAGE_REPORT_DELAY_MS": String(delay)]
        print("Storage report fixture: \(app.launchEnvironment["CAPTURE_UI_STORE_ID"]!)")
        return app
    }

    private func report(_ app: XCUIApplication, isolated: Bool) {
        XCTAssertTrue(app.buttons["storage-report.create"].waitForExistence(timeout: 10), app.debugDescription)
        let notice = isolated ? "iOS and the Share extension may continue existing transfers."
            : "Automatic foreground checks are paused. Existing save processing may continue through the queue."
        XCTAssertTrue(app.staticTexts[notice].exists, app.debugDescription)
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-hierarchy"; tree.lifetime = .keepAlways; add(tree)
    }

    private func reveal(_ item: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<6 where !item.isHittable { app.swipeUp() }
        XCTAssertTrue(item.isHittable, app.debugDescription)
    }

    private func openWarmReport(_ app: XCUIApplication) -> (source: String, title: String, description: String) {
        app.launch()
        let source = app.textFields["capture.source.1"]
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        let input = source.value as? String ?? ""
        let title = app.textFields["capture.title"]
        reveal(title, app)
        let titleText = title.value as? String ?? ""
        let description = app.textFields["capture.description"]
        reveal(description, app)
        let before = (source: input, title: titleText, description: description.value as? String ?? "")
        XCTAssertFalse(before.source.isEmpty); XCTAssertFalse(before.description.isEmpty)
        app.tabBars.buttons["Settings"].tap()
        let export = app.buttons["Export storage report"]
        for _ in 0..<6 where !export.isHittable { app.swipeUp() }
        XCTAssertTrue(export.isHittable); export.tap()
        report(app, isolated: false)
        return before
    }

    private func assertRetained(_ before: (source: String, title: String, description: String), _ app: XCUIApplication) {
        let source = app.textFields["capture.source.1"]
        for _ in 0..<6 where !source.isHittable { app.swipeDown() }
        XCTAssertTrue(source.isHittable)
        XCTAssertEqual(source.value as? String, before.source)
        let title = app.textFields["capture.title"]
        reveal(title, app); XCTAssertEqual(title.value as? String, before.title)
        let description = app.textFields["capture.description"]
        reveal(description, app); XCTAssertEqual(description.value as? String, before.description)
    }

    private func confirmReturn(_ app: XCUIApplication) {
        reveal(app.buttons["storage-report.open"], app)
        app.buttons["storage-report.open"].tap()
        let confirm = app.buttons.matching(identifier: "storage-report.confirm-open").element(boundBy: 0)
        XCTAssertTrue(confirm.waitForExistence(timeout: 3), app.debugDescription)
        confirm.tap()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["storage-report.create"].exists)
    }

    func testColdURLRemainsIsolatedAcrossBackgroundAndActivation() {
        let app = application()
        if app.state != .notRunning { app.terminate() }
        app.open(URL(string: "arena-capture://storage-report")!)
        report(app, isolated: true)
        XCTAssertFalse(app.tabBars.buttons["Capture"].exists)
        shot("storage-cold-url", app)
        XCUIDevice.shared.press(.home); app.activate()
        report(app, isolated: true)
        XCTAssertFalse(app.tabBars.buttons["Capture"].exists)
        shot("storage-cold-reactivated", app)
        app.terminate()
    }

    func testColdCollectionAndFilesCancellationDoNotOpenCapture() {
        let app = application()
        if app.state != .notRunning { app.terminate() }
        app.open(URL(string: "arena-capture://storage-report")!)
        report(app, isolated: true)
        app.buttons["storage-report.create"].tap()
        let export = app.buttons["storage-report.export"]
        XCTAssertTrue(export.waitForExistence(timeout: 15), app.debugDescription)
        shot("storage-cold-collected", app)
        export.tap()
        let picker = app.navigationBars["FullDocumentManagerViewControllerNavigationBar"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10), app.debugDescription)
        picker.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        XCTAssertTrue(picker.waitForNonExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(export.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["iOS and the Share extension may continue existing transfers."].exists)
        XCTAssertFalse(app.tabBars.buttons["Capture"].exists)
        reveal(app.buttons["storage-report.open"], app)
        app.buttons["storage-report.open"].tap()
        let confirmation = app.buttons.matching(identifier: "storage-report.confirm-open").element(boundBy: 0)
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
        // This compact popover cancels when the user taps outside its action.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.25)).tap()
        XCTAssertTrue(confirmation.waitForNonExistence(timeout: 3))
        XCTAssertTrue(export.exists)
        XCTAssertFalse(app.tabBars.buttons["Capture"].exists)
        shot("storage-cold-files-and-open-canceled", app)
        confirmReturn(app)
        app.terminate()
    }

    func testWarmCollectionCancellationAndActivationRetainPreviewUntilConfirmedReturn() {
        let app = application(delay: 5_000)
        let before = openWarmReport(app)
        app.buttons["storage-report.create"].tap()
        let cancel = app.buttons["storage-report.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 3)); cancel.tap()
        report(app, isolated: false)
        XCTAssertTrue(app.staticTexts["Report canceled."].exists)
        XCUIDevice.shared.press(.home); app.activate()
        report(app, isolated: false)
        XCTAssertTrue(app.staticTexts["Report canceled."].exists)
        shot("storage-warm-collection-canceled-reactivated", app)
        confirmReturn(app)
        app.tabBars.buttons["Capture"].tap()
        assertRetained(before, app)
        shot("storage-warm-preview-retained", app)
        app.terminate()
    }

    func testWarmFilesExportReturnsToReportAndRetainsPreview() {
        let app = application()
        let before = openWarmReport(app)
        app.buttons["storage-report.create"].tap()
        let export = app.buttons["storage-report.export"]
        XCTAssertTrue(export.waitForExistence(timeout: 15), app.debugDescription); export.tap()
        let save = app.navigationBars["FullDocumentManagerViewControllerNavigationBar"].buttons["Save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10), app.debugDescription)
        let filename = app.textFields["DOCPicker.filenameTextField"]
        if filename.exists {
            filename.tap()
            filename.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 80) + "Capture-report-" + UUID().uuidString)
        }
        if !save.isEnabled {
            let local = app.staticTexts["On My iPhone"].firstMatch
            XCTAssertTrue(local.waitForExistence(timeout: 5), app.debugDescription); local.tap()
        }
        XCTAssertTrue(save.isEnabled, app.debugDescription); save.tap()
        XCTAssertTrue(app.staticTexts["Report saved to Files."].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["storage-report.confirm-open"].exists)
        shot("storage-files-saved-report-still-open", app)
        confirmReturn(app)
        app.tabBars.buttons["Capture"].tap()
        assertRetained(before, app)
        app.terminate()
    }
}
