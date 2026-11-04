import Foundation
import PDFKit
import XCTest
@testable import CaptureCore
@testable import CaptureRuntime
@testable import CaptureUI

final class PDFFileIntakeTests: XCTestCase {
    private func fixture(_ root: URL) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let document = PDFDocument(); document.insert(PDFPage(), at: 0)
        document.documentAttributes = [PDFDocumentAttribute.titleAttribute: "Retained paper"]
        let file = root.appendingPathComponent("paper.pdf")
        try XCTUnwrap(document.dataRepresentation()).write(to: file)
        return file
    }

    func testCopiesTemporaryPDFAndRejectsChangedMissingOrInvalidBytes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = try fixture(root), container = root.appendingPathComponent("capture")
        let input = try CapturePDFInput.retain(file, in: container)
        let expected = try Data(contentsOf: file)
        try FileManager.default.removeItem(at: file)
        XCTAssertEqual(try Data(contentsOf: input.validatedFile(in: container)), expected)
        XCTAssertEqual(input.title, "Retained paper"); XCTAssertEqual(input.pageCount, 1)
        try Data("<html>Confirmation required</html>".utf8).write(to: file)
        XCTAssertThrowsError(try CapturePDFInput.retain(file, in: container))
        let link = root.appendingPathComponent("link.pdf")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: URL(fileURLWithPath: input.filePath))
        XCTAssertThrowsError(try CapturePDFInput.retain(link, in: container))
        try Data(repeating: 0, count: input.byteCount).write(to: URL(fileURLWithPath: input.filePath))
        XCTAssertThrowsError(try input.validatedFile(in: container))
        try FileManager.default.removeItem(atPath: input.filePath)
        XCTAssertThrowsError(try input.validatedFile(in: container))
    }

    @MainActor func testRetainedDocumentSurvivesDraftReopenAndSnapshotFreezesSource() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let container = root.appendingPathComponent("capture"), file = try fixture(root)
        let input = try CapturePDFInput.retain(file, in: container)
        let store = try CaptureStore(url: container.appendingPathComponent("capture.sqlite"))
        var draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "")
        draft = try store.replacePDFInput(in: draft, input: input, workspaceID: "app")
        XCTAssertTrue(draft.hasDraftContent); XCTAssertTrue(draft.hasUserEdits)
        let reopened = try CaptureStore(url: container.appendingPathComponent("capture.sqlite"))
        XCTAssertEqual(try reopened.value(CaptureDraft.self, account: 42, kind: "draft", id: draft.id.uuidString)?.pdfInput, input)
        XCTAssertThrowsError(try CaptureSubmissionSnapshot(draft: draft))
        draft.input = "https://example.com/download"; draft.sourceURLOverride = "https://example.com/citation"; draft.titleOverride = "My title"
        let snapshot = try CaptureSubmissionSnapshot(draft: draft)
        draft.sourceURLOverride = "https://example.com/changed"; draft.pdfInput = nil
        XCTAssertEqual(snapshot.pdfInput, input); XCTAssertEqual(snapshot.sourceURLOverride, "https://example.com/citation")
        XCTAssertEqual(snapshot.title, "My title")
        var queued = draft; queued.phase = .queued
        XCTAssertThrowsError(try store.replacePDFInput(in: queued, input: input, workspaceID: "app"))
    }

    @MainActor func testPendingPDFIsConsumedAtomicallyAndLateShareCannotReplaceIt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = try CapturePDFInput.retain(fixture(root), in: root)
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let first = UUID(), next = UUID()
        let opened = try store.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: first)
        let pending = PendingShare(id: UUID(), urls: [input.incomingReference], pdfInput: input)
        try store.save(pending, account: 0, kind: "incoming", id: pending.id.uuidString)
        var draft = opened.draft; draft.pdfInput = input
        let result = try store.commitNewCapture(draft, workspace: CaptureWorkspace(activeDraftID: draft.id, shareInvocationID: first), workspaceID: "share", consumingIncoming: true, incomingIDs: [pending.id], shareInvocationID: first, incomingReference: input.incomingReference)
        XCTAssertEqual(result.draft.pdfInput, input)
        XCTAssertTrue(try store.values(PendingShare.self, account: 0, kind: "incoming").isEmpty)
        _ = try store.startShareWorkspace(account: 42, id: "share", defaultChannel: nil, invocationID: next)
        XCTAssertThrowsError(try store.replacePDFInput(in: result.draft, input: nil, workspaceID: "share", shareInvocationID: first))
        XCTAssertEqual(try store.value(CaptureDraft.self, account: 42, kind: "draft", id: result.draft.id.uuidString)?.pdfInput, input)
    }

    @MainActor func testPreparationAndDeliveryUploadPDFBeforeCreationAndVerifyAttachment() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = try CapturePDFInput.retain(fixture(root), in: root, originalURL: "https://example.com/blocked-download")
        let channel = Channel(id: 101, title: "References", slug: "references", visibility: "private",
                              owner: Owner(id: 42, name: "Fixture", slug: "fixture", type: "User"), can: .init(addTo: true))
        var draft = CaptureDraft(accountID: 42, defaultChannel: channel, input: input.originalURL!)
        draft.pdfInput = input; draft.sourceURLOverride = "https://example.com/citation"; draft.titleOverride = "My edited paper"
        let snapshot = try CaptureSubmissionSnapshot(draft: draft)
        let preparation = CapturePreparation(runtime: try CaptureRuntime(), container: root)
        let result = try await preparation.read(snapshot)
        XCTAssertEqual(result.retainedPDF, input)
        draft.previewSnapshot = result.preview
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: UUID().uuidString, ingestBase: nil)
        _ = try delivery.persistQueuedSubmission(draft: draft)
        try await delivery.preparePending(draft.id)
        var job = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: draft.id.uuidString))
        XCTAssertEqual(job.stage, .destinations)
        XCTAssertEqual(job.mediaPath, input.filePath); XCTAssertEqual(job.mediaType, "application/pdf")
        delivery.consume(try response(#"{"can":{"add_to":true}}"#), job: &job)
        XCTAssertEqual(job.stage, .presign)
        XCTAssertEqual(try delivery.request(job, token: "fixture").request.url?.path, "/v3/uploads/presign")
        delivery.consume(try response(#"{"files":[{"upload_url":"https://uploads.example.test/signed","key":"fixture/paper.pdf","content_type":"application/pdf"}],"expires_in":3600}"#), job: &job)
        XCTAssertEqual(job.stage, .upload)
        let upload = try delivery.request(job, token: "fixture")
        XCTAssertEqual(upload.request.httpMethod, "PUT"); XCTAssertNil(upload.request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(upload.file)), try Data(contentsOf: URL(fileURLWithPath: input.filePath)))
        var unconfirmed = job; unconfirmed.stage = .create
        XCTAssertThrowsError(try delivery.request(unconfirmed, token: "fixture"))
        delivery.consume(.init(status: 200, body: Data(), error: nil, retryAfter: nil), job: &job)
        XCTAssertEqual(job.stage, .create)
        let create = try delivery.request(job, token: "fixture")
        let payload = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(create.body))
        XCTAssertEqual(payload["original_source_url"], .string("https://example.com/citation"))
        XCTAssertEqual(payload["value"], job.uploadedSource.map(JSONValue.string))
        XCTAssertNotEqual(payload["value"], payload["original_source_url"])
        delivery.consume(try response(#"{"id":900}"#, status: 201), job: &job)
        let block = "{\"id\":900,\"state\":\"available\",\"type\":\"Attachment\",\"title\":\"My edited paper\",\"description\":null,\"source\":{\"url\":\"https://example.com/citation\"},\"attachment\":{\"content_type\":\"application/pdf\",\"file_size\":\(input.byteCount),\"url\":\"https://attachments.are.na/paper.pdf\"}}"
        delivery.consume(try response(block), job: &job)
        if job.stage == .update { delivery.consume(try response("{}"), job: &job) }
        XCTAssertEqual(job.stage, .verify)
        delivery.consume(try response(block), job: &job)
        XCTAssertEqual(job.stage, .connections); XCTAssertEqual(job.contentVerified, true)
        delivery.consume(try response(#"{"data":[{"id":101}],"meta":{"has_more_pages":false}}"#), job: &job)
        XCTAssertEqual(job.stage, .done)
        try FileManager.default.removeItem(atPath: input.filePath)
        job.stage = .create
        XCTAssertThrowsError(try delivery.request(job, token: "fixture"))
    }

    private func response(_ json: String, status: Int = 200) throws -> BackgroundHTTPResult {
        .init(status: status, body: Data(json.utf8), error: nil, retryAfter: nil)
    }
}
