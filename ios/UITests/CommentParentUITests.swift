import XCTest

/// Opt-in public source reads only. Never presses Save or Continue.
final class CommentParentUITests: XCTestCase {
    func testActualForumParentsToggleAndRestoreWithoutChangingSelectedSource() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else {
            throw XCTSkip("Run with TEST_RUNNER_CAPTURE_LIVE_SOURCE_CHECK=1 for public comment previews.")
        }
        continueAfterFailure = false
        for (name, source, parent) in [
            ("hn", "https://news.ycombinator.com/item?id=50341020", "sourpanda"),
            ("lobsters", "https://lobste.rs/c/uyjo8l", "kwas")
        ] {
            let store = UUID().uuidString
            func launch(_ clipboard: String) -> XCUIApplication {
                let app = XCUIApplication()
                app.launchEnvironment = ["CAPTURE_UI_FIXTURE":"empty", "CAPTURE_UI_STORE_ID":store,
                    "CAPTURE_UI_LIVE_SOURCE":"1", "CAPTURE_UI_CLIPBOARD":clipboard, "CAPTURE_UI_CLIPBOARD_URL":""]
                app.launch()
                XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout: 15))
                return app
            }
            func picker(_ key: String, _ app: XCUIApplication) -> XCUIElement {
                let control = app.descendants(matching: .any)[key].firstMatch
                for _ in 0..<5 where !control.isHittable { app.swipeUp() }
                XCTAssertTrue(control.waitForExistence(timeout: 20)); XCTAssertTrue(control.isHittable)
                return control
            }
            func visibleText(_ app: XCUIApplication) -> String {
                let content = app.descendants(matching: .any)["capture.text.content"].firstMatch
                guard content.exists else { return "" }
                if content.elementType == .staticText { return content.label }
                return content.descendants(matching: .staticText).allElementsBoundByIndex.map(\.label).joined(separator: "\n\n")
            }
            let app = launch(source)
            app.buttons["capture.paste"].firstMatch.tap()
            let depth = picker("capture.parent-depth", app)
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: depth)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed)
            let body = app.descendants(matching: .any)["capture.text.content"].firstMatch
            XCTAssertTrue(body.waitForExistence(timeout: 10)); let selected = visibleText(app)
            depth.tap(); app.buttons["1 level"].tap()
            let expanded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in visibleText(app).contains(parent) }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [expanded], timeout: 20), .completed)
            XCTAssertFalse(visibleText(app).contains("`")); XCTAssertFalse(visibleText(app).contains("---"))
            let flat = XCTAttachment(screenshot: app.screenshot()); flat.name = "\(name)-parent-flat"; flat.lifetime = .keepAlways; add(flat)
            picker("capture.parent-style", app).tap(); app.buttons["Nested quotes"].tap()
            let quote = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in visibleText(app).contains("@" + parent) }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [quote], timeout: 20), .completed)
            let nested = XCTAttachment(screenshot: app.screenshot()); nested.name = "\(name)-parent-nested"; nested.lifetime = .keepAlways; add(nested)
            app.terminate()
            let restored = launch("")
            let style = picker("capture.parent-style", restored)
            let restoredStyle = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in visibleText(restored).contains("@" + parent) }, object: style)
            XCTAssertEqual(XCTWaiter.wait(for: [restoredStyle], timeout: 20), .completed)
            let replay = XCTAttachment(screenshot: restored.screenshot()); replay.name = "\(name)-parent-restored"; replay.lifetime = .keepAlways; add(replay)
            picker("capture.parent-depth", restored).tap(); restored.buttons["Selected comment only"].tap()
            let restoredBody = restored.descendants(matching: .any)["capture.text.content"].firstMatch
            let zero = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in visibleText(restored) == selected }, object: restoredBody)
            XCTAssertEqual(XCTWaiter.wait(for: [zero], timeout: 20), .completed)
            app.terminate(); restored.terminate()
        }
    }
}
