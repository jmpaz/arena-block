import XCTest

final class PDFPreviewUITests: XCTestCase {
    func testPDFPreviewAndSourceOverrideKeepEditedTitle() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "pdf"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        app.launch()
        let title = app.textFields["capture.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.value as? String, "A paper about interfaces")
        title.tap(); title.typeText(" - notes")
        app.buttons["Done"].tap()
        let preview = app.buttons["capture.pdf-preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "pdf-editor"; before.lifetime = .keepAlways; add(before)
        preview.tap()
        let close = app.buttons["capture.pdf.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        let document = XCTAttachment(screenshot: app.screenshot()); document.name = "pdf-document"; document.lifetime = .keepAlways; add(document)
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
        let disclosure = app.buttons["Source link"]
        for _ in 0..<5 where !disclosure.isHittable { app.swipeUp() }
        disclosure.tap()
        let source = app.textFields["capture.source-override"]
        XCTAssertTrue(source.waitForExistence(timeout: 5)); source.tap()
        source.typeText("https://example.com/article")
        XCTAssertTrue(app.descendants(matching: .any)["capture.pdf-link"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        let resolved = app.descendants(matching: .any)["capture.resolved-link"].firstMatch
        for _ in 0..<5 where !resolved.isHittable { app.swipeUp() }
        XCTAssertTrue(resolved.waitForExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "https://example.com/article"), object: resolved)], timeout: 5), .completed)
        for _ in 0..<4 where !title.isHittable { app.swipeDown() }
        XCTAssertTrue((title.value as? String ?? "").contains("notes"))
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "pdf-source-override"; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testLiveExtensionlessPDFPreview() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_PDF"] == "1" else { throw XCTSkip("Opt-in public PDF preview; no save.") }
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "empty"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        app.launchEnvironment["CAPTURE_UI_LIVE_SOURCE"] = "1"
        app.launchEnvironment["CAPTURE_UI_CLIPBOARD_URL"] = "https://pure.mpg.de/rest/items/item_3493256_8/component/file_3505426/content"
        app.launch()
        XCTAssertTrue(app.buttons["capture.paste"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["capture.paste"].firstMatch.tap()
        let title = app.textFields["capture.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 80))
        XCTAssertEqual(title.value as? String, "Negotiating Experience and Communicating Information Through Abstract Metaphor")
        let preview = app.buttons["capture.pdf-preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        XCTAssertTrue(preview.label.contains("16 pages"))
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "live-pdf-preview"; attachment.lifetime = .keepAlways; add(attachment)
    }
}

extension PDFPreviewUITests {
    func testLocalPDFPreviewRequiresSourceAndSurvivesRelaunch() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "pdf-file"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        app.launch()
        let preview = app.buttons["capture.pdf-preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        preview.tap()
        XCTAssertTrue(app.buttons["capture.pdf.close"].waitForExistence(timeout: 5))
        app.buttons["capture.pdf.close"].tap()
        let source = app.textFields["capture.source.1"]
        for _ in 0..<4 where !source.isHittable { app.swipeDown() }
        source.tap(); source.typeText("https://example.com/citation")
        app.buttons["Done"].tap()
        let save = app.buttons["Save"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: save)], timeout: 10), .completed)
        let title = app.textFields["capture.title"]
        for _ in 0..<4 where !title.isHittable { app.swipeUp() }
        title.tap(); title.press(forDuration: 1)
        let selectAll = app.descendants(matching: .any)["Select All"].firstMatch
        XCTAssertTrue(selectAll.waitForExistence(timeout: 3)); selectAll.tap()
        title.typeText("My notes on interfaces"); app.buttons["Done"].tap()
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "imported-pdf-source"; shot.lifetime = .keepAlways; add(shot)
        app.terminate(); app.launch()
        XCTAssertTrue(preview.waitForExistence(timeout: 10))
        XCTAssertEqual(title.value as? String, "My notes on interfaces")
        XCTAssertTrue(app.buttons["Save"].isEnabled)
    }

    func testHostConfirmationOffersImportAndRetainsChosenSource() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "pdf-host-confirmation"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = UUID().uuidString
        app.launch()
        XCTAssertTrue(app.buttons["capture.pdf-import"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        let recovery = app.descendants(matching: .any)["capture.pdf-browser"].firstMatch
        XCTAssertTrue(recovery.waitForExistence(timeout: 5))
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "pdf-host-confirmation"; before.lifetime = .keepAlways; add(before)
        app.buttons["capture.pdf-import"].tap()
        let cancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 10)); cancel.tap()
        XCTAssertFalse(app.buttons["capture.pdf-preview"].exists)
        app.terminate()
        // Supply safe downloaded bytes through the same production import method.
        app.launchEnvironment["CAPTURE_UI_IMPORT_PDF"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["capture.pdf-preview"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["capture.pdf-filename"].exists)
        XCTAssertTrue(app.buttons["Save"].isEnabled)
        let field = app.textFields["capture.source.1"]
        for _ in 0..<4 where !field.isHittable { app.swipeDown() }
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
        field.press(forDuration: 1.2)
        let selectAll = app.descendants(matching: .any)["Select All"].firstMatch
        XCTAssertTrue(selectAll.waitForExistence(timeout: 3)); selectAll.tap()
        field.typeText("https://example.com/doi"); app.buttons["Done"].tap()
        XCTAssertEqual(field.value as? String, "https://example.com/doi")
        let after = XCTAttachment(screenshot: app.screenshot()); after.name = "pdf-confirmed-import"; after.lifetime = .keepAlways; add(after)
        XCTAssertTrue(app.buttons["Save"].isEnabled)
    }
}
