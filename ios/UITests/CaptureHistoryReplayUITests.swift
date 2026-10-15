import XCTest

/// Opt-in replay of an explicitly supplied, credential-free local history copy.
/// No delivery jobs are seeded and no Save action is invoked.
final class CaptureHistoryReplayUITests: XCTestCase {
    func testRepeatedHistoryDetailBackAndForegroundTransitions() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let storeID = environment["CAPTURE_UI_HISTORY_REPLAY_STORE_ID"], UUID(uuidString: storeID) != nil,
              let rowID = environment["CAPTURE_UI_HISTORY_REPLAY_ROW_ID"], UUID(uuidString: rowID) != nil else {
            throw XCTSkip("Requires an explicitly prepared local history replay.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["CAPTURE_UI_FIXTURE"] = "empty"
        app.launchEnvironment["CAPTURE_UI_STORE_ID"] = storeID
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["History"].waitForExistence(timeout: 15))
        let historyRow = app.descendants(matching: .any).matching(identifier: "history.capture." + rowID).firstMatch
        for cycle in 0..<8 {
            if app.tabBars.buttons["Active"].exists {
                let started = ProcessInfo.processInfo.systemUptime
                app.tabBars.buttons["Active"].tap()
                XCTAssertTrue(historyRow.waitForExistence(timeout: 10))
                record("active", cycle: cycle, started: started)
            }
            let started = ProcessInfo.processInfo.systemUptime
            app.tabBars.buttons["History"].tap()
            XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
            record("history", cycle: cycle, started: started)
            if !historyRow.exists, app.tabBars.buttons["Active"].exists { app.tabBars.buttons["Active"].tap() }
            XCTAssertTrue(historyRow.waitForExistence(timeout: 10))
            let detailStarted = ProcessInfo.processInfo.systemUptime
            historyRow.tap()
            XCTAssertTrue(app.navigationBars.buttons["History"].waitForExistence(timeout: 10)
                || app.navigationBars.buttons["Active"].exists)
            record("detail", cycle: cycle, started: detailStarted)
            let backStarted = ProcessInfo.processInfo.systemUptime
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
            if app.navigationBars.buttons["History"].isHittable { app.navigationBars.buttons["History"].tap() }
            else if app.navigationBars.buttons["Active"].isHittable { app.navigationBars.buttons["Active"].tap() }
            XCTAssertTrue(historyRow.waitForExistence(timeout: 10))
            record("back", cycle: cycle, started: backStarted)
            app.tabBars.buttons["Capture"].tap()
            if cycle == 3 {
                XCUIDevice.shared.press(.home)
                app.activate()
                XCTAssertTrue(app.tabBars.buttons["History"].waitForExistence(timeout: 10))
            }
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "history-replay-after-transitions"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func record(_ transition: String, cycle: Int, started: TimeInterval) {
        let milliseconds = (ProcessInfo.processInfo.systemUptime - started) * 1000
        print("CAPTURE_HISTORY_REPLAY transition=\(transition) cycle=\(cycle) milliseconds=\(milliseconds)")
    }
}
