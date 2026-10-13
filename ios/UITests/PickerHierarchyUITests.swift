import XCTest

/// Offline fixtures: no credentials or Are.na delivery.
final class PickerHierarchyUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func launch(_ mode: String = "ready", dark: Bool = false, large: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = mode
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        app.launchEnvironment["CAPTURE_UI_STYLE"] = dark ? "dark" : "light"
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        XCTAssertTrue(app.buttons["capture.destinations"].waitForExistence(timeout: 10))
        app.buttons["capture.destinations"].tap()
        XCTAssertTrue(app.textFields["channel.search"].waitForExistence(timeout: 5))
        return app
    }

    private func screenshot(_ name: String, _ app: XCUIApplication) {
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = name; capture.lifetime = .keepAlways; add(capture)
    }

    func testChannelIdentitySelectionAndClearStayConsistent() {
        let app = launch()
        let inbox = app.buttons["channel.select.101"]
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(inbox.exists)
        XCTAssertEqual(inbox.value as? String, "Selected")
        XCTAssertTrue(design.label.hasPrefix("Interface design, Morgan, Open"))
        let search = app.textFields["channel.search"]
        search.typeText("interface")
        design.tap()
        XCTAssertEqual(design.value as? String, "Selected")
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 9))
        let selected = app.buttons["channel.list-mode"]
        XCTAssertEqual(selected.label, "Review 2 selected channels")
        XCTAssertGreaterThanOrEqual(selected.frame.height, 44)
        selected.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .withOffset(CGVector(dx: -21, dy: 21)).tap()
        XCTAssertEqual(selected.value as? String, "Selected channels")
        XCTAssertEqual(inbox.value as? String, "Selected")
        screenshot("picker-selected-light", app)
        let clear = app.buttons["channel.clear"]
        XCTAssertGreaterThanOrEqual(clear.frame.height, 44)
        clear.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .withOffset(CGVector(dx: -21, dy: -21)).tap()
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 1 channel")
        XCTAssertEqual(selected.label, "Review 1 selected channels")
        selected.tap()
        XCTAssertEqual(design.value as? String, "Not selected")
        XCTAssertEqual(inbox.value as? String, "Selected")
        app.buttons["channel.done"].tap()
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
    }

    func testAlwaysIncludedDefaultAppearsOnceAndCannotBeCleared() {
        let app = launch("always-default")
        XCTAssertFalse(app.buttons["channel.select.101"].exists)
        let design = app.buttons["channel.select.102"]
        design.tap()
        app.buttons["channel.list-mode"].tap()
        let pinned = app.descendants(matching: .any)["channel.always-included"].firstMatch
        XCTAssertTrue(pinned.waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 2 channels")
        app.buttons["channel.clear"].tap()
        XCTAssertTrue(pinned.exists)
        XCTAssertFalse(app.buttons["channel.clear"].isEnabled)
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 1 channel")
        XCTAssertTrue(app.buttons["channel.connect"].isEnabled)
        screenshot("picker-always-included-after-clear", app)
        app.buttons["channel.done"].tap()
        app.buttons["capture.destinations"].tap()
        XCTAssertFalse(app.buttons["channel.select.101"].exists)
        XCTAssertEqual(app.buttons["channel.select.102"].value as? String, "Not selected")
    }

    func testSearchFocusAndStablePreviewWithKeyboard() {
        let app = launch()
        let search = app.textFields["channel.search"]
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let preview = app.descendants(matching: .any)["channel.block-preview"].firstMatch
        XCTAssertTrue(preview.isHittable)
        search.typeText("Interface")
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.waitForExistence(timeout: 5)); XCTAssertTrue(design.isHittable)
        XCTAssertLessThanOrEqual(search.frame.maxY, app.buttons["channel.clear"].frame.minY)
        XCTAssertLessThanOrEqual(search.frame.height, 60)
        design.tap()
        XCTAssertEqual(design.value as? String, "Selected")
        XCTAssertTrue(preview.isHittable)
        screenshot("picker-keyboard-selection", app)
    }

    func testChangingSearchDoesNotShowOldResultsAndRetainsSelection() {
        let app = launch()
        let search = app.textFields["channel.search"]
        search.typeText("Interface")
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.waitForExistence(timeout: 5)); design.tap()
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 9) + "Visual")
        XCTAssertEqual(search.value as? String, "Visual")
        XCTAssertTrue(app.buttons["channel.select.103"].waitForExistence(timeout: 5))
        XCTAssertFalse(design.exists)
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "Interface")
        XCTAssertEqual(search.value as? String, "Interface")
        XCTAssertTrue(design.waitForExistence(timeout: 5))
        XCTAssertEqual(design.value as? String, "Selected")
        screenshot("picker-repeated-search-retains-selection", app)
    }

    func testLargeDarkSearchKeepsPreviewResultAndActionsReachable() {
        let app = launch(dark: true, large: true)
        let search = app.textFields["channel.search"]
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["channel.block-preview"].firstMatch.isHittable)
        search.typeText("Interface")
        let result = app.buttons["channel.select.102"]
        let save = app.buttons["channel.connect"]
        let options = app.buttons["channel.selection-options"]
        XCTAssertTrue(result.waitForExistence(timeout: 5)); XCTAssertTrue(result.isHittable)
        XCTAssertLessThanOrEqual(search.frame.height, 100)
        XCTAssertGreaterThan(search.frame.width, 120)
        XCTAssertLessThanOrEqual(result.frame.maxY, search.frame.minY)
        XCTAssertLessThanOrEqual(search.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        XCTAssertTrue(save.isHittable)
        XCTAssertGreaterThanOrEqual(save.frame.height, 44)
        XCTAssertTrue(options.isHittable)
        XCTAssertGreaterThanOrEqual(options.frame.height, 28)
        result.tap()
        XCTAssertEqual(result.value as? String, "Selected")
        screenshot("picker-large-dark-keyboard", app)
        options.tap()
        let clear = app.buttons["channel.clear"]
        XCTAssertTrue(clear.waitForExistence(timeout: 3)); XCTAssertTrue(clear.isHittable)
        screenshot("picker-large-selection-actions", app)
        clear.tap()
        XCTAssertFalse(save.isEnabled)
        XCTAssertEqual(result.value as? String, "Not selected")
        // Current Apple HIG: 44-point default, 28-point minimum. Verify
        // the system toolbar menu at the corners of its minimum hit region.
        for offset in [CGVector(dx: -13, dy: -13), CGVector(dx: 13, dy: -13),
                       CGVector(dx: -13, dy: 13), CGVector(dx: 13, dy: 13)] {
            options.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                .withOffset(offset).tap()
            let mode = app.buttons["channel.list-mode"]
            XCTAssertTrue(mode.waitForExistence(timeout: 3), "Native menu missed the 28-point hit region at \(offset)")
            mode.tap()
        }
    }
}
