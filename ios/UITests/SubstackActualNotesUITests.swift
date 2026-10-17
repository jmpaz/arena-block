import XCTest

final class SubstackActualNotesUITests: XCTestCase {
    func testSavedHistoryRendersQuoteAndCardMarkdownWithoutChangingSavedText() {
        continueAfterFailure = false
        let markdown = "> [`@joodaloop`](<https://substack.com/@joodaloop/note/c-346876542>)\n>\n> i think i’m going to start posting personal websites that i admire, as an act of reverence for the medium\n\nok, starting with the first one i remember that blew my mind because of the sheer intensity of care for the details\n\nstill online at\n\n*Preview of [Simon Collison | Colly | The Celebrated Miscellany](<http://colly.com/v4>):*\n\n> This is the celebrated journal of Simon Collison (aka Colly); web designer, developer, author and speaker, Nottingham, UK.\n\n*[image]*"
        let app = XCUIApplication()
        app.launchEnvironment = ["CAPTURE_UI_FIXTURE":"saved", "CAPTURE_UI_STORE_ID":UUID().uuidString,
            "CAPTURE_UI_SAVED_MARKDOWN":markdown, "CAPTURE_UI_LIVE_SOURCE":"0", "CAPTURE_UI_CLIPBOARD":"", "CAPTURE_UI_CLIPBOARD_URL":""]
        app.launch()
        app.tabBars.buttons["History"].tap()
        let row = app.buttons.matching(NSPredicate(format:"identifier BEGINSWITH %@ AND label CONTAINS %@", "history.capture.", "A study in shape")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout:10)); row.tap()
        let body = app.descendants(matching:.any)["block.description.content"].firstMatch
        XCTAssertTrue(body.waitForExistence(timeout:10))
        let expand = app.buttons["block.description.expansion"]
        for _ in 0..<6 where !expand.isHittable { app.swipeUp() }
        XCTAssertTrue(expand.isHittable); expand.tap()
        let root = app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@", "ok, starting with the first one")).firstMatch
        XCTAssertTrue(root.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@", "Preview of Simon Collison")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@", "[`")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@", "> ")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@", "*[image]*")).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot:app.screenshot()); screenshot.name="history-saved-note-markdown-rendered"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.terminate()
    }

    func testTypingANoteSharingQueryKeepsTheSourceIdentity() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CAPTURE_UI_FIXTURE":"empty", "CAPTURE_UI_STORE_ID":UUID().uuidString,
            "CAPTURE_UI_LIVE_SOURCE":"0", "CAPTURE_UI_CLIPBOARD":"", "CAPTURE_UI_CLIPBOARD_URL":""]
        app.launch()
        let source = app.textFields["capture.source.1"]
        XCTAssertTrue(source.waitForExistence(timeout:10))
        source.tap()
        let tracked = "https://substack.com/@norvidstudies/note/c-362104813?r=1ir8aw"
        source.typeText(tracked)
        XCTAssertEqual(source.value as? String, tracked)
        app.terminate()
    }

    func testActualPublicImageAndQuotedNotesThroughFreshShare() throws {
        guard ProcessInfo.processInfo.environment["CAPTURE_LIVE_SUBSTACK_IMAGE_NOTE"] == "1" else {
            throw XCTSkip("Opt-in public Substack source/preview check; no save.")
        }
        continueAfterFailure = false
        for (actor, id) in [("norvidstudies", "362104813"), ("joodaloop", "346876542"), ("joodaloop", "347044458"), ("joodaloop", "348712218")] {
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
            if id == "348712218" {
                let value = app.textFields["capture.description"].value as? String ?? ""
                XCTAssertTrue(value.contains("DENSITY!!!")); XCTAssertTrue(value.contains("lucy-ives.com"))
                XCTAssertTrue(value.contains("ok, starting with the first one"))
                XCTAssertTrue(value.contains("as an act of reverence for the medium"))
            }
            let expansion = app.buttons["capture.text.expansion"]
            if expansion.exists && expansion.isHittable { expansion.tap() }
            if id == "348712218" {
                let quoteImage = app.buttons["capture.media.asset.1.2"]
                for _ in 0..<8 where !quoteImage.isHittable { app.swipeUp() }
                XCTAssertTrue(quoteImage.waitForExistence(timeout:20))
                XCTAssertTrue(quoteImage.label.contains("Quoted from @joodaloop"))
                XCTAssertTrue((quoteImage.value as? String ?? "").contains("Included"))
                quoteImage.tap()
                let excluded = XCTNSPredicateExpectation(predicate:NSPredicate(format:"value CONTAINS %@","Excluded"),object:quoteImage)
                XCTAssertEqual(XCTWaiter.wait(for:[excluded],timeout:20),.completed)
                quoteImage.tap()
                let included = XCTNSPredicateExpectation(predicate:NSPredicate(format:"value CONTAINS %@","Included"),object:quoteImage)
                XCTAssertEqual(XCTWaiter.wait(for:[included],timeout:20),.completed)
                let compose = app.buttons["capture.composition-preview.start"]
                for _ in 0..<8 where !compose.isHittable { app.swipeUp() }
                XCTAssertTrue(compose.waitForExistence(timeout:20)); compose.tap()
                let mosaic = app.descendants(matching:.any)["capture.composition-preview.image"].firstMatch
                for _ in 0..<8 where !mosaic.isHittable { app.swipeUp() }
                XCTAssertTrue(mosaic.waitForExistence(timeout:30)); XCTAssertGreaterThan(mosaic.frame.height,100)
            } else if id != "346876542" {
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
