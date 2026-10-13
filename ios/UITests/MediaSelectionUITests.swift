import XCTest

/// Generated local media and a fixture transport; no real account or delivery.
final class MediaSelectionUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func launch(mode: String = "media-selection", store: String = UUID().uuidString, large: Bool = false, previewDelayMS: Int = 0) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = mode
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = store
        app.launchEnvironment["CAPTURE_UI_STYLE"] = large ? "dark" : "light"
        if previewDelayMS > 0 { app.launchEnvironment["CAPTURE_UI_PREVIEW_DELAY_MS"] = String(previewDelayMS) }
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        if mode == "multi-post-long" {
            // At accessibility sizes the destination row is below the four sources
            // and the native Form hasn't materialized it yet.
            XCTAssertTrue(app.buttons["capture.source.details.1"].waitForExistence(timeout: 10))
            return app
        }
        let destinations = app.buttons["capture.destinations"]
        if large {
            // At XXXL the source editor precedes destinations by more than a screen.
            for _ in 0..<10 where !destinations.isHittable { app.swipeUp() }
        }
        XCTAssertTrue(destinations.waitForExistence(timeout: 10))
        return app
    }

    private func included(_ ref: String, _ value: String, app: XCUIApplication) {
        let asset = app.buttons["capture.media.asset.\(ref)"]
        for _ in 0..<8 where !asset.isHittable { app.swipeUp() }
        XCTAssertTrue(asset.waitForExistence(timeout: 5))
        XCTAssertTrue(asset.isHittable)
        let predicate = NSPredicate(format: "value == %@", value)
        expectation(for: predicate, evaluatedWith: asset)
        waitForExpectations(timeout: 10)
    }

    private func screenshot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func visible(_ element: XCUIElement, app: XCUIApplication) {
        let tabBar = app.tabBars.firstMatch
        for _ in 0..<8 {
            if element.exists && element.isHittable && element.frame.maxY < tabBar.frame.minY - 8 { break }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertLessThan(element.frame.maxY, tabBar.frame.minY - 8)
    }

    func testOptionalCompositionPreviewUsesCurrentSelection() {
        let app = launch()
        let save = app.navigationBars.buttons["Save"]
        XCTAssertTrue(save.isEnabled, "Save must not require a preview")
        let all = app.buttons["capture.media.all"]
        visible(all, app: app)
        all.tap()
        let start = app.buttons["capture.composition-preview.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        visible(start, app: app)
        XCTAssertTrue(save.isEnabled)
        start.tap()
        let image = app.descendants(matching: .any)["capture.composition-preview.image"].firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 20))
        screenshot("preview-three-selected-images", app)
        app.swipeUp()
        screenshot("preview-three-selected-images-scroll", app)
        let hide = app.buttons["capture.composition-preview.hide"]
        visible(hide, app: app)
        hide.tap()
        XCTAssertFalse(image.exists)
        let second = app.buttons["capture.media.asset.1.2"]
        visible(second, app: app)
        second.tap()
        included("1.2", "Excluded", app: app)
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        visible(start, app: app)
        start.tap()
        XCTAssertTrue(image.waitForExistence(timeout: 20))
        screenshot("preview-two-selected-images", app)
        app.swipeUp()
        screenshot("preview-two-selected-images-scroll", app)
        XCTAssertTrue(save.isEnabled)
    }

    func testMultiplePostsPreviewAtOrdinaryAndLargeText() {
        for large in [false, true] {
            let app = launch(mode: "multi-post", large: large)
            let start = app.buttons["capture.composition-preview.start"]
            visible(start, app: app)
            XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
            start.tap()
            let image = app.descendants(matching: .any)["capture.composition-preview.image"].firstMatch
            for _ in 0..<8 where !image.exists { app.swipeUp() }
            XCTAssertTrue(image.waitForExistence(timeout: 20))
            app.swipeUp()
            screenshot(large ? "preview-two-posts-large-dark" : "preview-two-posts-light", app)
            XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
            app.terminate()
        }
    }

    func testPreviewCancellationLeavesEditorAndSaveAvailable() {
        let app = launch(previewDelayMS: 3_000)
        let all = app.buttons["capture.media.all"]
        visible(all, app: app)
        all.tap()
        let start = app.buttons["capture.composition-preview.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        visible(start, app: app)
        start.tap()
        let cancel = app.buttons["capture.composition-preview.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        visible(cancel, app: app)
        cancel.tap()
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["capture.composition-preview.image"].exists)
        let title = app.descendants(matching: .any)["capture.title"].firstMatch
        visible(title, app: app)
        title.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        screenshot("preview-cancel-editor-keyboard", app)
    }

    func testVideoRequiresFrameForHonestStillPreview() {
        let app = launch(mode: "video-frame")
        let choice = app.segmentedControls["capture.media.choice.1.1"]
        visible(choice, app: app)
        choice.buttons["Video"].tap()
        XCTAssertTrue(app.staticTexts["Full video preview is unavailable before Save. Choose Frame to preview this selection."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["capture.composition-preview.start"].exists)
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        choice.buttons["Frame"].tap()
        let start = app.buttons["capture.composition-preview.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        visible(start, app: app)
        start.tap()
        let image = app.descendants(matching: .any)["capture.composition-preview.image"].firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 20))
        app.swipeUp()
        screenshot("preview-observed-video-frame", app)
    }

    func testIndividualAllNoneAndRelaunchPreserveCompositionSelection() {
        let store = UUID().uuidString
        var app = launch(store: store)
        included("1.2", "Excluded", app: app)
        XCTAssertFalse(app.descendants(matching: .any)["capture.quote-depth"].exists)
        screenshot("fixture-media-none-light", app)
        app.buttons["capture.media.asset.1.2"].tap()
        included("1.2", "Included", app: app)
        included("1.1", "Excluded", app: app)
        screenshot("fixture-media-one-light", app)
        app.buttons["capture.media.all"].tap()
        included("1.1", "Included", app: app)
        included("1.3", "Included", app: app)
        app.buttons["capture.media.none"].tap()
        included("1.1", "Excluded", app: app)
        included("1.3", "Excluded", app: app)
        app.buttons["capture.media.asset.1.3"].tap()
        app.buttons["capture.media.asset.1.1"].tap()
        included("1.1", "Included", app: app)
        included("1.2", "Excluded", app: app)
        included("1.3", "Included", app: app)
        XCTAssertTrue(app.navigationBars.buttons["Save"].waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.navigationBars.buttons["Save"])
        waitForExpectations(timeout: 10)
        screenshot("fixture-media-subset-light", app)
        app.terminate()
        app = launch(store: store)
        included("1.1", "Included", app: app)
        included("1.2", "Excluded", app: app)
        included("1.3", "Included", app: app)
    }

    func testVideoFrameToggleIncludesTheObservedPosterAndSurvivesRelaunch() {
        let store = UUID().uuidString
        var app = launch(mode: "video-frame", store: store)
        let choice = app.segmentedControls["capture.media.choice.1.1"]
        for _ in 0..<6 where !choice.isHittable { app.swipeUp() }
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        XCTAssertTrue(choice.buttons["None"].isSelected)
        XCTAssertFalse(app.buttons["capture.media.frame-threshold"].exists)
        choice.buttons["Frame"].tap()
        XCTAssertTrue(choice.buttons["Frame"].isSelected)
        XCTAssertFalse(app.buttons["capture.media.frame-threshold"].exists)
        screenshot("fixture-video-frame-included", app)

        choice.buttons["Video"].tap()
        XCTAssertTrue(choice.buttons["Video"].isSelected)
        app.terminate()
        app = launch(mode: "video-frame", store: store)
        let restored = app.segmentedControls["capture.media.choice.1.1"]
        for _ in 0..<6 where !restored.isHittable { app.swipeUp() }
        XCTAssertTrue(restored.buttons["Video"].isSelected)
    }

    func testFourLongPostsKeepSourcesAndCurrentBlockAccessible() {
        for large in [false, true] {
            let app = launch(mode: "multi-post-long", large: large)
            for index in 1...4 {
                let source = app.buttons["capture.source.details.\(index)"]
                XCTAssertTrue(source.waitForExistence(timeout: 10))
                visible(source, app: app)
                XCTAssertEqual(source.value as? String, "Collapsed")
            }
            screenshot(large ? "four-long-posts-large-dark-entry" : "four-long-posts-light-entry", app)
            let title = app.descendants(matching: .any)["capture.title"].firstMatch
            XCTAssertTrue(title.waitForExistence(timeout: 5))
            visible(title, app: app)
            screenshot(large ? "four-long-posts-large-dark-preview" : "four-long-posts-light-preview", app)
            app.terminate()
        }
    }

    func testConnectRemainsAboveSearchKeyboardAndCreatesDurableSubmission() {
        let app = launch(mode: "ready")
        app.buttons["capture.destinations"].tap()
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.waitForExistence(timeout: 5)); design.tap()
        let search = app.textFields["channel.search"]
        search.tap(); search.typeText("interface")
        let connect = app.buttons["channel.connect"]
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(connect.isHittable)
        XCTAssertTrue(connect.isEnabled)
        XCTAssertLessThanOrEqual(connect.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        XCTAssertEqual(design.value as? String, "Selected")
        screenshot("fixture-picker-keyboard-connect-light", app)
        connect.tap()
        XCTAssertTrue(app.buttons["capture.new"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["channel.connect"].exists)
        XCTAssertFalse(app.navigationBars.buttons["Save"].exists)
    }

    func testResetInsidePickerRestoresOnlyDefaultAfterReopen() {
        let app = launch(mode: "ready", large: true)
        XCTAssertFalse(app.buttons["capture.destinations.reset"].exists)
        app.buttons["capture.destinations"].tap()
        let search = app.textFields["channel.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.typeText("interface")
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.waitForExistence(timeout: 5)); design.tap()
        XCTAssertEqual(design.value as? String, "Selected")
        app.buttons["channel.selection-options"].tap()
        let clear = app.buttons["channel.clear"]
        XCTAssertTrue(clear.waitForExistence(timeout: 3)); clear.tap()
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 1 channel")
        screenshot("fixture-reset-to-default-inside-picker-large-dark", app)
        app.buttons["channel.done"].tap()
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        app.buttons["capture.destinations"].tap()
        XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Selected")
        XCTAssertEqual(app.buttons["channel.select.102"].value as? String, "Not selected")
        app.buttons["channel.select.101"].tap()
        XCTAssertFalse(app.buttons["channel.connect"].isEnabled)
        app.buttons["channel.selection-options"].tap()
        XCTAssertTrue(app.buttons["channel.clear"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["channel.clear"].isEnabled)
        app.buttons["channel.clear"].tap()
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 1 channel")
    }

    func testClearWithNoDefaultKeepsDestinationEmpty() {
        let app = launch(mode: "no-default")
        app.buttons["capture.destinations"].tap()
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.waitForExistence(timeout: 5)); design.tap()
        XCTAssertTrue(app.buttons["channel.connect"].isEnabled)
        app.buttons["channel.clear"].tap()
        XCTAssertFalse(app.buttons["channel.connect"].isEnabled)
        app.buttons["channel.done"].tap()
        XCTAssertTrue(app.buttons["capture.destinations"].label.lowercased().contains("choose channels"))
        XCTAssertFalse(app.navigationBars.buttons["Save"].isEnabled)
    }

    func testAutomaticDefaultAppearsOnceAsAlwaysIncluded() {
        let app = launch(mode: "always-default")
        app.buttons["capture.destinations"].tap()
        XCTAssertTrue(app.textFields["channel.search"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["channel.select.101"].exists)
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.waitForExistence(timeout: 5)); design.tap()
        XCTAssertEqual(design.value as? String, "Selected")
        app.buttons["channel.list-mode"].tap()
        let inbox = app.descendants(matching: .any)["channel.always-included"].firstMatch
        XCTAssertTrue(inbox.waitForExistence(timeout: 5))
        XCTAssertEqual(inbox.value as? String, "Always included")
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 2 channels")
        app.buttons["channel.clear"].tap()
        XCTAssertTrue(inbox.exists)
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 1 channel")
        screenshot("fixture-picker-automatic-default-light", app)
    }

    func testLongResultsAndLargeTypeKeepConnectAboveKeyboard() {
        let app = launch(mode: "many-channels", large: true)
        app.buttons["capture.destinations"].tap()
        let search = app.textFields["channel.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("study")
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "channel.select.", "Reference study")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        first.tap()
        if !app.keyboards.firstMatch.exists { search.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        let connect = app.buttons["channel.connect"]
        XCTAssertTrue(connect.isHittable)
        XCTAssertLessThanOrEqual(connect.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        screenshot("fixture-picker-long-results-keyboard-large-dark", app)
    }

    func testSearchScopePersistsThroughScrollAndDoneClosesWholePicker() {
        let app = launch(mode: "many-channels")
        app.buttons["capture.destinations"].tap()
        let search = app.textFields["channel.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("study")
        let scope = app.descendants(matching: .any)["channel.scope"].firstMatch
        XCTAssertTrue(scope.waitForExistence(timeout: 5))
        XCTAssertTrue(scope.isHittable)
        scope.tap()
        app.buttons["All"].tap()
        scope.tap()
        app.buttons["My Are.na"].tap()
        XCTAssertEqual(search.value as? String, "study")
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "channel.select.", "Reference study")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        let selectedChannel = app.buttons[row.identifier]
        XCTAssertEqual(selectedChannel.value as? String, "Selected")
        if !app.keyboards.firstMatch.exists { search.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        // Drag within visible results, above the fixed Connect bar and keyboard.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.48))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.27))
        start.press(forDuration: 0.01, thenDragTo: end)
        expectation(for: NSPredicate { _, _ in
            let keyboard = app.keyboards.firstMatch
            return !keyboard.exists || !keyboard.frame.intersects(app.frame)
        }, evaluatedWith: app)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(search.value as? String, "study")
        // The toolbar scope remains available while the results scroll.
        screenshot("fixture-picker-list-swipe-keyboard-hidden", app)
        // The swipe moves the selected row off screen. Scroll back before reading
        // its accessibility value; a recycled offscreen row is not authoritative.
        let backStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.43))
        let backEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
        for _ in 0..<6 where !selectedChannel.isHittable {
            backStart.press(forDuration: 0.01, thenDragTo: backEnd)
        }
        XCTAssertTrue(selectedChannel.isHittable)
        XCTAssertEqual(selectedChannel.value as? String, "Selected")
        search.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        app.buttons["channel.done"].tap()
        XCTAssertTrue(app.buttons["capture.destinations"].waitForExistence(timeout: 5))
        XCTAssertFalse(scope.exists)
    }

    func testQuotesOfferDefaultAndAllAvailableOnlyForQuotedSource() {
        let app = launch(mode: "quoted")
        let quotes = app.descendants(matching: .any)["capture.quote-depth"].firstMatch
        XCTAssertTrue(quotes.waitForExistence(timeout: 5))
        for _ in 0..<3 where !quotes.isHittable { app.swipeUp() }
        quotes.tap()
        app.buttons["All available"].tap()
        screenshot("fixture-quote-depth-full-light", app)
    }
}
