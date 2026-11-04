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
        let disclosure = app.descendants(matching: .any)["capture.source-details"].firstMatch
        for _ in 0..<5 where !disclosure.isHittable { app.swipeUp() }
        disclosure.tap()
        let source = app.textFields["capture.source-override"]
        XCTAssertTrue(source.waitForExistence(timeout: 5)); source.tap()
        source.typeText("https://example.com/article")
        XCTAssertTrue(app.descendants(matching: .any)["capture.pdf-link"].firstMatch.waitForExistence(timeout: 5))
        let resolved = app.descendants(matching: .any)["capture.resolved-link"].firstMatch
        XCTAssertTrue(resolved.waitForExistence(timeout: 5))
        XCTAssertTrue(resolved.label.contains("https://example.com/article"))
        app.buttons["Done"].tap()
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
