import XCTest

final class SubstackThreadControlsUITests: XCTestCase {
    func testNoteThreadIsOptInAndChoiceSurvivesRelaunch() {
        continueAfterFailure = false
        let store = UUID().uuidString
        let source = "https://substack.com/@writer/note/c-123"
        func launch() -> XCUIApplication {
            let app = XCUIApplication()
            app.launchEnvironment = ["CAPTURE_UI_FIXTURE": "empty", "CAPTURE_UI_STORE_ID": store,
                "CAPTURE_UI_CLIPBOARD_URL": source, "CAPTURE_UI_CLIPBOARD": "", "CAPTURE_UI_LIVE_SOURCE": "0"]
            app.launch()
            return app
        }
        let app = launch()
        XCTAssertTrue(app.buttons["capture.paste"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["capture.paste"].firstMatch.tap()
        let toggle = app.switches["capture.thread-import"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertTrue(toggle.isEnabled)
        XCTAssertEqual(toggle.value as? String, "0")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "1"), object: toggle)], timeout: 5), .completed)
        XCTAssertFalse(app.buttons["Import browser capture"].exists)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "substack-note-thread-opt-in"; attachment.lifetime = .keepAlways; add(attachment)
        app.terminate()
        let reopened = launch()
        let restored = reopened.switches["capture.thread-import"]
        XCTAssertTrue(restored.waitForExistence(timeout: 10))
        XCTAssertEqual(restored.value as? String, "1")
        XCTAssertFalse(reopened.buttons["Import browser capture"].exists)
    }
}
