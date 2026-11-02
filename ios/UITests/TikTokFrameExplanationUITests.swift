import XCTest

/// Public preview only; never submits, repairs or removes an Are.na block.
final class TikTokFrameExplanationUITests: XCTestCase {
    func test707SecondTikTokDefaultsToVideoAndBothChoicesRestore() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SOURCE_CHECK"] == "1" else { throw XCTSkip("Run with TEST_RUNNER_CAPTURE_LIVE_SOURCE_CHECK=1.") }
        continueAfterFailure = false
        let store=UUID().uuidString
        func launch(_ clipboard:String) -> XCUIApplication {
            let app=XCUIApplication()
            app.launchEnvironment=["CAPTURE_UI_FIXTURE":"empty","CAPTURE_UI_STORE_ID":store,"CAPTURE_UI_LIVE_SOURCE":"1","CAPTURE_UI_CLIPBOARD":clipboard,"CAPTURE_UI_CLIPBOARD_URL":""]
            app.launch();XCTAssertTrue(app.tabBars.buttons["Capture"].waitForExistence(timeout:15));return app
        }
        func choice(_ app:XCUIApplication) -> XCUIElement {
            let control=app.segmentedControls["capture.media.choice.1.1"]
            XCTAssertTrue(control.waitForExistence(timeout:60))
            for _ in 0..<5 where !control.isHittable {app.swipeUp()}
            return control
        }
        let app=launch("https://www.tiktok.com/@thechristopheralexander/video/7703354368283708703")
        app.buttons["capture.paste"].firstMatch.tap()
        let control=choice(app)
        let selected=XCTNSPredicateExpectation(predicate:NSPredicate(format:"selected == true"),object:control.buttons["Video"])
        XCTAssertEqual(XCTWaiter.wait(for:[selected],timeout:30),.completed)
        XCTAssertTrue(control.buttons["Frame"].exists)
        control.buttons["Frame"].tap()
        let notice=app.staticTexts["capture.media.frame-explanation.1.1"]
        XCTAssertTrue(notice.waitForExistence(timeout:10));XCTAssertTrue(notice.label.contains("still frame"))
        control.buttons["Video"].tap()
        let moving=XCTNSPredicateExpectation(predicate:NSPredicate(format:"selected == true"),object:control.buttons["Video"])
        XCTAssertEqual(XCTWaiter.wait(for:[moving],timeout:10),.completed)
        let screenshot=XCTAttachment(screenshot:app.screenshot());screenshot.name="tiktok-707s-default-video";screenshot.lifetime = .keepAlways;add(screenshot)
        app.terminate()
        let restored=launch("")
        XCTAssertTrue(choice(restored).buttons["Video"].isSelected)
        choice(restored).buttons["Frame"].tap()
        XCTAssertTrue(choice(restored).buttons["Frame"].isSelected)
        restored.terminate()
        let frame=launch("")
        XCTAssertTrue(choice(frame).buttons["Frame"].isSelected)
        frame.terminate()
    }
    func testAboveDefaultFrameStillAllowsVideoAndRestoresIt() {
        continueAfterFailure = false
        let store=UUID().uuidString
        func launch() -> XCUIApplication {
            let app=XCUIApplication();app.launchEnvironment=["CAPTURE_UI_FIXTURE":"video-frame","CAPTURE_UI_STORE_ID":store,"CAPTURE_UI_VIDEO_DURATION":"1501"]
            app.launch();return app
        }
        func control(_ app:XCUIApplication) -> XCUIElement {
            let choice=app.segmentedControls["capture.media.choice.1.1"]
            XCTAssertTrue(choice.waitForExistence(timeout:15))
            for _ in 0..<5 where !choice.isHittable {app.swipeUp()}
            return choice
        }
        let app=launch(),choice=control(app)
        XCTAssertTrue(choice.buttons["Frame"].isSelected)
        XCTAssertTrue(choice.buttons["Video"].isEnabled)
        choice.buttons["Video"].tap()
        XCTAssertTrue(choice.buttons["Video"].isSelected)
        choice.buttons["Frame"].tap();XCTAssertTrue(choice.buttons["Frame"].isSelected)
        choice.buttons["Video"].tap();app.terminate()
        let restored=launch();XCTAssertTrue(control(restored).buttons["Video"].isSelected)
        let screenshot=XCTAttachment(screenshot:restored.screenshot());screenshot.name="above-25m-explicit-video-restored";screenshot.lifetime = .keepAlways;add(screenshot)
        restored.terminate()
    }

}
