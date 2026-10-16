import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CaptureCore
@testable import CaptureUI

final class CaptureStorageTests: XCTestCase {
    func testForcedAuditBuildCannotEnterCaptureEvenWithoutALaunchFlag() {
        XCTAssertTrue(CaptureLaunchPolicy.storageAuditOnly(environment: [:], forcedAuditBuild: true))
        XCTAssertTrue(CaptureLaunchPolicy.storageAuditOnly(environment: ["CAPTURE_STORAGE_AUDIT_ONLY": "0"], forcedAuditBuild: true))
        XCTAssertTrue(CaptureLaunchPolicy.storageAuditOnly(environment: ["CAPTURE_STORAGE_AUDIT_ONLY": "1"]))
        XCTAssertFalse(CaptureLaunchPolicy.storageAuditOnly(environment: [:]))
        XCTAssertFalse(CaptureLaunchPolicy.storageAuditOnly(environment: ["CAPTURE_STORAGE_AUDIT_ONLY": "true"]))
    }

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
        try store.save(["mediaPath": retained.path, "phase": "uncertain", "stage": "reconcile", "transferID": "fixture-transfer"], account: 0, kind: "delivery", id: "fixture")
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
        XCTAssertEqual(audit.recordStateCounts["delivery.phase.uncertain"], 1)
        XCTAssertEqual(audit.recordStateCounts["delivery.stage.reconcile"], 1)
        XCTAssertEqual(audit.recordStateCounts["delivery.retained-transfer-reference"], 1)
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

    func testInsufficientDeviceSpaceBlocksPromotionWithoutEvictingProtectedMedia() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        var free: Int64 = 100 * 1024 * 1024
        let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs", availableCapacity: { _ in free })
        let protected = root.appendingPathComponent("renders/unfinished/only-copy.mp4")
        try write(protected, bytes: 220)
        let output = workspace.directory.appendingPathComponent("new.mp4"); try write(output, bytes: 40)
        free = 0
        XCTAssertThrowsError(try workspace.promote(.init(fileURL: output, contentType: "video/mp4", byteCount: 40), to: root.appendingPathComponent("renders/new/attempt")))
        XCTAssertEqual(try Data(contentsOf: protected).count, 220)
        XCTAssertEqual(try Data(contentsOf: output).count, 40)
        workspace.discard()
        XCTAssertTrue(FileManager.default.fileExists(atPath: protected.path))
    }

    func testPhysicalCapacityCheckAndWriteUseCurrentFreeSpaceWithoutEviction() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let first = root.appendingPathComponent("renders/first.mp4")
        try CaptureStorageCapacity.withSpace(container: root, additionalBytes: 100, minimumFreeBytes: 0, availableCapacity: { _ in 128 }) { try write(first, bytes: 100) }
        var secondWriteRan = false
        XCTAssertThrowsError(try CaptureStorageCapacity.withSpace(container: root, additionalBytes: 40, minimumFreeBytes: 0, availableCapacity: { _ in 28 }) { secondWriteRan = true })
        XCTAssertFalse(secondWriteRan)
        XCTAssertEqual(try Data(contentsOf: first).count, 100)
    }

    @MainActor func testUnfinishedSaveReusesItsOnlyCopyWithNoSpaceForNewPreparation() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("renders/unfinished/only-copy.mp4"); try write(file, bytes: 1)
        let handle = try FileHandle(forWritingTo: file); try handle.truncate(atOffset: 350_000_001); try handle.close()
        let store = try CaptureStore(url: root.appendingPathComponent("capture.sqlite"))
        var draft = CaptureDraft(accountID: 42, defaultChannel: nil, input: "https://example.test")
        draft.previewSnapshot = .init(kind: "social", url: draft.input, plan: .object(["block": .object(["selectedMedia": .array([.string("1.1")])])]))
        let job = DeliveryJob(id: draft.id, draft: draft, prepared: .init(payload: [:], update: [:]), mediaPath: file.path, stage: .rendering)
        try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
        XCTAssertThrowsError(try NativeMediaWorkspace(container: root, purpose: "render-inputs", availableCapacity: { _ in 0 }))
        let delivery = try CaptureDelivery(store: store, credentials: CredentialStore(accessGroup: nil), directory: root.appendingPathComponent("delivery"), group: "fixture", identifier: "fixture", ingestBase: nil)
        try await delivery.preparePending(job.id)
        let retained = try XCTUnwrap(store.value(DeliveryJob.self, account: 0, kind: "delivery", id: job.id.uuidString))
        XCTAssertEqual(retained.mediaPath, file.path); XCTAssertEqual(retained.stage, .destinations)
        XCTAssertEqual(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, 350_000_001)
    }

    func testNormalMaximumVideoPromotesItsAlreadyAllocatedFileAlongsideLegacyData() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        func sparse(_ url: URL, bytes: UInt64) throws {
            try write(url, bytes: 1); let handle = try FileHandle(forWritingTo: url)
            try handle.truncate(atOffset: bytes); try handle.close()
        }
        try sparse(root.appendingPathComponent("legacy-protected/retained.mp4"), bytes: 2_543_648_971)
        let other = try NativeMediaWorkspace(container: root, purpose: "render-inputs")
        defer { other.discard() }
        try sparse(other.directory.appendingPathComponent("active-source.mp4"), bytes: 400_000_000)
        var free: Int64 = 1024 * 1024 * 1024
        let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs", availableCapacity: { _ in free })
        defer { workspace.discard() }
        let output = workspace.directory.appendingPathComponent("finished.mp4"), bytes = 250 * 1024 * 1024
        try sparse(output, bytes: UInt64(bytes))
        free = 2 * 1024 * 1024
        let retained = try workspace.promote(.init(fileURL: output, contentType: "video/mp4", byteCount: bytes), to: root.appendingPathComponent("renders/new/attempt"))
        XCTAssertEqual(try retained.fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, bytes)
        XCTAssertTrue(FileManager.default.fileExists(atPath: other.directory.appendingPathComponent("active-source.mp4").path))
    }

    func testLegacyTwoPointFiveGBDoesNotBlockSmallNewCaptureWithActualSpace() throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let legacy = root.appendingPathComponent("renders/legacy/only-copy.mp4")
        try write(legacy, bytes: 1)
        let handle = try FileHandle(forWritingTo: legacy); try handle.truncate(atOffset: 2_543_648_971); try handle.close()
        let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs", availableCapacity: { _ in 100 * 1024 * 1024 })
        defer { workspace.discard() }
        let output = workspace.directory.appendingPathComponent("new.jpg"); try write(output, bytes: 1024)
        let promoted = try workspace.promote(.init(fileURL: output, contentType: "image/jpeg", byteCount: 1024), to: root.appendingPathComponent("renders/new/attempt"))
        XCTAssertEqual(try Data(contentsOf: promoted.fileURL).count, 1024)
        XCTAssertEqual(try legacy.resourceValues(forKeys: [.fileSizeKey]).fileSize, 2_543_648_971)
        XCTAssertGreaterThan(try CaptureStorageCapacity.availableBytes(at: root), 0)
    }

    func testSmallImageActuallyRendersAndPromotesWithTwoPointFiveGBLegacyData() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let legacy = root.appendingPathComponent("renders/legacy/only-copy.mp4"); try write(legacy, bytes: 1)
        let handle = try FileHandle(forWritingTo: legacy); try handle.truncate(atOffset: 2_543_648_971); try handle.close()
        let workspace = try NativeMediaWorkspace(container: root, purpose: "render-inputs", availableCapacity: { _ in 100 * 1024 * 1024 })
        defer { workspace.discard() }
        let source = workspace.directory.appendingPathComponent("source.jpg")
        let context = try XCTUnwrap(CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.3, green: 0.6, blue: 0.8, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(source as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil); XCTAssertTrue(CGImageDestinationFinalize(destination))
        let recipe = NativeMediaRecipe(kind: "image", width: 64, height: 64,
            tiles: [.init(ref: "1.1", rect: .init(x: 0, y: 0, width: 64, height: 64))], maximumBytes: 20 * 1024 * 1024)
        let rendered = try await NativeMediaRenderer.render(recipe: recipe,
            media: [.init(ref: "1.1", kind: "image", fileURL: source, width: 64, height: 64)], directory: workspace.directory)
        let promoted = try workspace.promote(rendered, to: root.appendingPathComponent("renders/new/attempt"))
        XCTAssertEqual(promoted.contentType, "image/jpeg"); XCTAssertGreaterThan(promoted.byteCount, 0)
        XCTAssertNotNil(CGImageSourceCreateWithURL(promoted.fileURL as CFURL, nil))
        XCTAssertEqual(try legacy.resourceValues(forKeys: [.fileSizeKey]).fileSize, 2_543_648_971)
    }
}
