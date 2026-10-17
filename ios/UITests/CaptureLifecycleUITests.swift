import XCTest

/// Fictional stores only. No background delivery or publication is started.
final class CaptureLifecycleUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func launch(_ mode: String, large: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = mode
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        if large {
            app.launchEnvironment["CAPTURE_UI_STYLE"] = "dark"
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        }
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["History"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.tabBars.buttons["Active"].exists)
        return app
    }
    private func element(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
    private func ids(_ app: XCUIApplication) -> Set<String> {
        Set(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "history.capture.")).allElementsBoundByIndex.map(\.identifier))
    }
    private func activeIDs(_ app: XCUIApplication) -> Set<String> {
        Set(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND value BEGINSWITH %@", "history.capture.", "Active capture,")).allElementsBoundByIndex.map(\.identifier))
    }
    private func reveal(_ item: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<6 where !item.isHittable { app.swipeUp() }
        XCTAssertTrue(item.isHittable)
    }
    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name
        attachment.lifetime = .keepAlways; add(attachment)
    }
    private func picker(_ app: XCUIApplication) {
        let destinations = app.buttons["capture.destinations"]
        reveal(destinations, app); destinations.tap()
        XCTAssertTrue(app.buttons["channel.select.103"].waitForExistence(timeout: 5))
        let searchKey = app.keyboards.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "search")).firstMatch
        if searchKey.isHittable { searchKey.tap() }
    }
    private func editConnecting(_ app: XCUIApplication) {
        let add = app.buttons["capture.add-placements"]
        reveal(add, app); add.tap()
        XCTAssertEqual(app.state, .runningForeground, "Editing placements must not open a destination link")
        XCTAssertTrue(app.buttons["capture.cancel-placements"].waitForExistence(timeout: 3))
        picker(app)
    }

    func testHistoryKeepsActiveAndSavedAccessibleAndPlacementAdditionKeepsOneLogicalItemAfterRelaunch() {
        let app = launch("connecting")
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 3))
        let before = activeIDs(app); XCTAssertEqual(before.count, 1)
        shot("lifecycle-active-before", app)
        XCTAssertTrue(app.staticTexts["Saved and canceled captures"].waitForExistence(timeout: 3))
        XCTAssertTrue(before.isSubset(of: ids(app)))
        app.tabBars.buttons["Capture"].tap()
        editConnecting(app)
        XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Sent or confirmed")
        XCTAssertFalse(app.buttons["channel.select.101"].isEnabled)
        app.buttons["channel.select.103"].tap()
        app.buttons["channel.done"].tap()
        app.navigationBars.buttons["Apply"].tap()
        app.tabBars.buttons["History"].tap()
        XCTAssertEqual(activeIDs(app), before)
        shot("lifecycle-active-after-addition", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["History"].waitForExistence(timeout: 10))
        app.tabBars.buttons["History"].tap()
        XCTAssertEqual(activeIDs(app), before)
        element(before.first!, app).tap()
        let destinations = element("capture.status.destinations", app)
        XCTAssertTrue(destinations.waitForExistence(timeout: 3)); destinations.tap()
        let added = element("placement." + before.first!.replacingOccurrences(of: "history.capture.", with: "") + ".103", app)
        XCTAssertTrue(added.waitForExistence(timeout: 3))
        XCTAssertEqual(added.value as? String, "Awaiting confirmation")
        shot("lifecycle-active-relaunched", app)
    }

    func testUnappliedSelectionSurvivesRelaunchAndCancelDoesNotAmendSave() {
        let app = launch("connecting")
        editConnecting(app)
        XCTAssertTrue(app.buttons["channel.select.102"].isEnabled)
        app.buttons["channel.select.102"].tap() // Not sent; removable.
        app.buttons["channel.select.103"].tap()
        app.buttons["channel.done"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["capture.cancel-placements"].waitForExistence(timeout: 10))
        picker(app)
        XCTAssertEqual(app.buttons["channel.select.102"].value as? String, "Not selected")
        XCTAssertEqual(app.buttons["channel.select.103"].value as? String, "Selected")
        shot("lifecycle-retained-picker", app)
        app.buttons["channel.done"].tap()
        app.buttons["capture.cancel-placements"].tap()
        XCTAssertFalse(app.buttons["capture.cancel-placements"].exists)
        editConnecting(app)
        XCTAssertEqual(app.buttons["channel.select.102"].value as? String, "Selected")
        XCTAssertEqual(app.buttons["channel.select.103"].value as? String, "Not selected")
    }

    func testCompletedCaptureMovesToActiveWithSameIdentityForAdditionalPlacement() {
        let app = launch("saved")
        app.tabBars.buttons["History"].tap()
        let before = ids(app); XCTAssertEqual(before.count, 1)
        element(before.first!, app).tap()
        app.buttons["history.add-placements"].tap()
        picker(app)
        app.buttons["channel.select.103"].tap(); app.buttons["channel.done"].tap()
        app.navigationBars.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["Processing block"].waitForExistence(timeout: 3))
        app.tabBars.buttons["History"].tap()
        if app.navigationBars.buttons["History"].isHittable { app.navigationBars.buttons["History"].tap() }
        XCTAssertEqual(activeIDs(app), before)
        XCTAssertEqual(ids(app), before)
        shot("lifecycle-saved-addition-one-item", app)
    }

    func testLargeDarkActiveScreenKeepsNavigationAndActionsAccessible() throws {
        let app = launch("connecting", large: true)
        app.tabBars.buttons["History"].tap()
        XCTAssertEqual(activeIDs(app).count, 1)
        shot("lifecycle-active-large-dark", app)
        let row = element(activeIDs(app).first!, app); row.tap()
        let add = app.buttons["history.add-placements"]; reveal(add, app)
        XCTAssertTrue(add.isEnabled)
        shot("lifecycle-detail-large-dark", app)
    }

    func testSwipeCancelKeepsSavingInterruptedAndUnconfirmedCapturesWithSameIdentityAfterRelaunch() {
        for mode in ["queued", "connecting", "partial", "unknown"] {
            let app = launch(mode)
            app.tabBars.buttons["History"].tap()
            let before = activeIDs(app)
            XCTAssertEqual(before.count, 1, mode)
            let rowID = before.first!
            let row = element(rowID, app)
            reveal(row, app); row.swipeLeft()
            let cancel = app.buttons["history.cancel." + rowID.replacingOccurrences(of: "history.capture.", with: "")]
            if cancel.waitForExistence(timeout: 1) { cancel.tap() }
            XCTAssertTrue(row.waitForExistence(timeout: 3), "Cancellation retains the logical capture")
            XCTAssertEqual(row.value as? String, "Canceled", mode)
            XCTAssertTrue(activeIDs(app).isEmpty, mode)
            shot("lifecycle-canceled-" + mode, app)
            app.terminate(); app.launch()
            XCTAssertTrue(app.tabBars.buttons["History"].waitForExistence(timeout: 10))
            app.tabBars.buttons["History"].tap()
            let restored = element(rowID, app)
            XCTAssertTrue(restored.waitForExistence(timeout: 3))
            XCTAssertEqual(restored.value as? String, "Canceled", mode)
            restored.tap()
            XCTAssertTrue(app.staticTexts["Canceled"].waitForExistence(timeout: 3))
            XCTAssertFalse(app.buttons["history.add-placements"].exists)
            XCTAssertFalse(app.buttons["history.cancel-save"].exists)
            XCTAssertFalse(app.buttons["Resume capture"].exists)
            XCTAssertFalse(app.buttons["Review save"].exists)
            XCTAssertFalse(app.buttons["capture.toolbar.continue"].exists)
            if mode == "partial" {
                XCTAssertTrue(element("placement." + rowID.replacingOccurrences(of: "history.capture.", with: "") + ".102", app).exists)
                XCTAssertTrue(app.staticTexts["1 of 3 channels confirmed"].exists)
            }
            if mode == "unknown" {
                XCTAssertTrue(app.staticTexts["No block has been confirmed. An already sent request may still have reached Are.na."].exists)
                XCTAssertFalse(app.staticTexts["No block was created."].exists)
            }
            app.terminate()
        }
    }

    func testPausedSaveCanBeSwipedToCanceledWithoutClaimingASuccessfulSave() {
        let app = launch("queued")
        app.buttons["capture.toolbar.stop"].tap()
        XCTAssertTrue(app.staticTexts["Save paused"].waitForExistence(timeout: 3))
        app.tabBars.buttons["History"].tap()
        let rowID = activeIDs(app).first!
        let row = element(rowID, app)
        row.swipeLeft()
        let cancel = app.buttons["history.cancel." + rowID.replacingOccurrences(of: "history.capture.", with: "")]
        if cancel.waitForExistence(timeout: 1) { cancel.tap() }
        XCTAssertEqual(row.value as? String, "Canceled")
        row.tap()
        XCTAssertTrue(app.staticTexts["No block was created."].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Saved to Are.na"].exists)
        XCTAssertFalse(app.buttons["Review paused save"].exists)
        shot("lifecycle-paused-canceled", app)
    }

    func testReadOnlyConfirmedSaveShowsSavedWithRetainedStopFenceAfterRelaunch() {
        let app = launch("saved-stopped")
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(activeIDs(app).isEmpty)
        let rowID = ids(app).first!
        XCTAssertEqual(element(rowID, app).value as? String, "Saved")
        element(rowID, app).tap()
        XCTAssertTrue(app.staticTexts["Saved"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Stopping"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["History"].waitForExistence(timeout: 10))
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(activeIDs(app).isEmpty)
        XCTAssertEqual(element(rowID, app).value as? String, "Saved")
        shot("lifecycle-read-only-confirmed-with-stop-fence", app)
    }
}
