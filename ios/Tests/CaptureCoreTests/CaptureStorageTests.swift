import Foundation
import XCTest
@testable import CaptureCore
@testable import CaptureUI

final class CaptureStorageTests: XCTestCase {
    private func root() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-storage-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
    private func write(_ url: URL, bytes: Int = 32) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 7, count: bytes).write(to: url)
    }
    private func abandoned(_ root: URL, age: TimeInterval, bytes: Int, purpose: String = "render-inputs") throws -> URL {
        let directory = root.appendingPathComponent(NativeMediaWorkspace.directoryName).appendingPathComponent(UUID().uuidString)
        try write(directory.appendingPathComponent(".lease"), bytes: 0)
        let marker: [String: Any] = ["version": 1, "purpose": purpose, "createdAt": Date().addingTimeInterval(-age).timeIntervalSinceReferenceDate]
        try JSONSerialization.data(withJSONObject: marker).write(to: directory.appendingPathComponent(".owner.json"))
        try write(directory.appendingPathComponent(UUID().uuidString + ".mp4"), bytes: bytes)
        return directory
    }

    func testRetryAndFailureReleaseOnlyTheirOwnWorkingCopiesAndPromoteFinishedOutput() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("originals/recording.mp4"); try write(original, bytes: 100)
        for _ in 0..<8 {
            let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs")
            try write(workspace.directory.appendingPathComponent("partial.mp4"), bytes: 1024)
            workspace.discard()
        }
        let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs")
        let input = workspace.directory.appendingPathComponent("download.mp4"), output = workspace.directory.appendingPathComponent("render.mp4")
        try write(input, bytes: 200); try write(output, bytes: 48)
        let promoted = try workspace.promote(.init(fileURL: output, contentType: "video/mp4", byteCount: 48), to: root.appendingPathComponent("renders/pending/attempt"))
        workspace.discard()
        XCTAssertTrue(FileManager.default.fileExists(atPath: promoted.fileURL.path))
        XCTAssertFalse(NativeMediaWorkspace.isTemporaryPath(promoted.fileURL))
        XCTAssertEqual(try Data(contentsOf: promoted.fileURL), Data(repeating: 7, count: 48))
        XCTAssertEqual(try Data(contentsOf: original).count, 100)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(NativeMediaWorkspace.directoryName).path), [])
    }

    func testCancellationRemovesWorkingCopyWithoutRemovingPendingOrSourceMedia() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let pending = root.appendingPathComponent("renders/queued/attempt/video.mp4"); try write(pending, bytes: 256)
        let started = expectation(description: "working download exists")
        let task = Task {
            let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs")
            defer { workspace.discard() }
            try write(workspace.directory.appendingPathComponent("download.mp4"), bytes: 1024)
            started.fulfill()
            try await Task.sleep(for: .seconds(30))
            try Task.checkCancellation()
        }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        do { try await task.value; XCTFail("Expected cancellation") } catch is CancellationError { }
        XCTAssertEqual(try Data(contentsOf: pending).count, 256)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(NativeMediaWorkspace.directoryName).path), [])
    }

    func testPreviewLeaseSurvivesBudgetSweepAndCancellationAfterProductionReleasesIt() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        var preview: NativeMediaPreview?
        do {
            let workspace = try NativeMediaWorkspace(container: root, purpose: "composition-preview")
            let file = workspace.directory.appendingPathComponent("preview.jpg"); try write(file, bytes: 2048)
            preview = .init(fileURL: file, workspace: workspace)
        }
        let file = try XCTUnwrap(preview?.fileURL)
        XCTAssertEqual(NativeMediaWorkspace.prune(container: root, maximumAge: 0, maximumBytes: 0), 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "An open preview is a live dependency")
        preview = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "An undisplayed/canceled result owns its own cleanup")
    }

    func testAbandonedWorkingCopiesAreBoundedWhileLegacyPendingFixturesAndUnknownDataRemain() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let oldest = try abandoned(root, age: 90_000, bytes: 1024)
        let recentLarge = try abandoned(root, age: 1000, bytes: 4096)
        let newest = try abandoned(root, age: 1, bytes: 64)
        let unknown = try abandoned(root, age: 100_000, bytes: 1024, purpose: "unrecognized")
        let fixture = root.appendingPathComponent("fixtures/source.mp4"), pending = root.appendingPathComponent("renders/queued/video.mp4")
        let oldPreview = root.appendingPathComponent("composition-previews/old/preview.jpg")
        for file in [fixture, pending, oldPreview] { try write(file) }
        let active = try NativeMediaWorkspace(container: root, purpose: "render-inputs")
        try write(active.directory.appendingPathComponent("download.mp4"), bytes: 8192)
        XCTAssertGreaterThan(NativeMediaWorkspace.prune(container: root, maximumBytes: 1000), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldest.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: recentLarge.path))
        for file in [newest, unknown, fixture, pending, oldPreview, active.directory] { XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), file.path) }
        active.discard()
    }

    @MainActor func testTemporaryMediaCannotBecomeAQueuedUploadAndAuditIsReadOnly() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let database = root.appendingPathComponent("capture.sqlite"), store = try CaptureStore(url: database)
        let retained = root.appendingPathComponent("renders/pending/video.mp4"); try write(retained, bytes: 1234)
        try store.save(["mediaPath": retained.path], account: 0, kind: "delivery", id: "fixture")
        let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs")
        let file = workspace.directory.appendingPathComponent("partial.mp4"); try write(file)
        let draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.test")
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        XCTAssertThrowsError(try delivery.persistSubmission(draft: draft, prepared: .init(payload: [:], update: [:]), media: file, contentType: "video/mp4"))
        let before = try Data(contentsOf: database), walBefore = try Data(contentsOf: URL(fileURLWithPath: database.path + "-wal"))
        let audit = CaptureStorageAudit.inspect(container: root, database: database)
        XCTAssertTrue(audit.complete)
        XCTAssertEqual(audit.categoryBytes["render-referenced-by-pending-or-canceled-save"], 1234)
        XCTAssertEqual(audit.recordCounts["delivery"], 1)
        XCTAssertFalse(audit.deletionPerformed); XCTAssertFalse(audit.networkOrDeliveryInitialized)
        XCTAssertEqual(try Data(contentsOf: database), before)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: database.path + "-wal")), walBefore)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }

    func testExpiryAndAuditDoNotFollowLinksOrTreatIncompleteInventoryAsComplete() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let recording = root.appendingPathComponent("recordings/original.m4a"); try write(recording, bytes: 256)
        let unsafe = try abandoned(root, age: 100_000, bytes: 32)
        try FileManager.default.createSymbolicLink(at: unsafe.appendingPathComponent("linked-source.m4a"), withDestinationURL: recording)
        NativeMediaWorkspace.prune(container: root, maximumAge: 0, maximumBytes: 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: unsafe.path))
        XCTAssertEqual(try Data(contentsOf: recording).count, 256)
        let audit = CaptureStorageAudit.inspect(container: root)
        XCTAssertFalse(audit.complete)
        XCTAssertFalse(audit.files.contains { $0.path.hasSuffix("linked-source.m4a") })
        let exported = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(audit)) as? [String: Any])
        XCTAssertEqual(exported["complete"] as? Bool, false)
    }
}
