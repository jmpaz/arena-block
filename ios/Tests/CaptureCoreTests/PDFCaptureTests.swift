import CaptureRuntime
import Foundation
import PDFKit
import XCTest
@testable import CaptureCore

final class PDFCaptureTests: XCTestCase {
    func testSourceOverrideIsFrozenWithThePDFURLAndWritingEdits() throws {
        let pdf = "https://example.com/content"
        let source = "https://dl.acm.org/doi/10.1145/320435.320594"
        var draft = CaptureDraft(accountID: 1, defaultChannel: nil, input: pdf)
        draft.sourceURLOverride = source; draft.titleOverride = "My title"
        let frozen = try CaptureSubmissionSnapshot(draft: draft)
        draft.sourceURLOverride = "https://example.com/new"
        XCTAssertEqual(frozen.url, pdf); XCTAssertEqual(frozen.sourceURLOverride, source)
        XCTAssertEqual(frozen.title, "My title")
        let decoded = try JSONDecoder().decode(CaptureSubmissionSnapshot.self, from: JSONEncoder().encode(frozen))
        XCTAssertEqual(decoded.sourceURLOverride, source)
        for value in ["javascript:alert(1)", "file:///tmp/document", "https://user:password@example.com"] {
            draft.sourceURLOverride = value
            XCTAssertThrowsError(try CaptureSubmissionSnapshot(draft: draft))
        }
    }

    func testPDFDetailsRejectHTMLAndReadDocumentMetadata() throws {
        XCTAssertThrowsError(try CaptureWebLink.pdfDetails(Data("<html>Access required</html>".utf8)))
        let document = PDFDocument(); document.insert(PDFPage(), at: 0)
        document.documentAttributes = [PDFDocumentAttribute.titleAttribute: "A paper"]
        let data = try XCTUnwrap(document.dataRepresentation())
        let details = try CaptureWebLink.pdfDetails(data)
        XCTAssertEqual(details.title, "A paper"); XCTAssertEqual(details.pageCount, 1)
    }

    @MainActor func testNativeCoreSendsPDFContentAndChosenSourceAndVerifiesBoth() throws {
        let runtime = try CaptureRuntime()
        let result = try decode(runtime.webPlan(#"{"url":"https://example.com/content","sourceUrl":"https://example.com/article","contentType":"application/pdf","title":"Edited title"}"#))
        let plan = try XCTUnwrap(result["plan"])
        let planJSON = String(decoding: try JSONEncoder().encode(plan), as: UTF8.self)
        let payload = try decode(runtime.localPayload(planJSON: planJSON))
        XCTAssertEqual(payload["value"], .string("https://example.com/content"))
        XCTAssertEqual(payload["original_source_url"], .string("https://example.com/article"))
        let block = #"{"state":"available","type":"Attachment","title":"Edited title","source":{"url":"https://example.com/article"},"attachment":{"content_type":"application/pdf","url":"https://attachments.are.na/paper.pdf"}}"#
        XCTAssertNoThrow(try runtime.verify(planJSON: planJSON, blockJSON: block))
        XCTAssertThrowsError(try runtime.verify(planJSON: planJSON, blockJSON: block.replacingOccurrences(of: "application/pdf", with: "text/html")))
    }

    private func decode(_ text: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }
}
