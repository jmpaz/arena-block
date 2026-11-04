import CaptureCore
@testable import CaptureUI
import PDFKit
import UniformTypeIdentifiers
import XCTest

final class PDFReceivingTests: XCTestCase {
    func testProviderTemporaryFileIsCopiedBeforeCallbackReturns() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let document = PDFDocument(); document.insert(PDFPage(), at: 0)
        let data = try XCTUnwrap(document.dataRepresentation())
        let temporary = root.appendingPathComponent("host.pdf")
        try data.write(to: temporary)
        let provider = NSItemProvider()
        provider.registerFileRepresentation(forTypeIdentifier: UTType.pdf.identifier, fileOptions: [], visibility: .all) { completion in
            completion(temporary, false, nil)
            try? FileManager.default.removeItem(at: temporary)
            return nil
        }
        let container = root.appendingPathComponent("capture")
        let input = try await CapturePDFInput.receive(from: provider, in: container, originalURL: "https://example.com/confirmed.pdf")
        XCTAssertEqual(input.originalURL, "https://example.com/confirmed.pdf")
        XCTAssertEqual(try Data(contentsOf: input.validatedFile(in: container)), data)
        XCTAssertNotEqual(input.filePath, temporary.path)
    }

    func testHTMLConfirmationPageCannotBecomePDFInput() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("confirmation.pdf")
        try Data("<html>Please confirm access</html>".utf8).write(to: file)
        let provider = NSItemProvider(contentsOf: file)!
        do { _ = try await CapturePDFInput.receive(from: provider, in: root.appendingPathComponent("capture")); XCTFail("Accepted HTML as PDF") }
        catch { XCTAssertTrue(error.localizedDescription.contains("PDF")) }
    }

    func testCanceledProviderDiscardsItsUnacceptedPrivateCopy() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let document = PDFDocument(); document.insert(PDFPage(), at: 0)
        let file = root.appendingPathComponent("host.pdf")
        try XCTUnwrap(document.dataRepresentation()).write(to: file)
        let provider = NSItemProvider(contentsOf: file)!
        let task = Task { try await CapturePDFInput.receive(from: provider, in: root.appendingPathComponent("capture")) }
        task.cancel()
        do { _ = try await task.value; XCTFail("Canceled intake succeeded") }
        catch is CancellationError { }
        let directory = root.appendingPathComponent("capture/originals/pdfs")
        XCTAssertTrue((try? FileManager.default.contentsOfDirectory(atPath: directory.path))?.isEmpty ?? true)
    }
}

extension PDFReceivingTests {
    @MainActor func testImportedPDFNeedsSourceAndPreservesEditedTitleAfterReopen() async throws {
        let id = UUID().uuidString
        setenv("CAPTURE_UI_FIXTURE", "empty", 1); setenv("CAPTURE_UI_STORE_ID", id, 1)
        defer { unsetenv("CAPTURE_UI_FIXTURE"); unsetenv("CAPTURE_UI_STORE_ID") }
        let session = try CaptureSession()
        let root = session.pdfImportContainer
        defer { session.finishSharing(); session.releaseStoreForSuspension(); try? FileManager.default.removeItem(at: root) }
        let document = PDFDocument(); document.insert(PDFPage(), at: 0)
        document.documentAttributes = [PDFDocumentAttribute.titleAttribute: "A local paper"]
        let file = root.appendingPathComponent("download.pdf")
        try XCTUnwrap(document.dataRepresentation()).write(to: file)
        let draftID = try XCTUnwrap(session.draft?.id)
        try session.importPDFFile(file, for: draftID)
        try await waitForPreview(session)
        XCTAssertNotNil(session.preview?.pdfPath)
        XCTAssertNil(session.preview?.plan); XCTAssertFalse(session.canSubmitCapture)
        session.setTitle("My edited title")
        session.setInput("https://example.com/citation")
        try await waitForPreview(session, needsPlan: true)
        XCTAssertTrue(session.canSubmitCapture); XCTAssertEqual(session.editorTitle, "My edited title")
        XCTAssertEqual(session.preview?.plan?["block"]?["canonicalSource"], .string("https://example.com/citation"))
        XCTAssertNotNil(session.preview?.plan?["block"]?["pdfFile"])
        let retained = try XCTUnwrap(session.draft?.pdfInput)
        try FileManager.default.removeItem(at: file)
        let reopened = try CaptureSession()
        defer { reopened.finishSharing(); reopened.releaseStoreForSuspension() }
        XCTAssertEqual(reopened.draft?.pdfInput, retained)
        XCTAssertEqual(reopened.editorTitle, "My edited title")
        XCTAssertEqual(try Data(contentsOf: retained.validatedFile(in: root)).count, retained.byteCount)
        try XCTUnwrap(document.dataRepresentation()).write(to: file)
        try reopened.importPDFFile(file, for: draftID)
        try await waitForPreview(reopened, needsPlan: true)
        XCTAssertNil(reopened.draft?.pdfInput?.originalURL, "Replacing a local file must not turn its citation URL into a PDF origin")
        XCTAssertEqual(reopened.editorTitle, "My edited title")
        XCTAssertThrowsError(try reopened.importPDFFile(URL(fileURLWithPath: retained.filePath), for: UUID()))
    }

    @MainActor func testSharedPDFStartsDistinctDraftAndClosedInvocationRejectsIntake() async throws {
        setenv("CAPTURE_UI_FIXTURE", "empty", 1); setenv("CAPTURE_UI_STORE_ID", UUID().uuidString, 1)
        defer { unsetenv("CAPTURE_UI_FIXTURE"); unsetenv("CAPTURE_UI_STORE_ID") }
        let session = try CaptureSession(freshShare: true)
        let root = session.pdfImportContainer
        defer { session.finishSharing(); session.releaseStoreForSuspension(); try? FileManager.default.removeItem(at: root) }
        let document = PDFDocument(); document.insert(PDFPage(), at: 0)
        let file = root.appendingPathComponent("host.pdf")
        try XCTUnwrap(document.dataRepresentation()).write(to: file)
        let input = try CapturePDFInput.retain(file, in: root, originalURL: "https://example.com/download")
        try session.receivePDF(input)
        try await waitForPreview(session, needsPlan: true)
        XCTAssertEqual(session.draft?.pdfInput, input)
        XCTAssertEqual(session.draft?.input, "https://example.com/download")
        XCTAssertTrue(session.incomingLinks.isEmpty)
        session.setTitle("My source title")
        session.setSourceURL("https://example.com/doi")
        try await waitForPreview(session, needsPlan: true, source: "https://example.com/doi")
        XCTAssertEqual(session.draft?.pdfInput?.originalURL, "https://example.com/download")
        XCTAssertEqual(session.editorTitle, "My source title")
        XCTAssertEqual(session.preview?.plan?["block"]?["canonicalSource"], .string("https://example.com/doi"))
        session.finishSharing()
        XCTAssertThrowsError(try session.receivePDF(input))
    }

    @MainActor private func waitForPreview(_ session: CaptureSession, needsPlan: Bool = false, source: String? = nil) async throws {
        for _ in 0..<100 {
            if session.preview?.pdfPath != nil && (!needsPlan || session.preview?.plan != nil),
               source == nil || session.preview?.plan?["block"]?["canonicalSource"] == source.map(JSONValue.string) { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("PDF preview did not resolve: \(session.draft?.problem ?? "no problem")")
    }
}
