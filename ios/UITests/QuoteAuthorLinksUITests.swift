import XCTest

/// Local fixture only; does not read a remote source or press Save/Continue.
final class QuoteAuthorLinksUITests: XCTestCase {
    private func launch(store: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "quoted"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = store
        app.launch()
        XCTAssertTrue(app.buttons["capture.destinations"].waitForExistence(timeout: 10))
        return app
    }

    private func picker(in app: XCUIApplication) -> XCUIElement {
        let control = app.descendants(matching: .any)["capture.quote-author-link"].firstMatch
        for _ in 0..<6 where !control.isHittable { app.swipeUp() }
        XCTAssertTrue(control.waitForExistence(timeout: 5)); XCTAssertTrue(control.isHittable)
        return control
    }

    private func expectStyle(_ style: String, in app: XCUIApplication) {
        let control = picker(in: app)
        let matches = NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", style, style)
        expectation(for: matches, evaluatedWith: control)
        waitForExpectations(timeout: 10)
    }

    func testQuotedAuthorChoiceRestoresWithoutSavingOrChangingQuoteScope() {
        continueAfterFailure = false
        let store = UUID().uuidString
        let app = launch(store: store)
        expectStyle("Keep current style", in: app)
        let scope = app.descendants(matching: .any)["capture.quote-depth"].firstMatch
        let originalScope = scope.value as? String
        picker(in: app).tap(); app.buttons["Link to quoted post"].tap()
        expectStyle("Link to quoted post", in: app)
        XCTAssertEqual(scope.value as? String, originalScope)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "quoted-author-link-to-post"; image.lifetime = .keepAlways; add(image)
        app.terminate()
        let reopened = launch(store: store)
        expectStyle("Link to quoted post", in: reopened)
        picker(in: reopened).tap(); reopened.buttons["Name only"].tap()
        expectStyle("Name only", in: reopened)
        let plain = XCTAttachment(screenshot: reopened.screenshot())
        plain.name = "quoted-author-name-only"; plain.lifetime = .keepAlways; add(plain)
        picker(in: reopened).tap(); reopened.buttons["Keep current style"].tap()
        expectStyle("Keep current style", in: reopened)
    }
}
