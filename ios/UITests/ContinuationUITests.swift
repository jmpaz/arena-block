import XCTest

/// Fictional DEBUG fixtures; fixture Save commits locally and never starts delivery.
final class ContinuationUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func launch(_ mode: String, dark: Bool = false, large: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = mode
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        app.launchEnvironment["CAPTURE_UI_STYLE"] = dark ? "dark" : "light"
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 10))
        return app
    }

    private func element(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
    private func placement(_ id: Int, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "placement.", ".\(id)")).firstMatch
    }
    private func historyIDs(_ app: XCUIApplication) -> Set<String> {
        Set(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "history.capture.")).allElementsBoundByIndex.map(\.identifier))
    }
    private func reveal(_ item: XCUIElement, _ app: XCUIApplication, up: Bool = true) {
        for _ in 0..<6 where !item.isHittable { if up { app.swipeUp() } else { app.swipeDown() } }
        XCTAssertTrue(item.isHittable)
    }
    private func screenshot(_ name: String, _ app: XCUIApplication) {
        let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = name; capture.lifetime = .keepAlways; add(capture)
    }
    private func openPicker(_ app: XCUIApplication) {
        let button = app.buttons["capture.destinations"]; reveal(button, app, up: false); button.tap()
        XCTAssertTrue(app.buttons["channel.select.102"].waitForExistence(timeout: 5))
    }
    private func closeSearch(_ app: XCUIApplication) {
        let search = app.textFields["channel.search"]
        let clear = search.buttons["Clear text"]
        if clear.exists { clear.tap() }
        let searchKey = app.keyboards.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "search")).firstMatch
        if searchKey.isHittable { searchKey.tap() }
        XCTAssertTrue(app.buttons["channel.done"].waitForExistence(timeout: 3))
    }
    private func reviewSelected(_ app: XCUIApplication) {
        let selected = app.buttons["channel.list-mode"]
        XCTAssertTrue(selected.waitForExistence(timeout: 3))
        if selected.value as? String != "Selected channels" { selected.tap() }
        XCTAssertEqual(selected.value as? String, "Selected channels")
    }
    private func openSavedHistory(_ app: XCUIApplication) {
        app.tabBars.buttons["History"].tap()
        let row = app.cells.containing(.staticText, identifier: "Saved").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 3)); row.tap()
    }

    func testPartialPlacementsAreVisibleBeforeTheBlock() {
        let app = launch("partial")
        XCTAssertTrue(app.staticTexts["Save interrupted"].isHittable)
        XCTAssertEqual(placement(102, app).value as? String, "Confirmed")
        XCTAssertEqual(placement(103, app).value as? String, "Awaiting confirmation")
        XCTAssertTrue(placement(102, app).isHittable)
        XCTAssertTrue(placement(103, app).isHittable)
        XCTAssertFalse(app.staticTexts["Saved to Are.na"].exists)
        XCTAssertTrue(app.buttons["Check save status"].isHittable)
        screenshot("20-partial-before-block", app)
    }

    func testInspectedUnknownRetryReopensReplacementAndRetainsEarlierOutcome() {
        let app = launch("unknown")
        let earlierID = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "capture.check.")).firstMatch.identifier.replacingOccurrences(of: "capture.check.", with: "")
        let inspect = app.buttons["I checked Are.na…"]
        reveal(inspect, app)
        screenshot("30-unknown-before-inspected-retry", app)
        inspect.tap()
        app.buttons["I checked; save again"].tap()
        XCTAssertTrue(element("capture.title", app).waitForExistence(timeout: 5))
        XCTAssertFalse(element("capture.previous", app).exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 10))
        let title = element("capture.title", app)
        reveal(title, app)
        XCTAssertEqual(title.value as? String, "A study in shape")
        screenshot("31-replacement-after-inspected-retry-and-relaunch", app)
        app.tabBars.buttons["History"].tap()
        element("history.capture.\(earlierID)", app).tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "remains unconfirmed")).firstMatch.waitForExistence(timeout: 5))
        screenshot("32-retained-unknown-after-inspected-retry", app)
    }

    func testWritingMediaAndSelectionThroughSearchSurviveProcessRelaunch() {
        let app = launch("media-selection")
        let title = element("capture.title", app)
        reveal(title, app); title.tap(); title.typeText(" retained title")
        app.buttons["capture.keyboard.done"].tap()
        XCTAssertTrue((title.value as? String)?.contains("retained title") == true)
        let writing = element("capture.description", app)
        reveal(writing, app); writing.tap(); writing.typeText(" retained writing")
        app.buttons["capture.keyboard.done"].tap()
        XCTAssertTrue((writing.value as? String)?.contains("retained writing") == true)
        screenshot("writing-before-media-selection", app)
        let media = app.buttons["capture.media.all"]
        reveal(media, app, up: false); media.tap()
        openPicker(app)
        app.buttons["channel.select.102"].tap()
        let search = app.textFields["channel.search"]
        search.tap(); search.typeText("Visual")
        let visual = app.buttons["channel.select.103"]
        XCTAssertTrue(visual.waitForExistence(timeout: 5)); visual.tap()
        XCTAssertEqual(visual.value as? String, "Selected")
        screenshot("21-selection-through-search", app)
        closeSearch(app); app.buttons["channel.done"].tap()
        screenshot("22-writing-before-relaunch", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 10))
        let restoredTitle = element("capture.title", app)
        reveal(restoredTitle, app)
        XCTAssertTrue((restoredTitle.value as? String)?.contains("retained title") == true)
        let restoredWriting = element("capture.description", app)
        reveal(restoredWriting, app)
        XCTAssertTrue((restoredWriting.value as? String)?.contains("retained writing") == true)
        let restoredMedia = app.buttons["capture.media.asset.1.1"]
        reveal(restoredMedia, app, up: false)
        XCTAssertEqual(restoredMedia.value as? String, "Included")
        screenshot("23-writing-media-after-relaunch", app)
        openPicker(app)
        reviewSelected(app)
        XCTAssertEqual(app.buttons["channel.select.102"].value as? String, "Selected")
        XCTAssertEqual(app.buttons["channel.select.103"].value as? String, "Selected")
        XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Selected")
        screenshot("24-selection-after-relaunch", app)
    }

    func testContinuingRetainsPartialResultAndEmptyDraftAcrossRelaunch() {
        let app = launch("partial")
        let confirmedID = placement(102, app).identifier
        let earlierID = confirmedID.split(separator: ".")[1]
        app.buttons["capture.new"].tap()
        XCTAssertFalse(element("capture.previous", app).exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 10))
        let input = element("capture.source.1", app)
        XCTAssertTrue(["", "Paste a link"].contains(input.value as? String ?? "unknown"))
        XCTAssertTrue(app.buttons["capture.destinations"].label.contains("Inbox"))
        app.tabBars.buttons["History"].tap()
        element("history.capture.\(earlierID)", app).tap()
        XCTAssertTrue(app.staticTexts["Save interrupted"].waitForExistence(timeout: 3))
        XCTAssertEqual(element(confirmedID, app).value as? String, "Confirmed")
        XCTAssertEqual(placement(103, app).value as? String, "Awaiting confirmation")
        screenshot("25-retained-partial-after-new-and-relaunch", app)
    }

    func testAddPlacementsUsesExistingBlockAndRetainsPriorResult() {
        let app = launch("saved")
        openSavedHistory(app)
        app.buttons["history.add-placements"].tap()
        XCTAssertFalse(app.navigationBars.buttons["Apply"].isEnabled)
        XCTAssertTrue(app.staticTexts["A study in shape"].exists)
        openPicker(app)
        app.textFields["channel.search"].tap(); app.textFields["channel.search"].typeText("Visual")
        let visual = app.buttons["channel.select.103"]
        XCTAssertTrue(visual.waitForExistence(timeout: 5)); XCTAssertTrue(visual.isHittable)
        visual.tap(); XCTAssertEqual(visual.value as? String, "Selected")
        app.buttons["channel.done"].tap()
        XCTAssertTrue(app.navigationBars.buttons["Apply"].isEnabled)
        app.navigationBars.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["Processing block"].waitForExistence(timeout: 5))
        XCTAssertEqual(placement(103, app).value as? String, "Awaiting confirmation")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "capture.open.")).firstMatch.exists)
        XCTAssertFalse(element("capture.previous", app).exists)
        screenshot("26-existing-block-placement-operation", app)
    }

    func testPickerSelectionsReopenAndExplicitEmptyStaysEmpty() {
        let app = launch("ready"); openPicker(app)
        let design = app.buttons["channel.select.102"]
        design.tap()
        let search = app.textFields["channel.search"]
        search.tap(); search.typeText("Visual")
        let visual = app.buttons["channel.select.103"]
        XCTAssertTrue(visual.waitForExistence(timeout: 5)); visual.tap()
        XCTAssertEqual(visual.value as? String, "Selected")
        closeSearch(app)
        for _ in 0..<3 {
            app.buttons["channel.done"].tap(); openPicker(app)
            XCTAssertEqual(design.value as? String, "Selected")
            XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Selected")
            reviewSelected(app)
            XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Selected")
            closeSearch(app)
        }
        design.tap()
        let searchAgain = app.textFields["channel.search"]
        searchAgain.tap(); searchAgain.typeText("Visual")
        app.buttons["channel.select.103"].tap()
        closeSearch(app)
        reviewSelected(app)
        app.buttons["channel.select.101"].tap(); app.buttons["channel.done"].tap()
        XCTAssertFalse(app.navigationBars.buttons["Save"].isEnabled)
        openPicker(app)
        XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Not selected")
        for id in [102, 103] { XCTAssertEqual(app.buttons["channel.select.\(id)"].value as? String, "Not selected") }
        screenshot("27-explicit-empty-after-reopen", app)
    }

    func testCancelPlacementsDoesNotAddHistoryDraftAfterRelaunch() {
        let app = launch("saved")
        XCTAssertTrue(element("capture.saved-notice", app).waitForExistence(timeout: 3))
        openSavedHistory(app)
        app.navigationBars.buttons["History"].tap()
        let before = historyIDs(app)
        XCTAssertEqual(before.count, 1)
        element(before.first!, app).tap()
        app.buttons["history.add-placements"].tap()
        openPicker(app); app.buttons["channel.select.103"].tap(); app.buttons["channel.done"].tap()
        app.buttons["capture.cancel-placements"].tap()
        app.tabBars.buttons["History"].tap()
        app.navigationBars.buttons["History"].tap()
        XCTAssertEqual(historyIDs(app), before)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["History"].waitForExistence(timeout: 10))
        app.tabBars.buttons["History"].tap()
        XCTAssertEqual(historyIDs(app), before)
    }

    func testSwipeAndDetailDraftDeletionRemainRecoverable() {
        let app = launch("ready")
        app.tabBars.buttons["History"].tap()
        let draftRow = app.cells.containing(.staticText, identifier: "Draft").firstMatch
        XCTAssertTrue(draftRow.waitForExistence(timeout: 3))
        draftRow.swipeLeft(); app.buttons["Delete"].tap()
        XCTAssertTrue(app.buttons["history.undo-delete"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Draft"].exists)
        app.buttons["history.undo-delete"].tap()
        XCTAssertTrue(app.staticTexts["Draft"].waitForExistence(timeout: 3))
        app.cells.containing(.staticText, identifier: "Draft").firstMatch.tap()
        app.buttons["history.delete-draft"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 3))
        app.buttons["History actions"].tap(); app.buttons["Deleted captures"].tap()
        let restore = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "history.restore.")).firstMatch
        XCTAssertTrue(restore.waitForExistence(timeout: 3)); restore.tap()
        XCTAssertTrue(app.staticTexts["No deleted captures"].waitForExistence(timeout: 3))
        app.navigationBars.buttons["History"].tap()
        XCTAssertTrue(app.staticTexts["Draft"].waitForExistence(timeout: 3))
    }

    func testClearDraftsKeepsSavedHistoryAndOffersUndo() {
        let app = launch("ready")
        app.tabBars.buttons["History"].tap()
        app.buttons["History actions"].tap(); app.buttons["Clear drafts"].tap()
        app.buttons["Clear drafts"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Draft"])
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.staticTexts["Saved"].exists)
        app.buttons["history.undo-delete"].tap()
        XCTAssertTrue(app.staticTexts["Draft"].waitForExistence(timeout: 3))
    }

    func testPartialPlacementsInLargeDarkLayout() {
        let app = launch("partial", dark: true, large: true)
        XCTAssertTrue(app.staticTexts["Save interrupted"].waitForExistence(timeout: 3))
        screenshot("28-partial-large-dark", app)
        reveal(placement(103, app), app)
        XCTAssertEqual(placement(103, app).value as? String, "Awaiting confirmation")
        XCTAssertTrue(app.tabBars.buttons["History"].isHittable)
    }

    func testNewFromEditorKeepsHistoryAndRemainsEmptyAfterRelaunch() {
        let app = launch("ready")
        app.tabBars.buttons["History"].tap()
        let retained = historyIDs(app)
        XCTAssertEqual(retained.count, 2)
        app.tabBars.buttons["Capture"].tap()
        XCTAssertTrue(app.buttons["capture.new"].isHittable)
        app.buttons["capture.new"].tap()
        for _ in 0..<4 { app.buttons["capture.new"].tap() }
        let input = element("capture.source.1", app)
        XCTAssertTrue(["", "Paste a link"].contains(input.value as? String ?? "unknown"))
        app.tabBars.buttons["History"].tap()
        XCTAssertEqual(historyIDs(app), retained)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["capture.new"].waitForExistence(timeout: 10))
        XCTAssertTrue(["", "Paste a link"].contains(element("capture.source.1", app).value as? String ?? "unknown"))
        app.tabBars.buttons["History"].tap()
        XCTAssertEqual(historyIDs(app), retained)
    }

    func testHistoryResumeCancelThenNewKeepsRetainedDraft() {
        let app = launch("ready")
        app.buttons["capture.new"].tap()
        app.tabBars.buttons["History"].tap()
        let retained = historyIDs(app)
        app.cells.containing(.staticText, identifier: "Draft").firstMatch.tap()
        app.buttons["Resume capture"].tap()
        XCTAssertTrue(app.buttons["capture.cancel-history"].waitForExistence(timeout: 3))
        app.buttons["capture.cancel-history"].tap()
        app.buttons["capture.new"].tap()
        app.tabBars.buttons["History"].tap()
        app.navigationBars.buttons["History"].tap()
        XCTAssertEqual(historyIDs(app), retained)
    }

    func testCompletedPlacementCancelThenNewDoesNotReopenEditing() {
        let app = launch("saved")
        openSavedHistory(app)
        app.buttons["history.add-placements"].tap()
        app.buttons["capture.cancel-placements"].tap()
        app.buttons["capture.new"].tap()
        XCTAssertTrue(["", "Paste a link"].contains(element("capture.source.1", app).value as? String ?? "unknown"))
        XCTAssertFalse(app.buttons["capture.cancel-placements"].exists)
        app.tabBars.buttons["History"].tap()
        app.navigationBars.buttons["History"].tap()
        XCTAssertEqual(historyIDs(app).count, 1)
    }

    func testOrdinaryScrollingNeverStartsNewCapture() {
        let app = launch("ready")
        for _ in 0..<4 { app.swipeUp(); app.swipeDown() }
        let title = element("capture.title", app)
        reveal(title, app)
        XCTAssertEqual(title.value as? String, "A study in shape")
        XCTAssertTrue(app.buttons["capture.new"].exists)
        app.tabBars.buttons["History"].tap()
        XCTAssertEqual(historyIDs(app).count, 2)
    }
}
