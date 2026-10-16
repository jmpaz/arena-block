import XCTest

final class SubstackHTTPNoteUITests: XCTestCase {
    func testRetainedHTTPLinkNoteShowsFullQuoteAndFiveImageComposition() throws {
        guard let capture = ProcessInfo.processInfo.environment["CAPTURE_REVIEW_HTTP_NOTE_CAPTURE"] else {
            throw XCTSkip("Supply the complete retained public Note record for a local preview check.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CAPTURE_UI_FIXTURE": "empty", "CAPTURE_UI_STORE_ID": UUID().uuidString,
            "CAPTURE_UI_LIVE_SOURCE": "1", "CAPTURE_UI_REDDIT_CAPTURE": capture,
            "CAPTURE_UI_CLIPBOARD": "", "CAPTURE_UI_CLIPBOARD_URL": "", "CAPTURE_UI_STYLE": "light"]
        app.launch()
        defer { app.terminate() }
        let title = app.textFields["capture.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 20))
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Note by @joodaloop"), object: title)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 20), .completed)
        let writing = app.textFields["capture.description"].value as? String ?? ""
        XCTAssertTrue(writing.contains("http://nicochilla.com"))
        XCTAssertTrue(writing.contains("and a themed grid at that!"))
        XCTAssertTrue(writing.contains("alexanderobenauer.com"))
        XCTAssertTrue(writing.contains("357819575"))
        let expansion = app.buttons["capture.text.expansion"]
        if expansion.exists && expansion.isHittable { expansion.tap() }
        let image = app.buttons["capture.media.asset.1.5"]
        for _ in 0..<12 where !image.isHittable { app.swipeUp() }
        XCTAssertTrue(image.waitForExistence(timeout: 20))
        XCTAssertTrue(image.label.contains("Quoted from @joodaloop"))
        let preview = app.buttons["capture.composition-preview.start"]
        for _ in 0..<10 where !preview.isHittable { app.swipeUp() }
        XCTAssertTrue(preview.isHittable); preview.tap()
        let mosaic = app.descendants(matching: .any)["capture.composition-preview.image"].firstMatch
        XCTAssertTrue(app.buttons["capture.composition-preview.hide"].waitForExistence(timeout: 30))
        for _ in 0..<12 where !mosaic.isHittable { app.swipeUp() }
        XCTAssertTrue(mosaic.waitForExistence(timeout: 10))
        XCTAssertGreaterThan(mosaic.frame.height, 100)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "actual-http-note-five-image-composition"
        screenshot.lifetime = .keepAlways; add(screenshot)
    }
}
