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
        XCTAssertTrue(app.tabBars.buttons["Active"].waitForExistence(timeout: 10))
        return app
    }
    private func element(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
    private func ids(_ app: XCUIApplication) -> Set<String> {
        Set(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "history.capture.")).allElementsBoundByIndex.map(\.identifier))
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

    func testActiveIsSeparatedAndPlacementAdditionKeepsOneLogicalItemAfterRelaunch() {
        let app = launch("connecting")
        app.tabBars.buttons["Active"].tap()
        XCTAssertTrue(app.navigationBars["Active"].waitForExistence(timeout: 3))
        let before = ids(app); XCTAssertEqual(before.count, 1)
        shot("lifecycle-active-before", app)
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(app.staticTexts["Saved captures"].waitForExistence(timeout: 3))
        XCTAssertTrue(before.isDisjoint(with: ids(app)))
        app.tabBars.buttons["Capture"].tap()
        editConnecting(app)
        XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Sent or confirmed")
        XCTAssertFalse(app.buttons["channel.select.101"].isEnabled)
        app.buttons["channel.select.103"].tap()
        app.buttons["channel.done"].tap()
        app.navigationBars.buttons["Apply"].tap()
        app.tabBars.buttons["Active"].tap()
        XCTAssertEqual(ids(app), before)
        shot("lifecycle-active-after-addition", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Active"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Active"].tap()
        XCTAssertEqual(ids(app), before)
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
        app.tabBars.buttons["Active"].tap()
        XCTAssertEqual(ids(app), before)
        app.tabBars.buttons["History"].tap()
        if app.navigationBars.buttons["History"].isHittable { app.navigationBars.buttons["History"].tap() }
        XCTAssertTrue(ids(app).isEmpty)
        app.tabBars.buttons["Active"].tap()
        shot("lifecycle-saved-addition-one-item", app)
    }

    func testLargeDarkActiveScreenKeepsNavigationAndActionsAccessible() throws {
        let app = launch("connecting", large: true)
        app.tabBars.buttons["Active"].tap()
        XCTAssertEqual(ids(app).count, 1)
        shot("lifecycle-active-large-dark", app)
        let row = element(ids(app).first!, app); row.tap()
        let add = app.buttons["history.add-placements"]; reveal(add, app)
        XCTAssertTrue(add.isEnabled)
        shot("lifecycle-detail-large-dark", app)
    }
}
