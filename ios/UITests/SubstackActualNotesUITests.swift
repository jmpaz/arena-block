import XCTest

final class SubstackActualNotesUITests: XCTestCase {
    func testActualPublicImageAndQuotedNotesThroughFreshShare() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SUBSTACK_IMAGE_NOTE"] == "1" else {
            throw XCTSkip("Opt-in public Substack source/preview check; no save.")
        }
        continueAfterFailure = false
        for (actor, id) in [("norvidstudies", "362104813"), ("joodaloop", "346876542"), ("joodaloop", "347044458")] {
            let canonical = "https://substack.com/@\(actor)/note/c-\(id)"
            let app = XCUIApplication()
            app.launchEnvironment = ["CAPTURE_UI_FIXTURE":"empty", "CAPTURE_UI_STORE_ID":UUID().uuidString,
                "CAPTURE_UI_COMPOSER":"share", "CAPTURE_UI_PRESENTATION":"share", "CAPTURE_UI_LIVE_SOURCE":"1",
                "CAPTURE_UI_FRESH_SHARE":"1", "CAPTURE_UI_SHARE_DELAY_MS":"500", "CAPTURE_UI_SHARE_INTAKE":"url",
                "CAPTURE_UI_SHARE_URL":canonical + "?r=1ir8aw&utm_medium=ios&utm_source=notes-share-",
                "CAPTURE_UI_CLIPBOARD":"", "CAPTURE_UI_CLIPBOARD_URL":"", "CAPTURE_UI_STYLE":"light"]
            app.launch()
            let source = app.descendants(matching: .any)["capture.source.1"].firstMatch
            XCTAssertTrue(source.waitForExistence(timeout: 15))
            XCTAssertEqual(source.value as? String, canonical)
            let title = app.textFields["capture.title"]
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format:"value == %@", "Note by @\(actor)"), object:title)
            XCTAssertEqual(XCTWaiter.wait(for:[ready], timeout:60), .completed)
            XCTAssertFalse(app.staticTexts["Couldn’t read this link"].exists)
            if id == "347044458" {
                let description = app.textFields["capture.description"]
                let value = description.value as? String ?? ""
                XCTAssertTrue(value.contains("ok, starting with the first one"))
                XCTAssertTrue(value.contains("http://colly.com/v4"))
                XCTAssertTrue(value.contains("@joodaloop"))
                XCTAssertTrue(value.contains("as an act of reverence for the medium"))
                let writing = XCTAttachment(screenshot:app.screenshot())
                writing.name = "substack-actual-quote-attribution"; writing.lifetime = .keepAlways; add(writing)
            }
            let expansion = app.buttons["capture.text.expansion"]
            if expansion.exists && expansion.isHittable { expansion.tap() }
            if id != "346876542" {
                let media = app.descendants(matching:.any)["capture.block-media"].firstMatch
                for _ in 0..<8 where !media.isHittable { app.swipeUp() }
                XCTAssertTrue(media.waitForExistence(timeout:20))
                XCTAssertGreaterThan(media.frame.height, 100)
            }
            let attachment = XCTAttachment(screenshot:app.screenshot())
            attachment.name = "substack-actual-\(id)-preview"; attachment.lifetime = .keepAlways; add(attachment)
            if id == "347044458" {
                app.swipeUp()
                let detail = XCTAttachment(screenshot:app.screenshot())
                detail.name = "substack-actual-quote-and-card"; detail.lifetime = .keepAlways; add(detail)
            }
            app.terminate()
        }
    }
}
