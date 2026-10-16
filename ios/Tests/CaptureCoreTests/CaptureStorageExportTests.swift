import CryptoKit
import Foundation
import SQLite3
import XCTest
@testable import CaptureCore

final class CaptureStorageExportTests: XCTestCase {
    private func fixture() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("storage-export-" + UUID().uuidString)
        let main = root.appendingPathComponent("main"), shared = root.appendingPathComponent("shared")
        try FileManager.default.createDirectory(at: main, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: shared, withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(shared.appendingPathComponent("capture.sqlite").path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE records(account INTEGER,kind TEXT,id TEXT,value BLOB,updated REAL)", nil, nil, nil), SQLITE_OK)
        return (root, main, shared)
    }
    private func insert(_ shared: URL, kind: String = "delivery", id: String = UUID().uuidString, value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        var db: OpaquePointer?, statement: OpaquePointer?
        XCTAssertEqual(sqlite3_open(shared.appendingPathComponent("capture.sqlite").path, &db), SQLITE_OK)
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        XCTAssertEqual(sqlite3_prepare_v2(db, "INSERT INTO records VALUES(0,?,?,?,1)", -1, &statement, nil), SQLITE_OK)
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(statement, 1, kind, -1, transient)
        sqlite3_bind_text(statement, 2, id, -1, transient)
        _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, 3, $0.baseAddress, Int32($0.count), transient) }
        XCTAssertEqual(sqlite3_step(statement), SQLITE_DONE)
    }
    private func write(_ shared: URL, _ path: String, bytes: Int = 32) throws -> URL {
        let url = shared.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 7, count: bytes).write(to: url)
        return url
    }
    private func digest(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }

    func testOnlyExactDiagnosticURLSelectsReportAndNeverOAuthOrArbitraryPaths() {
        XCTAssertTrue(CaptureLaunchPolicy.storageReportURL(URL(string: "arena-capture://storage-report")!, scheme: "arena-capture"))
        for value in ["arena-capture://storage-report/", "arena-capture://storage-report?path=/renders", "arena-capture://storage-report#x", "other://storage-report", "arena-capture://oauth?code=abc", "arena-capture://user@storage-report", "arena-capture://storage-report:42"] {
            XCTAssertFalse(CaptureLaunchPolicy.storageReportURL(URL(string: value)!, scheme: "arena-capture"), value)
        }
    }
    func testColdDiagnosticBlocksForegroundAndBackgroundSessionAdmissionUntilExplicitOpen() {
        var gate = CaptureStorageLaunchGate()
        XCTAssertFalse(gate.admitNormalWork())
        gate.connectScene(reportRequested: true)
        XCTAssertFalse(gate.admitNormalWork())
        XCTAssertFalse(gate.admitNormalWork(background: true))
        gate.connectScene(reportRequested: false)
        gate.connectScene(reportRequested: true)
        XCTAssertEqual(gate.destination, .report)
        XCTAssertFalse(gate.normalWorkAdmitted)
        gate.requestCapture()
        XCTAssertTrue(gate.admitNormalWork())
        XCTAssertTrue(gate.normalWorkAdmitted)
    }
    func testOrdinaryForegroundAndBackgroundOwnershipIsRetainedForLaterWarmDiagnostics() {
        for background in [false, true] {
            var gate = CaptureStorageLaunchGate()
            if !background { gate.connectScene(reportRequested: false) }
            XCTAssertTrue(gate.admitNormalWork(background: background))
            gate.requestReport()
            XCTAssertTrue(gate.normalWorkAdmitted)
            XCTAssertTrue(gate.admitNormalWork(background: true), "An existing normal owner keeps its lifecycle handling")
        }
    }
    func testQueuedCanceledAndUncertainRecordsAndMediaAreNeverAdvancedOrChanged() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let capture = UUID().uuidString, relative = "renders/\(capture)/attempt/video.mp4"
        let file = try write(shared, relative, bytes: 211)
        for (kind, stage) in [("delivery", "queued"), ("canceledDelivery", "upload"), ("deliveryReceipt", "reconcile")] {
            try insert(shared, kind: kind, value: ["mediaPath": file.path, "stage": stage, "transferID": UUID().uuidString, "draft": ["id": capture, "renderPath": file.path, "phase": "uncertain"]])
        }
        let database = shared.appendingPathComponent("capture.sqlite"), before = try Data(contentsOf: database), media = try Data(contentsOf: file)
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false)
        XCTAssertTrue(report.stable, report.problems.joined(separator: ",")); XCTAssertTrue(report.recordScanComplete, report.problems.joined(separator: ",")); XCTAssertTrue(report.fileScanComplete, report.problems.joined(separator: ","))
        XCTAssertEqual(Set(report.records.compactMap(\.stage)), ["queued", "upload", "reconcile"])
        XCTAssertEqual(report.files.first { $0.pathSHA256 == digest(relative) }?.associatedRecordIDs.count, 3)
        XCTAssertEqual(try Data(contentsOf: database), before)
        XCTAssertEqual(try Data(contentsOf: file), media)
        XCTAssertEqual(report.captureSessionsStartedByExport, 0); XCTAssertEqual(report.mediaBytesRead, 0)
        XCTAssertFalse(report.deletionPerformed); XCTAssertFalse(report.dependencyClosureComplete)
        XCTAssertEqual(report.osTaskCoverage, "not-queried-preserve")
    }
    func testAuthoredAndCredentialSubtreesArbitraryKeysPathsAndIDsAreNotExported() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let secret = "AUTHORED-SECRET-987654", falseID = UUID().uuidString
        try insert(shared, kind: "draft", id: secret, value: [
            "title": secret, "body": ["renderPath": shared.path + "/renders/secret"],
            "credentials": ["id": falseID, "mediaPath": "/tmp/secret"], "headers": ["Authorization": secret],
            secret: ["renderPath": shared.path + "/renders/arbitrary-key"],
            "substackCapturesJSON": "{\"renderPath\":\"/tmp/private\"}",
            "provenanceSnapshotJSON": "{\"id\":\"\(falseID)\"}", "phase": "editing"])
        try insert(shared, kind: secret, id: secret, value: ["renderPath": shared.path + "/renders/unknown"])
        _ = try write(shared, "recordings/\(secret).m4a")
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false)
        let text = String(decoding: try CaptureStorageExport.encoded(report), as: UTF8.self)
        XCTAssertFalse(text.contains(secret)); XCTAssertFalse(text.contains(falseID)); XCTAssertFalse(text.contains(shared.path))
        XCTAssertTrue(report.records.allSatisfy { $0.references.isEmpty && $0.captureIDs.isEmpty })
        XCTAssertTrue(report.problems.contains("unprojected-record-kinds-preserve"))
    }
    func testNamedEmbeddedAndOldAppGroupReferencesPreserveMatchingFiles() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let capture = UUID().uuidString, relative = "renders/\(capture)/attempt/video.mp4"
        _ = try write(shared, relative)
        let alias = "/private/var/mobile/Containers/Shared/AppGroup/\(UUID().uuidString)/\(relative)"
        let nested = String(decoding: try JSONSerialization.data(withJSONObject: ["renderPath": alias]), as: UTF8.self)
        try insert(shared, kind: "draft", value: ["snapshotJSON": nested])
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false)
        let ref = try XCTUnwrap(report.records.first?.references.first)
        XCTAssertTrue(ref.alias); XCTAssertTrue(ref.embedded); XCTAssertEqual(ref.pathSHA256, digest(relative))
        XCTAssertEqual(report.files.first { $0.pathSHA256 == ref.pathSHA256 }?.associatedRecordIDs, [report.records[0].idSHA256])
    }
    func testDirectoryAndWorkspaceIdentityAssociationsPreserveDescendants() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let capture = UUID().uuidString, relative = "renders/\(capture)/attempt/photo.jpg"
        _ = try write(shared, relative)
        try insert(shared, kind: "mediaPromotion", value: ["relativeDirectory": "renders/\(capture)"])
        try insert(shared, kind: "workspace", value: ["activeDraftID": capture])
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false)
        XCTAssertEqual(report.files.first { $0.pathSHA256 == digest(relative) }?.associatedRecordIDs.count, 2)
    }
    func testSymlinksExternalReferencesAndUnobservedFilesStayUnknownAndPreserved() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let original = try write(main, "private.m4a", bytes: 53)
        try FileManager.default.createSymbolicLink(at: shared.appendingPathComponent("linked"), withDestinationURL: original)
        try insert(shared, value: ["mediaPath": original.path])
        let retained = try write(shared, "renders/unobserved.mp4", bytes: 67)
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: true)
        XCTAssertTrue(report.normalCaptureAlreadyActive)
        XCTAssertTrue(report.problems.contains("symlink-preserve"))
        XCTAssertTrue(report.problems.contains("unresolved-local-reference-preserve"))
        XCTAssertEqual(try Data(contentsOf: retained).count, 67)
        XCTAssertEqual(try Data(contentsOf: original).count, 53)
        XCTAssertFalse(report.files.contains { $0.pathSHA256 == digest("linked") })
    }
    func testLargeSparseMediaUsesMetadataOnly() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let media = try write(shared, "renders/large.mp4", bytes: 1)
        let handle = try FileHandle(forWritingTo: media); try handle.truncate(atOffset: 2_543_648_971); try handle.close()
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false)
        XCTAssertEqual(report.files.first { $0.pathSHA256 == digest("renders/large.mp4") }?.logicalBytes, 2_543_648_971)
        XCTAssertEqual(report.mediaBytesRead, 0)
    }
    func testRecordBlobNodeFileAndOutputLimitsCannotProduceAnUnqualifiedReport() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        try insert(shared, value: ["draft": ["id": UUID().uuidString], "text": String(repeating: "x", count: 1000)])
        try insert(shared, value: ["stage": "queued"])
        var limits = CaptureStorageExport.Limits(); limits.records = 1
        var report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false, limits: limits)
        XCTAssertFalse(report.recordScanComplete); XCTAssertFalse(report.stable)
        XCTAssertTrue(report.problems.contains("record-count-limit"))
        limits = .init(); limits.recordBytes = 32
        report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false, limits: limits)
        XCTAssertFalse(report.recordScanComplete)
        limits = .init(); limits.nodes = 1
        report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false, limits: limits)
        XCTAssertFalse(report.recordScanComplete)
        for index in 0..<30 { _ = try write(shared, "renders/\(index).jpg") }
        limits = .init(); limits.files = 1
        report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false, limits: limits)
        XCTAssertFalse(report.fileScanComplete)
        limits = .init(); limits.outputBytes = 4096
        report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false, limits: limits)
        XCTAssertTrue(report.problems.contains("projection-limit-preserve"))
        XCTAssertLessThanOrEqual(try CaptureStorageExport.encoded(report).count, limits.outputBytes)
    }
    func testCancelledCollectionHasNoReportAndDoesNotChangeRecords() async throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        try insert(shared, value: ["stage": "queued"])
        let database = shared.appendingPathComponent("capture.sqlite"), before = try Data(contentsOf: database)
        let task = Task {
            try? await Task.sleep(for: .seconds(30))
            return try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false)
        }
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") } catch is CancellationError { }
        XCTAssertEqual(try Data(contentsOf: database), before)
    }
    func testMalformedKnownEmbeddedJSONIsExplicitlyUnknown() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        try insert(shared, kind: "draft", value: ["snapshotJSON": "{malformed"])
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false)
        XCTAssertTrue(report.problems.contains("invalid-embedded-json-preserve"))
        XCTAssertFalse(report.dependencyClosureComplete)
    }

    func testReferenceHeavyRecordStopsAtAggregateProjectionBudget() throws {
        let (root, main, shared) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let entries = (0..<2000).map { ["renderPath": "renders/\($0).mp4"] }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: entries), as: UTF8.self)
        try insert(shared, kind: "draft", value: ["snapshotJSON": json])
        var limits = CaptureStorageExport.Limits(); limits.outputBytes = 8192
        let report = try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: false, limits: limits)
        XCTAssertTrue(report.problems.contains("projection-limit-preserve"))
        XCTAssertFalse(report.recordScanComplete)
        XCTAssertLessThanOrEqual(try CaptureStorageExport.encoded(report).count, limits.outputBytes)
    }

    @MainActor func testBackgroundCompletionsWaitForExplicitOrdinaryHandlingAndAreNotLostOrRepeated() {
        let events = CaptureStorageDeferredEvents()
        var completed = 0, handled: [String] = []
        events.append("session-a") { completed += 1 }
        events.append("session-a") { completed += 1 }
        events.append("session-b") { completed += 1 }
        XCTAssertEqual(events.count, 3); XCTAssertEqual(completed, 0)
        events.drain { identifier, completion in handled.append(identifier); completion(); completion() }
        XCTAssertEqual(handled, ["session-a", "session-b"]); XCTAssertEqual(completed, 3)
        events.drain { _, completion in completion() }
        XCTAssertEqual(completed, 3); XCTAssertEqual(events.count, 0)
    }
}
