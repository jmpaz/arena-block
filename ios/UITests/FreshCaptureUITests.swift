import XCTest

final class FreshCaptureUITests: XCTestCase {
    private func launch(_ mode: String = "ready", large: Bool = false, dark: Bool = false, store: String = UUID().uuidString, clipboard: String? = nil, clipboardURL: String? = nil, liveSource: Bool = false, halfPicker: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = mode
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = store
        app.launchEnvironment["CAPTURE_UI_STYLE"] = dark ? "dark" : "light"
        app.launchEnvironment["CAPTURE_UI_SOURCE_DELAY"] = "4000"
        // XCUIApplication launch settings can retain optional keys between
        // instances of the same bundle. Specify each fixture input every time.
        app.launchEnvironment["CAPTURE_UI_CLIPBOARD"] = clipboard ?? ""
        app.launchEnvironment["CAPTURE_UI_CLIPBOARD_URL"] = clipboardURL ?? ""
        app.launchEnvironment["CAPTURE_UI_LIVE_SOURCE"] = liveSource ? "1" : "0"
        app.launchEnvironment["CAPTURE_UI_HALF_PICKER"] = halfPicker ? "1" : "0"
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 10))
        return app
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testPasteAppearanceThroughTypingClearAndPaste() {
        let url = "https://x.com/example/status/1234567890"
        let app = launch("empty", clipboardURL: url)
        let source = app.textFields["capture.source.1"]
        let paste = app.buttons["capture.paste"].firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        shot("paste-empty", app)
        source.tap(); source.typeText("https://example.com/typing")
        shot("paste-typing", app)
        source.press(forDuration: 1)
        let selectAll = app.descendants(matching: .any)["Select All"].firstMatch
        XCTAssertTrue(selectAll.waitForExistence(timeout: 3)); selectAll.tap()
        source.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "Enter a link"), object: source)], timeout: 5), .completed)
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        shot("paste-cleared", app)
        XCTAssertTrue(paste.isHittable)
        XCTAssertLessThanOrEqual(paste.frame.width, 52)
        XCTAssertLessThanOrEqual(paste.frame.height, 52)
        app.terminate()
        let fresh = launch("empty", clipboardURL: url)
        fresh.buttons["capture.paste"].firstMatch.tap()
        let pastedSource = fresh.textFields["capture.source.1"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", url), object: pastedSource)], timeout: 5), .completed)
        shot("paste-complete", fresh)
    }

    func testSelectedOnlyAlwaysDefaultAlignsWithSelectedChannels() {
        let app = launch("always-default")
        app.buttons["capture.destinations"].tap()
        app.buttons["channel.select.102"].tap()
        app.buttons["channel.select.103"].tap()
        app.buttons["channel.list-mode"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["channel.always-included"].firstMatch.waitForExistence(timeout: 5))
        shot("picker-selected-with-always-default", app)
    }

    func testPickerPreviewImmediateSelectionClearAndReopen() {
        let app = launch()
        shot("fresh-capture", app)
        app.buttons["capture.destinations"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["channel.block-preview"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let search = app.textFields["channel.search"]
        XCTAssertLessThanOrEqual(search.frame.height, 60)
        XCTAssertLessThanOrEqual(search.frame.maxY, app.buttons["channel.clear"].frame.minY)
        search.typeText("interface")
        let design = app.buttons["channel.select.102"]
        XCTAssertTrue(design.isHittable)
        design.tap()
        XCTAssertEqual(design.value as? String, "Selected")
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 9))
        shot("fresh-picker-selected", app)
        app.buttons["channel.clear"].tap()
        XCTAssertEqual(design.value as? String, "Not selected")
        XCTAssertEqual(app.buttons["channel.connect"].label, "Save to 1 channel")
        app.buttons["channel.done"].tap()
        app.buttons["capture.destinations"].tap()
        XCTAssertEqual(app.buttons["channel.select.101"].value as? String, "Selected")
        shot("fresh-picker-reset-to-default", app)
    }

    func testPickerSearchKeyboardAndAccessibilitySize() throws {
        let app = launch(large: true, dark: true)
        app.buttons["capture.destinations"].tap()
        let search = app.textFields["channel.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(search.frame.height, 100)
        XCTAssertTrue(app.buttons["channel.selection-options"].isHittable)
        shot("fresh-picker-large-dark", app)
        if #available(iOS 17.0, *) {
            try app.performAccessibilityAudit(for: [.elementDetection, .hitRegion, .sufficientElementDescription, .trait])
        }
        search.tap(); search.typeText("Interface")
        let row = app.buttons["channel.select.102"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.isHittable)
        row.tap()
        XCTAssertEqual(row.value as? String, "Selected")
        shot("fresh-picker-large-keyboard", app)
    }

    func testBlueskyUsesSharedThreadControlAndRetryStaysInPlace() {
        let app = launch("bluesky-error")
        let control = app.switches["capture.thread-import"]
        XCTAssertTrue(control.exists)
        XCTAssertFalse(app.staticTexts["Include connected Bluesky posts"].exists)
        let status = app.otherElements["capture.source-status"]
        let action = app.buttons["Try again"]
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        let original = status.frame
        shot("fresh-source-error", app)
        for index in 0..<2 {
            action.tap()
            XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 2))
            XCTAssertEqual(status.frame.minY, original.minY, accuracy: 2)
            shot("fresh-source-retry-\(index)", app)
            XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 5))
            XCTAssertEqual(status.frame.minY, original.minY, accuracy: 2)
            XCTAssertEqual(status.frame.height, original.height, accuracy: 2)
        }
    }

    func testNativePasteAcceptsURLRepresentationAndRejectsArbitraryText() {
        let url = "https://bsky.app/profile/davidcrespo.bsky.social/post/3mxfymplzic26"
        let valid = launch("empty", clipboardURL: url)
        let paste = valid.buttons["capture.paste"].firstMatch
        XCTAssertTrue(paste.isEnabled)
        XCTAssertGreaterThanOrEqual(paste.frame.height, 44)
        XCTAssertLessThanOrEqual(paste.frame.height, 60)
        XCTAssertLessThan(paste.frame.width, valid.frame.width * 0.45)
        paste.tap()
        let source = valid.textFields["capture.source.1"]
        expectation(for: NSPredicate(format: "value == %@", url), evaluatedWith: source)
        waitForExpectations(timeout: 5)
        shot("fresh-pasted-url", valid)
        valid.terminate()
        let invalid = launch("empty", clipboard: "ordinary clipboard text")
        XCTAssertLessThanOrEqual(invalid.buttons["capture.paste"].firstMatch.frame.height, 60)
        invalid.buttons["capture.paste"].firstMatch.tap()
        XCTAssertFalse((invalid.textFields["capture.source.1"].value as? String ?? "").contains("ordinary clipboard text"))
        XCTAssertFalse(invalid.navigationBars.buttons["Save"].isEnabled)
        shot("fresh-empty-after-invalid-paste", invalid)
        invalid.terminate()
        let large = launch("empty", large: true, dark: true, clipboardURL: url)
        let largePaste = large.buttons["capture.paste"].firstMatch
        let largeSource = large.descendants(matching: .any)["capture.source.1"].firstMatch
        XCTAssertTrue(largePaste.isEnabled); XCTAssertTrue(largePaste.isHittable)
        XCTAssertGreaterThanOrEqual(largePaste.frame.height, 44)
        XCTAssertLessThanOrEqual(largeSource.frame.maxY, largePaste.frame.minY)
        XCTAssertGreaterThan(largeSource.frame.width, large.frame.width * 0.75)
        shot("fresh-empty-large-native-paste", large)
        largePaste.tap()
        expectation(for: NSPredicate(format: "value == %@", url), evaluatedWith: largeSource)
        waitForExpectations(timeout: 5)
        shot("fresh-pasted-url-large", large)
    }

    func testNewXCaptureImportsThreadByDefaultAndCanOptOut() {
        let store = UUID().uuidString
        let url = "https://x.com/example/status/1234567890"
        let app = launch("empty", store: store, clipboardURL: url)
        app.buttons["capture.paste"].firstMatch.tap()
        let source = app.textFields["capture.source.1"]
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        XCTAssertEqual(source.value as? String, url)
        let thread = app.switches["capture.thread-import"].firstMatch
        for _ in 0..<8 where !thread.exists { app.swipeUp() }
        XCTAssertTrue(thread.waitForExistence(timeout: 5))
        XCTAssertEqual(thread.value as? String, "1")
        thread.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertEqual(thread.value as? String, "0")
        app.terminate()
        let reopened = launch("empty", store: store)
        XCTAssertEqual(reopened.switches["capture.thread-import"].firstMatch.value as? String, "0")
    }

    func testNewBlueskyAndDelveCapturesImportThreadsByDefaultAndKeepOptOut() {
        let urls = [
            "https://bsky.app/profile/example.test/post/3mxfymplzic26",
            "https://delve.town/profile/did:plc:2vb3emjr2ttkwc2dj534fdqj/post/3mxe7nb7vfk2u"
        ]
        for url in urls {
            let store = UUID().uuidString
            let app = launch("empty", store: store, clipboardURL: url)
            app.buttons["capture.paste"].firstMatch.tap()
            let source = app.textFields["capture.source.1"]
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "value == %@", url), object: source)], timeout: 5), .completed, url)
            let thread = app.switches["capture.thread-import"].firstMatch
            for _ in 0..<8 where !thread.exists { app.swipeUp() }
            XCTAssertTrue(thread.waitForExistence(timeout: 5), url)
            XCTAssertEqual(thread.value as? String, "1", url)
            thread.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
            XCTAssertEqual(thread.value as? String, "0", url)
            app.terminate()
            let reopened = launch("empty", store: store)
            XCTAssertEqual(reopened.switches["capture.thread-import"].firstMatch.value as? String, "0", url)
            reopened.terminate()
        }
    }

    func testExpandedPostCanBeRemovedAndReturnsToSingleSourceEditor() {
        let app = launch("multi-post")
        let details = app.buttons["capture.source.details.2"]
        XCTAssertTrue(details.waitForExistence(timeout: 5))
        details.tap()
        let remove = app.buttons["capture.source.remove.2"]
        for _ in 0..<8 where !remove.isHittable { app.swipeUp() }
        XCTAssertTrue(remove.isHittable)
        remove.tap()
        XCTAssertFalse(app.buttons["capture.source.details.2"].exists)
        XCTAssertTrue(app.textFields["capture.source.1"].waitForExistence(timeout: 5))
    }

    func testQueuedSavePromotesChosenChannelBeforeRemoteCompletion() {
        let app = launch()
        app.buttons["capture.destinations"].tap()
        let notes = app.buttons["channel.select.103"]
        XCTAssertTrue(notes.waitForExistence(timeout: 5))
        notes.tap()
        app.buttons["channel.connect"].tap()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 10))
        app.buttons["capture.new"].tap()
        app.buttons["capture.destinations"].tap()
        let previous = app.buttons["channel.select.102"]
        XCTAssertTrue(notes.waitForExistence(timeout: 5))
        XCTAssertTrue(previous.waitForExistence(timeout: 5))
        XCTAssertLessThan(notes.frame.minY, previous.frame.minY)
    }

    func testPickerMediumDetentRendersSolidChannelList() {
        let app = launch(halfPicker: true)
        app.buttons["capture.destinations"].tap()
        let close = app.buttons["channel.done"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["channel.select.102"].waitForExistence(timeout: 5))
        shot("picker-medium-opaque", app)
        XCTAssertGreaterThan(close.frame.minY, app.frame.height * 0.35)
    }

    func testPlainTextURLPasteAndVisibleProseRejection() {
        let url = "https://bsky.app/profile/davidcrespo.bsky.social/post/3mxfymplzic26"
        let app = launch("empty", clipboard: url)
        XCTAssertTrue(app.buttons["capture.paste"].firstMatch.isEnabled)
        app.buttons["capture.paste"].firstMatch.tap()
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", url), object: app.textFields["capture.source.1"])
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 5), .completed)
        app.terminate()
        let invalid = launch("empty", clipboard: "An ordinary sentence.")
        invalid.buttons["capture.paste"].firstMatch.tap()
        XCTAssertTrue(invalid.staticTexts["capture.paste-problem"].waitForExistence(timeout: 5))
        shot("paste-rejection", invalid)
    }

    func testAuthoredWritingSurvivesSourceChangesAndRelaunch() {
        let store = UUID().uuidString
        let app = launch(store: store)
        func reveal(_ item: XCUIElement, in app: XCUIApplication) {
            for _ in 0..<8 where !item.isHittable { app.swipeUp() }
            XCTAssertTrue(item.isHittable)
        }
        func dismissKeyboard() {
            if app.buttons["capture.keyboard.done"].isHittable { app.buttons["capture.keyboard.done"].tap() }
        }
        let title = app.textFields["capture.title"]
        reveal(title, in: app); title.tap(); title.typeText(" Authored title marker."); dismissKeyboard()
        let body = app.textFields["capture.description"]
        reveal(body, in: app); body.tap(); body.typeText(" Authored body marker."); dismissKeyboard()
        func assertWriting() {
            reveal(title, in: app)
            XCTAssertTrue((title.value as? String ?? "").contains("Authored title marker."))
            reveal(body, in: app)
            XCTAssertTrue((body.value as? String ?? "").contains("Authored body marker."))
        }
        for _ in 0..<8 where !app.buttons["capture.source.add"].isHittable { app.swipeDown() }
        app.buttons["capture.source.add"].tap()
        let extra = app.textFields["capture.source.2"]
        XCTAssertTrue(extra.waitForExistence(timeout: 5))
        extra.typeText("https://x.com/example/status/1234567890"); dismissKeyboard()
        assertWriting()
        for _ in 0..<8 where !app.switches["capture.source.role.2"].isHittable { app.swipeDown() }
        app.switches["capture.source.role.2"].coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        assertWriting()
        for _ in 0..<8 where !app.buttons["capture.source.details.2"].isHittable { app.swipeDown() }
        app.buttons["capture.source.details.2"].swipeLeft()
        XCTAssertTrue(app.buttons["Remove"].waitForExistence(timeout: 3)); app.buttons["Remove"].tap()
        let source = app.textFields["capture.source.1"]
        XCTAssertTrue(source.waitForExistence(timeout: 3)); source.tap()
        source.press(forDuration: 1)
        let selectAll = app.descendants(matching: .any)["Select All"].firstMatch
        XCTAssertTrue(selectAll.waitForExistence(timeout: 3)); selectAll.tap()
        let replacement = "https://bsky.app/profile/davidcrespo.bsky.social/post/3mxfymplzic26"
        source.typeText(replacement)
        XCTAssertEqual(source.value as? String, replacement)
        dismissKeyboard()
        let thread = app.switches["capture.thread-import"]
        XCTAssertTrue(thread.waitForExistence(timeout: 5))
        thread.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        assertWriting()
        shot("authored-writing-after-source-changes", app)
        app.terminate()
        let reopened = launch(store: store)
        let restoredTitle = reopened.textFields["capture.title"]
        reveal(restoredTitle, in: reopened)
        XCTAssertTrue((restoredTitle.value as? String ?? "").contains("Authored title marker."))
        let restoredBody = reopened.textFields["capture.description"]
        reveal(restoredBody, in: reopened)
        XCTAssertTrue((restoredBody.value as? String ?? "").contains("Authored body marker."))
        shot("authored-writing-after-relaunch", reopened)
    }

    func testEditedDraftPersistsAcrossRelaunch() {
        let store = UUID().uuidString
        let app = launch(store: store)
        let body = app.descendants(matching: .any)["capture.description"].firstMatch
        for _ in 0..<8 where !body.isHittable { app.swipeUp() }
        XCTAssertTrue(body.isHittable)
        body.tap(); body.typeText(" Kept after reopening.")
        app.buttons["capture.keyboard.done"].tap()
        app.terminate()
        let reopened = launch(store: store)
        let restored = reopened.descendants(matching: .any)["capture.description"].firstMatch
        for _ in 0..<8 where !restored.isHittable { reopened.swipeUp() }
        XCTAssertTrue((restored.value as? String ?? "").contains("Kept after reopening."))
        shot("fresh-restored-body-edit", reopened)
    }

    func testLiveBlueskyAcquisitionAndExpansionOff() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else {
            throw XCTSkip("Opt-in public API check; run with TEST_RUNNER_CAPTURE_LIVE_SOURCE_CHECK=1.")
        }
        let url = "https://bsky.app/profile/davidcrespo.bsky.social/post/3mxfymplzic26"
        let app = launch("empty", clipboardURL: url, liveSource: true)
        app.buttons["capture.paste"].firstMatch.tap()
        let title = app.textFields["capture.title"]
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value BEGINSWITH %@", "Post by"), object: title)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 60), .completed)
        let body = app.textFields["capture.description"]
        let expanded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "ok this guy might be specializing in ragebait"), object: body)
        XCTAssertEqual(XCTWaiter.wait(for: [expanded], timeout: 60), .completed)
        XCTAssertFalse(app.buttons["Try again"].exists)
        shot("fresh-live-bluesky-four-posts", app)
        app.buttons["capture.destinations"].tap()
        let preview = app.descendants(matching: .any)["channel.block-preview"].firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        XCTAssertFalse((preview.value as? String ?? "").contains("sources"))
        XCTAssertFalse((preview.value as? String ?? "").contains("`"))
        shot("fresh-live-bluesky-picker", app)
        app.buttons["channel.done"].tap()
        let control = app.switches["capture.thread-import"].firstMatch
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertEqual(control.value as? String, "0")
        let seedOnly = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@ AND NOT value CONTAINS %@", "clicking around on websites", "ok this guy might be specializing in ragebait"), object: body)
        XCTAssertEqual(XCTWaiter.wait(for: [seedOnly], timeout: 60), .completed)
        app.buttons["capture.destinations"].tap()
        XCTAssertTrue(preview.waitForExistence(timeout: 60))
        XCTAssertFalse(app.staticTexts["capture.source-summary"].exists)
        shot("fresh-live-bluesky-expansion-off", app)
    }

    private func liveFixtureValue(_ key: String) throws -> String {
        guard let path = ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_FIXTURE"] else {
            throw XCTSkip("Supply a private live-source fixture through CAPTURE_LIVE_SOURCE_FIXTURE.")
        }
        let values = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: String]
        guard let value = values?[key], !value.isEmpty else {
            throw XCTSkip("Supply \(key) in the private live-source fixture.")
        }
        return value
    }

    func testLiveDelveATURIThreadOffEditedDraftAndPicker() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else {
            throw XCTSkip("Opt-in public API check; run with TEST_RUNNER_CAPTURE_LIVE_SOURCE_CHECK=1.")
        }
        let store = UUID().uuidString
        let uri = try liveFixtureValue("chainURI")
        let app = launch("empty", store: store, clipboard: uri, liveSource: true)
        app.buttons["capture.paste"].firstMatch.tap()
        let body = app.staticTexts["capture.text.content"]
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", try liveFixtureValue("rootText"), try liveFixtureValue("seedText")), object: body)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 60), .completed)
        let control = app.switches["capture.thread-import"].firstMatch
        XCTAssertTrue(control.exists)
        XCTAssertEqual(control.value as? String, "1")
        shot("delve-live-three-post-thread", app)
        app.buttons["capture.destinations"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["channel.block-preview"].firstMatch.waitForExistence(timeout: 10))
        shot("delve-live-picker", app)
        app.buttons["channel.done"].tap()
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        let onlySeed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@ AND NOT label CONTAINS %@", try liveFixtureValue("quotedAuthor"), try liveFixtureValue("rootText")), object: body)
        XCTAssertEqual(XCTWaiter.wait(for: [onlySeed], timeout: 60), .completed)
        XCTAssertEqual(control.value as? String, "0")
        shot("delve-live-expansion-off", app)
        let title = app.textFields["capture.title"]
        title.tap(); title.typeText(" — Kept edit")
        app.buttons["capture.keyboard.done"].firstMatch.tap()
        app.terminate()
        let reopened = launch("empty", store: store, liveSource: true)
        XCTAssertTrue((reopened.textFields["capture.title"].value as? String ?? "").contains("Kept edit"))
        XCTAssertEqual(reopened.switches["capture.thread-import"].firstMatch.value as? String, "0")
        shot("delve-restored-edited-draft", reopened)
    }

    func testLiveDelveQuoteAndExternalCard() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else {
            throw XCTSkip("Opt-in public API check; run with TEST_RUNNER_CAPTURE_LIVE_SOURCE_CHECK=1.")
        }
        let app = launch("empty", clipboardURL: try liveFixtureValue("quoteCardURL"), liveSource: true)
        app.buttons["capture.paste"].firstMatch.tap()
        let body = app.staticTexts["capture.text.content"]
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", try liveFixtureValue("cardText"), try liveFixtureValue("cardTarget")), object: body)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 60), .completed)
        XCTAssertFalse(app.buttons["Try again"].exists)
        shot("delve-live-quote-and-card", app)
        app.buttons["capture.destinations"].tap()
        let preview = app.descendants(matching: .any)["channel.block-preview"].firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 10))
        XCTAssertFalse((preview.value as? String ?? "").contains("sources"))
        shot("delve-live-card-picker", app)
    }

    func testLiveDelveImagesRenderAndSelectionPersists() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else {
            throw XCTSkip("Opt-in public API check; run with TEST_RUNNER_CAPTURE_LIVE_SOURCE_CHECK=1.")
        }
        func reveal(_ item: XCUIElement, app: XCUIApplication) {
            for _ in 0..<8 where !item.isHittable { app.swipeUp() }
            XCTAssertTrue(item.isHittable)
        }
        for (name, url, count) in [("single", try liveFixtureValue("singleImageURL"), 1), ("quote-two", try liveFixtureValue("twoImageURL"), 2)] {
            let app = launch("empty", clipboardURL: url, liveSource: true)
            app.buttons["capture.paste"].firstMatch.tap()
            let control = app.switches["capture.thread-import"].firstMatch
            XCTAssertTrue(control.waitForExistence(timeout: 15))
            let readyToChoose = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: control)
            XCTAssertEqual(XCTWaiter.wait(for: [readyToChoose], timeout: 60), .completed)
            if control.value as? String != "0" { control.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap() }
            let first = app.buttons["capture.media.asset.1.1"]
            XCTAssertTrue(first.waitForExistence(timeout: 60))
            reveal(first, app: app)
            shot("delve-live-\(name)-image", app)
            if count == 2 {
                let all = app.buttons["capture.media.all"]
                reveal(all, app: app); all.tap()
                let second = app.buttons["capture.media.asset.1.2"]
                reveal(second, app: app)
                XCTAssertEqual(second.value as? String, "Included")
                let preview = app.buttons["capture.composition-preview.start"]
                reveal(preview, app: app); preview.tap()
                let image = app.descendants(matching: .any)["capture.composition-preview.image"].firstMatch
                for _ in 0..<8 where !image.exists || !image.isHittable { app.swipeUp() }
                XCTAssertTrue(image.waitForExistence(timeout: 30))
                reveal(image, app: app)
                shot("delve-live-two-image-composition", app)
                app.swipeUp()
                shot("delve-live-two-image-composition-full", app)
            } else {
                XCTAssertEqual(first.value as? String, "Included")
                first.tap()
                XCTAssertEqual(first.value as? String, "Excluded")
                first.tap()
                XCTAssertEqual(first.value as? String, "Included")
            }
            app.terminate()
        }
    }

    func testLiveDelveAccessibilitySizeThreadAndPicker() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else {
            throw XCTSkip("Opt-in public API check; run with TEST_RUNNER_CAPTURE_LIVE_SOURCE_CHECK=1.")
        }
        let app = launch("empty", large: true, clipboard: try liveFixtureValue("chainURI"), liveSource: true)
        let paste = app.buttons["capture.paste"].firstMatch
        XCTAssertTrue(paste.isHittable); paste.tap()
        let title = app.textFields["capture.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 60))
        let control = app.switches["capture.thread-import"].firstMatch
        for _ in 0..<8 where !control.isHittable { app.swipeUp() }
        XCTAssertTrue(control.isHittable)
        XCTAssertGreaterThanOrEqual(control.frame.height, 44)
        shot("delve-accessibility-thread-control", app)
        let destination = app.buttons["capture.destinations"]
        for _ in 0..<8 where !destination.isHittable { app.swipeUp() }
        XCTAssertTrue(destination.isHittable); destination.tap()
        let preview = app.descendants(matching: .any)["channel.block-preview"].firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["channel.done"].isHittable)
        shot("delve-accessibility-picker", app)
    }

    func testHistoryNativeSwipeDeletionUndoAndSettings() {
        let app = launch()
        app.tabBars.buttons["History"].tap()
        shot("fresh-history", app)
        let row = app.cells.containing(.staticText, identifier: "Saved").firstMatch
        XCTAssertTrue(row.exists)
        row.swipeLeft()
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 3))
        app.buttons["Delete"].tap()
        app.buttons["history.undo-delete"].tap()
        XCTAssertTrue(app.staticTexts["Saved"].exists)
        app.tabBars.buttons["Settings"].tap()
        shot("fresh-settings", app)
        XCTAssertTrue(app.staticTexts["Drafts"].exists)
    }

    func testLargeCaptureHistorySettingsAndAccessibilityAudit() throws {
        let app = launch(large: true)
        shot("fresh-capture-large", app)
        app.tabBars.buttons["History"].tap(); shot("fresh-history-large", app)
        app.tabBars.buttons["Settings"].tap(); shot("fresh-settings-large", app)
        app.tabBars.buttons["Capture"].tap()
        if #available(iOS 17.0, *) {
            try app.performAccessibilityAudit(for: [.elementDetection, .hitRegion, .sufficientElementDescription, .trait])
        }
    }
}
