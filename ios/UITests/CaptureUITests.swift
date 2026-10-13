import XCTest

final class CaptureUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }
    private func launch(_ mode: String, dark: Bool = false, large: Bool = false, store: String = UUID().uuidString, clipboard: String? = nil, separateComposer: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = mode
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = store
        app.launchEnvironment["CAPTURE_UI_STYLE"] = dark ? "dark" : "light"
        if separateComposer { app.launchEnvironment["CAPTURE_UI_COMPOSER"] = "share" }
        if let clipboard { app.launchEnvironment["CAPTURE_UI_CLIPBOARD"] = clipboard }
        app.launchArguments += ["-AppleInterfaceStyle", dark ? "Dark" : "Light"]
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 10))
        return app
    }

    private func screenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func enableAutomaticPaste(_ app: XCUIApplication) {
        app.tabBars.buttons["Settings"].tap()
        app.swipeUp()
        let toggle = app.switches["Paste on open"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        if toggle.value as? String != "1" {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        }
        XCTAssertEqual(toggle.value as? String, "1")
        app.tabBars.buttons["Capture"].tap()
    }

    func testEmptyCaptureKeepsPasteAndDestinationVisible() {
        let app = launch("empty")
        XCTAssertTrue(app.descendants(matching: .any)["capture.source.1"].firstMatch.exists)
        XCTAssertTrue(app.buttons["capture.destinations"].exists)
        XCTAssertFalse(app.navigationBars.buttons["Save"].isEnabled)
        screenshot("empty-capture-light", app: app)
    }

    private func captureTabAppearance(dark: Bool, large: Bool) {
        let app = launch("empty", dark: dark, large: large, separateComposer: true)
        let capture = app.tabBars.buttons["Capture"]
        XCTAssertEqual(capture.label, "Capture")
        XCTAssertTrue(capture.isSelected)
        screenshot("capture-mark-selected-\(dark ? "dark" : "light")", app: app)
        app.tabBars.buttons["History"].tap()
        XCTAssertFalse(capture.isSelected)
        XCTAssertTrue(app.staticTexts["No captures yet"].waitForExistence(timeout: 5))
        screenshot("capture-mark-unselected-\(dark ? "dark" : "light")", app: app)
        app.tabBars.buttons["Settings"].tap()
        app.swipeUp()
        let deleted = app.buttons["Deleted captures"]
        for _ in 0..<4 where !deleted.isHittable { app.swipeUp() }
        XCTAssertTrue(deleted.isHittable)
        screenshot("settings-retention-\(dark ? "dark" : "light")", app: app)
        deleted.tap()
        XCTAssertTrue(app.staticTexts["No deleted captures"].waitForExistence(timeout: 5))
        screenshot("deleted-captures-empty-\(dark ? "dark" : "light")", app: app)
    }

    func testCaptureTabMarkAndRetentionLight() { captureTabAppearance(dark: false, large: false) }
    func testCaptureTabMarkAndRetentionLargeDark() { captureTabAppearance(dark: true, large: true) }

    func testAutomaticPasteIgnoresPlainAndInvalidClipboardOnCleanLaunch() {
        let store = UUID().uuidString
        let setup = launch("empty", store: store, clipboard: "")
        enableAutomaticPaste(setup)
        setup.terminate()

        for (name, clipboard) in [("plain-text", "initially read this as “stochastic” lol"),
                                  ("invalid-url", "https://")] {
            let app = launch("empty", dark: true, store: store, clipboard: clipboard)
            let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
            XCTAssertTrue(source.waitForExistence(timeout: 5))
            XCTAssertFalse((source.value as? String ?? "").contains(clipboard))
            XCTAssertFalse(app.navigationBars.buttons["Save"].isEnabled)
            XCTAssertFalse(app.buttons["Try again"].exists)
            XCTAssertFalse(app.staticTexts["Paste a link to capture."].exists)
            screenshot("clipboard-\(name)-empty-dark", app: app)
            app.terminate()
        }
    }

    func testAutomaticPasteExtractsLinksAndPreservesRestoredManualDraft() {
        let store = UUID().uuidString
        let setup = launch("empty", store: store, clipboard: "")
        enableAutomaticPaste(setup)
        setup.terminate()

        let firstURL = "https://x.com/example/status/123"
        let valid = launch("empty", store: store, clipboard: firstURL)
        valid.tabBars.buttons["Settings"].tap()
        for _ in 0..<5 where !valid.switches["Paste on open"].isHittable { valid.swipeUp() }
        XCTAssertEqual(valid.switches["Paste on open"].value as? String, "1")
        valid.tabBars.buttons["Capture"].tap()
        let source = valid.descendants(matching: .any)["capture.source.1"].firstMatch
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", firstURL), object: source)], timeout: 5)
        XCTAssertEqual(source.value as? String, firstURL, "Valid clipboard was not offered to the source field")
        XCTAssertFalse(valid.buttons["Try again"].exists)
        screenshot("clipboard-valid-link", app: valid)
        valid.buttons["capture.new"].tap()
        valid.terminate()

        let mixedURL = "https://example.com/article"
        let mixed = launch("empty", store: store, clipboard: "Read this \(mixedURL) before lunch.")
        let mixedSource = mixed.descendants(matching: .any)["capture.source.1"].firstMatch
        expectation(for: NSPredicate(format: "value == %@", mixedURL), evaluatedWith: mixedSource)
        waitForExpectations(timeout: 5)
        XCTAssertFalse((mixedSource.value as? String ?? "").contains("Read this"))
        screenshot("clipboard-mixed-extracted-link", app: mixed)
        mixedSource.tap()
        mixedSource.typeText(" manual edit")
        let edited = mixedSource.value as? String ?? ""
        XCTAssertTrue(edited.contains("manual edit"))
        mixed.terminate()

        let restored = launch("empty", store: store, clipboard: "https://example.com/replacement")
        let restoredSource = restored.descendants(matching: .any)["capture.source.1"].firstMatch
        XCTAssertEqual(restoredSource.value as? String, edited)
        XCTAssertFalse(restored.buttons["Try again"].exists)
        screenshot("clipboard-restored-manual-edit", app: restored)
    }

    func testLegacyPlainTextFailureRestoresAsEditingWithoutRetry() {
        let store = UUID().uuidString
        for reopened in [false, true] {
            let app = launch("invalid-restored", dark: true, store: store)
            let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
            XCTAssertTrue(source.waitForExistence(timeout: 5))
            XCTAssertEqual(source.value as? String, "initially read this as “stochastic” lol")
            XCTAssertFalse(app.buttons["Try again"].exists)
            XCTAssertFalse(app.staticTexts["Paste a link to capture."].exists)
            XCTAssertFalse(app.navigationBars.buttons["Save"].isEnabled)
            screenshot(reopened ? "plain-draft-restored-dark" : "plain-draft-migrated-dark", app: app)
            app.terminate()
        }
    }

    func testIdleStoreReleasesAcrossBackgroundAndRestoresEditor() {
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "ready"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        app.launchEnvironment["CAPTURE_LOCK_PROBE"] = "1"
        app.launch()
        let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        let original = source.value as? String
        XCTAssertNotNil(original)
        XCUIDevice.shared.press(.home)
        let backgrounded = NSPredicate { _, _ in
            app.state == .runningBackground || app.state == .runningBackgroundSuspended
        }
        expectation(for: backgrounded, evaluatedWith: app)
        waitForExpectations(timeout: 10)
        app.activate()
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        XCTAssertEqual(source.value as? String, original)
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
    }

    func testTransferContinuesWhileAppIsInBackground() throws {
        guard let endpoint = ProcessInfo.processInfo.environment["CAPTURE_BACKGROUND_URL"], !endpoint.isEmpty else {
            throw XCTSkip("Set CAPTURE_BACKGROUND_URL to a delayed-response fixture to test background delivery.")
        }
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "background"
        app.launchEnvironment["CAPTURE_BACKGROUND_URL"] = endpoint
        app.launch()
        let start = app.buttons["Start Background Probe"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        XCTAssertTrue(app.staticTexts["Submitted"].waitForExistence(timeout: 5))
        XCUIDevice.shared.press(.home)
        let backgrounded = NSPredicate { _, _ in
            app.state == .runningBackground || app.state == .runningBackgroundSuspended
        }
        expectation(for: backgrounded, evaluatedWith: app)
        waitForExpectations(timeout: 10)
        Thread.sleep(forTimeInterval: 85)
        app.activate()
        XCTAssertTrue(app.staticTexts["Background transfer completed"].waitForExistence(timeout: 20))
        screenshot("07-background-completed", app: app)
    }

    func testReadyEditorAndHistoryPreserveDraft() {
        let app = launch("ready")
        screenshot("01-ready", app: app)
        let description = app.descendants(matching: .any)["capture.description"].firstMatch
        for _ in 0..<6 where !description.exists { app.swipeUp() }
        XCTAssertTrue(description.exists)
        for _ in 0..<3 where !description.isHittable { app.swipeUp() }
        description.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        let fieldAboveKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            description.frame.maxY <= keyboard.frame.minY - 12
        }, object: nil)
        let settled = XCTWaiter.wait(for: [fieldAboveKeyboard], timeout: 3)
        screenshot("02-keyboard-up", app: app)
        XCTAssertEqual(settled, .completed, "The focused description should clear the keyboard and Done control")
        description.typeText(" Added in Capture.")
        screenshot("02-editing", app: app)
        app.buttons["capture.keyboard.done"].tap()
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 3))
        screenshot("03-history", app: app)
        app.tabBars.buttons["Capture"].tap()
        XCTAssertTrue((description.value as? String)?.contains("Added in Capture") == true)
    }

    func testReadyFormAtDarkAndLargeLight() {
        let dark = launch("ready", dark: true)
        XCTAssertTrue(dark.navigationBars["Capture"].waitForExistence(timeout: 3))
        XCTAssertFalse(dark.buttons["capture.destinations.reset"].exists)
        screenshot("ready-ordinary-dark", app: dark)
        dark.terminate()

        let large = launch("ready", large: true)
        XCTAssertTrue(large.navigationBars["Capture"].waitForExistence(timeout: 3))
        screenshot("ready-large-light", app: large)
        let description = large.descendants(matching: .any)["capture.description"].firstMatch
        for _ in 0..<10 where !description.isHittable { large.swipeUp() }
        XCTAssertTrue(description.isHittable)
        screenshot("ready-large-light-bottom", app: large)
    }

    func testPrimaryTabsKeepTheirTitlesAndCaptureDraft() {
        let app = launch("ready")
        let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        let link = source.value as? String
        screenshot("balance-capture-light", app: app)
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
        screenshot("balance-history-light", app: app)
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        screenshot("balance-settings-light", app: app)
        app.tabBars.buttons["Capture"].tap()
        XCTAssertEqual(source.value as? String, link)
    }

    func testReadyDescriptionClearsTabBarWithoutScrolling() {
        for dark in [false, true] {
            let app = launch("ready", dark: dark)
            let description = app.descendants(matching: .any)["capture.description"].firstMatch
            let tabBar = app.tabBars.firstMatch
            XCTAssertTrue(description.waitForExistence(timeout: 5))
            XCTAssertTrue(description.isHittable)
            XCTAssertLessThan(description.frame.maxY, tabBar.frame.minY - 8,
                              "The description editor should clear the floating tab bar at rest")
            screenshot(dark ? "ready-description-above-tabs-dark" : "ready-description-above-tabs-light", app: app)
            app.terminate()
        }
    }

    func testImportThreadIsAnEditableNativeToggle() {
        let app = launch("ready")
        let thread = app.descendants(matching: .any)["capture.thread-import"].firstMatch
        XCTAssertTrue(thread.waitForExistence(timeout: 5))
        XCTAssertTrue(thread.isEnabled)
        XCTAssertEqual(thread.value as? String, "0")
        thread.coordinate(withNormalizedOffset: CGVector(dx: 0.91, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: thread)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
    }

    func testLargeTextSingleMediaChoiceIsReachable() {
        let app = launch("ready", large: true)
        let asset = app.buttons["capture.media.asset.1.1"]
        for _ in 0..<8 where !asset.isHittable { app.swipeUp() }
        XCTAssertTrue(asset.isHittable)
        XCTAssertEqual(asset.value as? String, "Included")
        asset.tap()
        expectation(for: NSPredicate(format: "value == %@", "Excluded"), evaluatedWith: asset)
        waitForExpectations(timeout: 5)
        screenshot("large-text-media-none", app: app)
    }

    func testLargeTextImportThreadIsReachable() {
        let app = launch("ready", large: true)
        let thread = app.descendants(matching: .any)["capture.thread-import"].firstMatch
        let tabBar = app.tabBars.firstMatch
        for _ in 0..<8 {
            if thread.exists && thread.isHittable && thread.frame.maxY < tabBar.frame.minY - 8 { break }
            app.swipeUp()
        }
        XCTAssertTrue(thread.isHittable)
        XCTAssertLessThan(thread.frame.maxY, tabBar.frame.minY - 8)
        XCTAssertEqual(thread.value as? String, "0")
        thread.coordinate(withNormalizedOffset: CGVector(dx: 0.91, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: thread)
        waitForExpectations(timeout: 5)
        screenshot("large-text-import-thread", app: app)
    }

    func testChannelSelectionAndDefaultMenu() {
        let app = launch("ready")
        let destination = app.buttons["capture.destinations"]
        if !destination.isHittable { app.swipeUp() }
        XCTAssertTrue(destination.waitForExistence(timeout: 3))
        destination.tap()
        let inbox = app.buttons["channel.select.101"]
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.waitForExistence(timeout: 5))
        XCTAssertTrue(inbox.exists)
        XCTAssertEqual(inbox.value as? String, "Selected")
        design.tap()
        XCTAssertEqual(design.value as? String, "Selected")
        app.buttons["channel.list-mode"].tap()
        inbox.tap()
        XCTAssertFalse(inbox.exists)
        app.buttons["channel.list-mode"].tap()
        design.press(forDuration: 1)
        screenshot("04-channel-menu", app: app)
        app.buttons["Set as default"].tap()
        let defaultRow = app.buttons["channel.select.102"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", ", Default"), evaluatedWith: defaultRow)
        waitForExpectations(timeout: 5)
        app.buttons["channel.done"].tap()
        app.tabBars.buttons["Settings"].tap()
        let setting = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Interface design")).firstMatch
        XCTAssertTrue(setting.waitForExistence(timeout: 3))
        screenshot("settings-inline-title", app: app)
    }

    func testSavedResultHasTruthfulContent() {
        let app = launch("saved")
        let saved = app.descendants(matching: .any)["capture.saved-notice"].firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 3))
        XCTAssertEqual(saved.label, "Saved to Are.na")
        XCTAssertTrue(saved.isHittable)
        XCTAssertFalse(app.buttons["Review in history"].exists)
        screenshot("saved-confirmation", app: app)
        app.tabBars.buttons["History"].tap()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history.capture.", "A study in shape")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 3)); row.tap()
        XCTAssertTrue(app.staticTexts["Saved"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["A study in shape"].exists)
        XCTAssertTrue(app.buttons["history.add-placements"].exists)
        XCTAssertTrue(app.buttons["history.delete-draft"].exists)
        XCTAssertFalse(app.staticTexts["The original link will be saved to Are.na."].exists)
        screenshot("05-saved", app: app)
    }

    func testSavedNoticeYieldsToEditingWhileHistoryRetainsTheConfirmedBlock() {
        let app = launch("saved")
        XCTAssertTrue(app.descendants(matching: .any)["capture.saved-notice"].firstMatch.waitForExistence(timeout: 3))
        let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 3))
        source.tap(); source.typeText("https://example.com/next")
        XCTAssertFalse(app.descendants(matching: .any)["capture.saved-notice"].firstMatch.exists)
        app.buttons["capture.keyboard.done"].tap()
        app.tabBars.buttons["History"].tap()
        let saved = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "history.capture.", "A study in shape")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 3)); saved.tap()
        XCTAssertTrue(app.staticTexts["A study in shape"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["Open in Are.na"].exists)
    }

    func testSavedNoticeAtLargeTypeAndPartialSaveNeverClaimsSuccess() {
        let saved = launch("saved", dark: true, large: true)
        XCTAssertTrue(saved.descendants(matching: .any)["capture.saved-notice"].firstMatch.waitForExistence(timeout: 3))
        screenshot("saved-result-large-dark", app: saved)
        let notice = saved.buttons["capture.saved-notice"]
        XCTAssertTrue(notice.isHittable); notice.tap()
        XCTAssertTrue(saved.tabBars.buttons["History"].isSelected)
        XCTAssertTrue(saved.staticTexts["Saved"].waitForExistence(timeout: 3))
        screenshot("saved-history-large-dark", app: saved)
        saved.terminate()
        let partial = launch("partial")
        XCTAssertFalse(partial.descendants(matching: .any)["capture.saved-notice"].firstMatch.exists)
        XCTAssertFalse(partial.descendants(matching: .any)["capture.saved-open"].exists)
    }

    func testMultipleSourcePostsRemainOrderedAndEditableBeforeSave() {
        let app = launch("multi-post")
        let first = app.descendants(matching: .any)["capture.source.1"].firstMatch
        let second = app.descendants(matching: .any)["capture.source.2"].firstMatch
        XCTAssertTrue(app.buttons["capture.source.details.1"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["capture.source.details.2"].exists)
        screenshot("multi-post-collapsed-summary", app: app)
        app.descendants(matching: .any)["capture.source.details.1"].firstMatch.tap()
        screenshot("multi-post-first-expanded", app: app)
        XCTAssertEqual(app.buttons["capture.source.details.1"].value as? String, "Expanded")
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue((first.value as? String)?.contains("status/123") == true)
        XCTAssertTrue(app.descendants(matching: .any)["capture.source.excerpt.1"].exists)
        app.descendants(matching: .any)["capture.source.details.2"].firstMatch.tap()
        XCTAssertTrue(second.exists)
        XCTAssertTrue((second.value as? String)?.contains("status/124") == true)
        XCTAssertTrue(app.descendants(matching: .any)["capture.source.excerpt.2"].exists)
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        screenshot("multi-post-two-sources", app: app)
        let add = app.buttons["capture.source.add"]
        for _ in 0..<4 where !add.isHittable { app.swipeUp() }
        XCTAssertTrue(add.isHittable)
        add.tap()
        let third = app.descendants(matching: .any)["capture.source.3"].firstMatch
        XCTAssertTrue(third.waitForExistence(timeout: 5))
        third.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        third.typeText("https://x.com/third/status/125")
        XCTAssertTrue((third.value as? String)?.contains("status/125") == true)
        if app.buttons["capture.keyboard.done"].exists { app.buttons["capture.keyboard.done"].tap() }
        app.buttons["capture.source.details.3"].swipeLeft()
        XCTAssertTrue(app.buttons["Remove"].waitForExistence(timeout: 3))
        app.buttons["Remove"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["capture.source.3"].exists)
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        app.navigationBars.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Saved to Are.na"].exists)
    }

    func testSourceContributionCanSwitchToMediaOnlyBeforeSave() {
        let app = launch("multi-post")
        app.descendants(matching: .any)["capture.source.details.2"].firstMatch.tap()
        let role = app.switches["capture.source.role.2"]
        for _ in 0..<4 where !role.isHittable { app.swipeUp() }
        XCTAssertTrue(role.waitForExistence(timeout: 5))
        role.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "0"), evaluatedWith: role)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        screenshot("multi-post-media-only-extra", app: app)
    }

    func testImportAndPostRoleKeepAuthoredWritingAndMediaChoices() {
        let store = UUID().uuidString
        let app = launch("multi-post-extra", store: store)
        func reveal(_ element: XCUIElement) {
            for _ in 0..<10 where !element.isHittable { app.swipeUp() }
            XCTAssertTrue(element.isHittable)
        }
        let title = app.descendants(matching: .any)["capture.title"].firstMatch
        reveal(title); title.tap(); title.typeText("My authored title")
        if app.buttons["capture.keyboard.done"].exists { app.buttons["capture.keyboard.done"].tap() }
        let description = app.descendants(matching: .any)["capture.description"].firstMatch
        reveal(description); description.tap(); description.typeText("My authored description")
        if app.buttons["capture.keyboard.done"].exists { app.buttons["capture.keyboard.done"].tap() }

        let first = app.buttons["capture.source.details.1"]
        for _ in 0..<10 where !first.isHittable { app.swipeDown() }
        XCTAssertTrue(first.isHittable); first.tap()
        let firstAsset = app.buttons["capture.media.asset.1.1"]
        reveal(firstAsset); firstAsset.tap()
        XCTAssertEqual(firstAsset.value as? String, "Excluded")

        let thread = app.descendants(matching: .any)["capture.thread-import"].firstMatch
        reveal(thread)
        thread.coordinate(withNormalizedOffset: CGVector(dx: 0.91, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: thread)
        waitForExpectations(timeout: 5)

        let second = app.buttons["capture.source.details.2"]
        reveal(second); second.tap()
        let role = app.switches["capture.source.role.2"]
        reveal(role); role.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: role)
        waitForExpectations(timeout: 5)
        XCTAssertTrue((title.value as? String ?? "").contains("My authored title"))
        XCTAssertTrue((description.value as? String ?? "").contains("My authored description"))
        screenshot("thread-role-preserved-writing-and-media", app: app)

        role.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "0"), evaluatedWith: role)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(thread.value as? String, "1", "Changing a post role must retain Import thread")
        let preservedAsset = app.buttons["capture.media.asset.2.1"]
        reveal(second)
        if second.value as? String == "Collapsed" { second.tap() }
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true"), object: preservedAsset)], timeout: 8)
        reveal(preservedAsset)
        XCTAssertEqual(preservedAsset.value as? String, "Included")
        app.terminate()

        let restored = launch("multi-post-extra", store: store)
        XCTAssertTrue((restored.descendants(matching: .any)["capture.title"].firstMatch.value as? String ?? "")
            .contains("My authored title"))
        XCTAssertTrue((restored.descendants(matching: .any)["capture.description"].firstMatch.value as? String ?? "")
            .contains("My authored description"))
        XCTAssertEqual(restored.descendants(matching: .any)["capture.thread-import"].firstMatch.value as? String, "1")
    }

    func testVideoChoiceIsAvailableBeforeSave() {
        let app = launch("video-frame")
        let choice = app.segmentedControls["capture.media.choice.1.1"]
        for _ in 0..<8 where !choice.isHittable { app.swipeUp() }
        XCTAssertTrue(choice.isHittable)
        screenshot("video-choice-before-save", app: app)
        choice.buttons["Frame"].tap()
        XCTAssertTrue(choice.buttons["Frame"].isSelected)
        screenshot("video-frame-selected", app: app)
    }

    func testDirectSaveQueuesBeforeSlowSourcePreview() {
        let store = UUID().uuidString
        var app = launch("slow-resolution", store: store)
        let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        source.tap()
        source.typeText("https://x.com/example/status/123")
        let save = app.navigationBars.buttons["Save"]
        XCTAssertTrue(save.isEnabled)
        save.tap()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 5))
        let summary = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "capture.source-summary.")).firstMatch
        XCTAssertEqual(summary.label, "Source link")
        XCTAssertEqual(summary.value as? String, "https://x.com/example/status/123")
        XCTAssertFalse(app.staticTexts["Saved to Are.na"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["capture.title"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["capture.description"].exists)
        screenshot("direct-save-before-preview-queued", app: app)
        let stop = app.buttons["capture.toolbar.stop"]
        XCTAssertTrue(stop.isHittable)
        stop.tap()
        XCTAssertTrue(app.staticTexts["Save paused"].waitForExistence(timeout: 5))
        XCTAssertFalse(stop.exists)
        XCTAssertTrue(app.buttons["capture.toolbar.continue"].exists)
        XCTAssertFalse(app.navigationBars.buttons["Save"].exists)
        screenshot("direct-save-stopped-before-preview", app: app)
        app.terminate()
        app = launch("slow-resolution", store: store)
        XCTAssertTrue(app.staticTexts["Save paused"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["capture.toolbar.stop"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["capture.title"].exists)
    }

    func testSourceReadCanStopWithoutLosingEditableLink() {
        let app = launch("slow-resolution")
        let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
        source.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        source.typeText("https://x.com/example/status/123")
        XCTAssertTrue(app.staticTexts["Reading link"].waitForExistence(timeout: 4))
        screenshot("reading-details-keyboard-up", app: app)
        source.typeText("?via=capture")
        if app.buttons["capture.keyboard.done"].exists { app.buttons["capture.keyboard.done"].tap() }
        XCTAssertTrue((source.value as? String)?.contains("via=capture") == true)
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        app.buttons["capture.source-action"].tap()
        XCTAssertFalse(app.staticTexts["Reading link"].exists)
        XCTAssertTrue((source.value as? String)?.contains("via=capture") == true)
        screenshot("source-read-stopped-editable", app: app)
    }

    func testSoundCloudPlaylistShowsSourceContextWithDirectSave() {
        let app = launch("soundcloud-playlist")
        XCTAssertTrue(app.navigationBars.buttons["Save"].isEnabled)
        let source = app.descendants(matching: .any)["capture.soundcloud.source"].firstMatch
        for _ in 0..<5 where !source.isHittable { app.swipeUp() }
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        XCTAssertTrue(source.label.contains("2 tracks"))
        XCTAssertTrue(app.buttons["capture.resolved-link"].exists)
        screenshot("soundcloud-playlist-source", app: app)
    }

    func testLongTextExpandsAndCollapsesFromItsControl() {
        let app = launch("long-text")
        let control = app.buttons["capture.text.expansion"]
        for _ in 0..<4 where !control.isHittable { app.swipeUp() }
        XCTAssertTrue(control.isHittable)
        XCTAssertEqual(control.label, "show more")
        screenshot("long-text-collapsed", app: app)
        let body = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Beginning of the retained text.")).firstMatch
        XCTAssertTrue(body.exists)
        let collapsedHeight = body.frame.height
        control.tap()
        XCTAssertEqual(control.label, "show less")
        screenshot("long-text-expanded", app: app)
        let expanded = NSPredicate { _, _ in body.frame.height > collapsedHeight + 2 }
        expectation(for: expanded, evaluatedWith: body)
        waitForExpectations(timeout: 3)
        control.tap()
        XCTAssertEqual(control.label, "show more")
        let collapsed = NSPredicate { _, _ in abs(body.frame.height - collapsedHeight) <= 2 }
        expectation(for: collapsed, evaluatedWith: body)
        waitForExpectations(timeout: 3)
    }

    func testQueuedAndLargeDarkLayout() {
        let app = launch("queued", dark: true, large: true)
        for _ in 0..<5 where !app.staticTexts["Queued"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.staticTexts["Queued"].exists)
        XCTAssertFalse(app.staticTexts["Saved to Are.na"].exists)
        XCTAssertTrue(app.buttons["capture.toolbar.stop"].isHittable)
        screenshot("06-queued-large-dark-top", app: app)
        app.swipeUp()
        XCTAssertFalse(app.staticTexts["0/1 confirmed"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "capture.stop.")).firstMatch.exists)
        screenshot("06-queued-large-dark-bottom", app: app)
        app.buttons["capture.toolbar.stop"].tap()
        XCTAssertTrue(app.staticTexts["Save paused"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["capture.toolbar.continue"].isHittable)
        screenshot("06-queued-large-dark-paused", app: app)
        XCTAssertTrue(app.tabBars.buttons["History"].isHittable)
    }
}
