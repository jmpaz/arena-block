import XCTest

final class SubstackQuotedMediaUITests: XCTestCase {
    func testActualQuotedVideosKeepOwnerFrameChoiceAndDepthThroughFreshShare() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SUBSTACK_QUOTED_MEDIA"] == "1" else {
            throw XCTSkip("Opt-in public quoted-video preview; no Save or Continue.")
        }
        continueAfterFailure = false
        for (handle,id) in [("laurelpantin","345777657"),("arr87","353698796")] {
            let app = XCUIApplication(), canonical = "https://substack.com/@\(handle)/note/c-\(id)"
            app.launchEnvironment = ["CAPTURE_UI_FIXTURE":"empty","CAPTURE_UI_STORE_ID":UUID().uuidString,
                "CAPTURE_UI_COMPOSER":"share","CAPTURE_UI_PRESENTATION":"share","CAPTURE_UI_LIVE_SOURCE":"1",
                "CAPTURE_UI_FRESH_SHARE":"1","CAPTURE_UI_SHARE_DELAY_MS":"500","CAPTURE_UI_SHARE_INTAKE":"url",
                "CAPTURE_UI_SHARE_URL":canonical,"CAPTURE_UI_CLIPBOARD":"","CAPTURE_UI_CLIPBOARD_URL":"","CAPTURE_UI_STYLE":"light"]
            app.launch()
            let title = app.textFields["capture.title"]
            let ready = XCTNSPredicateExpectation(predicate:NSPredicate(format:"value == %@","Note by @\(handle)"),object:title)
            XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:60),.completed)
            let description = app.textFields["capture.description"].value as? String ?? ""
            XCTAssertTrue(description.contains("@substack"))
            if id == "345777657" {
                XCTAssertTrue(description.contains("It’s me!") || description.contains("It's me!"))
                let choices = app.segmentedControls["capture.media.choice.1.1"]
                for _ in 0..<8 where !choices.isHittable { app.swipeUp() }
                XCTAssertTrue(choices.waitForExistence(timeout:20))
                XCTAssertTrue(app.staticTexts["Video · Quoted from @substack"].exists)
                choices.buttons["Frame"].tap()
            } else {
                let quote = app.buttons["capture.media.asset.1.2"]
                for _ in 0..<8 where !quote.isHittable { app.swipeUp() }
                XCTAssertTrue(quote.waitForExistence(timeout:20)); XCTAssertTrue(quote.label.contains("Quoted from @substack"))
                let frame = app.buttons["capture.media.frame.1.2"]
                XCTAssertTrue(frame.isHittable); frame.tap()
                let choose = app.buttons["Frame from video"]
                XCTAssertTrue(choose.waitForExistence(timeout:10)); choose.tap()
            }
            let preview = app.buttons["capture.composition-preview.start"]
            for _ in 0..<8 where !preview.isHittable { app.swipeUp() }
            XCTAssertTrue(preview.waitForExistence(timeout:20)); preview.tap()
            let image = app.descendants(matching:.any)["capture.composition-preview.image"].firstMatch
            for _ in 0..<8 where !image.isHittable { app.swipeUp() }
            XCTAssertTrue(image.waitForExistence(timeout:30)); XCTAssertGreaterThan(image.frame.height,100)
            let screenshot = XCTAttachment(screenshot:app.screenshot())
            screenshot.name = "actual-quoted-video-\(id)-frame-preview"; screenshot.lifetime = .keepAlways; add(screenshot)
            if id == "353698796" {
                let depth = app.buttons["capture.quote-depth"]
                for _ in 0..<8 where !depth.isHittable { app.swipeUp() }
                XCTAssertTrue(depth.isHittable); depth.tap()
                let rootOnly = app.buttons["Root only"]
                XCTAssertTrue(rootOnly.waitForExistence(timeout:10)); rootOnly.tap()
                XCTAssertFalse(app.buttons["capture.media.asset.1.2"].exists)
                for _ in 0..<8 where !depth.isHittable { app.swipeUp() }
                depth.tap()
                let two = app.buttons["Up to 2 levels"]
                XCTAssertTrue(two.waitForExistence(timeout:10)); two.tap()
                let frame = app.buttons["capture.media.frame.1.2"]
                for _ in 0..<8 where !frame.isHittable { app.swipeDown() }
                XCTAssertTrue(frame.waitForExistence(timeout:20)); XCTAssertTrue(frame.label.contains("Frame"))
            }
            app.terminate()
        }
    }
}

extension SubstackQuotedMediaUITests {
    func testActualQuotedVideoSoundtrackMixSurvivesQuoteDepthChanges() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SUBSTACK_QUOTED_MEDIA"] == "1" else {
            throw XCTSkip("Opt-in public soundtrack controls; no Save or Continue.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CAPTURE_UI_FIXTURE":"empty","CAPTURE_UI_STORE_ID":UUID().uuidString,
            "CAPTURE_UI_COMPOSER":"share","CAPTURE_UI_PRESENTATION":"share","CAPTURE_UI_LIVE_SOURCE":"1",
            "CAPTURE_UI_FRESH_SHARE":"1","CAPTURE_UI_SHARE_DELAY_MS":"500","CAPTURE_UI_SHARE_INTAKE":"url",
            "CAPTURE_UI_SHARE_URL":"https://substack.com/@laurelpantin/note/c-345777657",
            "CAPTURE_UI_CLIPBOARD":"","CAPTURE_UI_CLIPBOARD_URL":"","CAPTURE_UI_STYLE":"light"]
        app.launch()
        let title = app.textFields["capture.title"]
        let ready = XCTNSPredicateExpectation(predicate:NSPredicate(format:"value == %@","Note by @laurelpantin"),object:title)
        XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:60),.completed)
        let addButton = app.buttons["capture.source.add"]
        for _ in 0..<8 where !addButton.isHittable { app.swipeDown() }
        XCTAssertTrue(addButton.isHittable); addButton.tap()
        let second = app.textFields["capture.source.2"]
        XCTAssertTrue(second.waitForExistence(timeout:10)); second.tap()
        second.typeText("https://substack.com/@arr87/note/c-353698796")
        let keyboardDone = app.buttons["capture.keyboard.done"]
        if keyboardDone.waitForExistence(timeout:5) { keyboardDone.tap() }
        let audio = app.buttons["capture.audio-choice"]
        XCTAssertTrue(audio.waitForExistence(timeout:60))
        for _ in 0..<8 where !audio.isHittable {
            if audio.frame.midY < app.frame.midY { app.swipeDown() } else { app.swipeUp() }
        }
        let before = XCTAttachment(screenshot:app.screenshot()); before.name="actual-soundtrack-control-before-choice"; before.lifetime = .keepAlways; add(before)
        let details = XCTAttachment(string:"Audio frame \(audio.frame), app frame \(app.frame), enabled \(audio.isEnabled)\n\(app.debugDescription)")
        details.name="actual-soundtrack-control-accessibility"; details.lifetime = .keepAlways; add(details)
        XCTAssertTrue(audio.isHittable); audio.tap()
        XCTAssertGreaterThanOrEqual(app.buttons.matching(NSPredicate(format:"label CONTAINS %@","Quoted from @substack")).count,2)
        app.buttons["Mix"].tap()
        let mixed = XCTNSPredicateExpectation(predicate:NSPredicate(format:"value CONTAINS %@ OR label CONTAINS %@","Mix","Mix"),object:audio)
        XCTAssertEqual(XCTWaiter.wait(for:[mixed],timeout:20),.completed)
        let depth = app.buttons["capture.quote-depth"]
        for _ in 0..<8 where !depth.isHittable { app.swipeUp() }
        XCTAssertTrue(depth.isHittable); depth.tap(); app.buttons["Root only"].tap()
        XCTAssertFalse(audio.exists)
        for _ in 0..<8 where !depth.isHittable { app.swipeUp() }
        depth.tap(); app.buttons["Up to 2 levels"].tap()
        XCTAssertTrue(audio.waitForExistence(timeout:20))
        for _ in 0..<8 where !audio.isHittable { app.swipeDown() }
        XCTAssertTrue((audio.value as? String ?? "").contains("Mix") || audio.label.contains("Mix"))
        let image = XCTAttachment(screenshot:app.screenshot()); image.name="actual-quoted-video-soundtrack-mix-restored"; image.lifetime = .keepAlways; add(image)
        app.terminate()
    }
}
