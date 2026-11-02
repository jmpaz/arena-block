import Foundation
import SQLite3
import XCTest
@testable import CaptureCore

final class CaptureProjectionTests: XCTestCase {
    private struct Envelope: Encodable {
        var stage: String
        var receiptID: String
        var sources = String(repeating: "Original captured source ", count: 1200)
    }
    private struct Stage: Decodable { var stage: String }
    private struct Receipt: Decodable { var receiptID: String }

    @MainActor func testProjectionTracksLocalAndShareChangesAndTypeAndAccountScope() throws {
        try fixture { app, url in
            let share = try CaptureStore(url: url)
            try app.save(Envelope(stage: "queued", receiptID: "cycle-1"), account: 42, kind: "delivery", id: "job")
            XCTAssertEqual(try app.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")?.stage, "queued")
            XCTAssertEqual(try app.projectedValue(Receipt.self, account: 42, kind: "delivery", id: "job")?.receiptID, "cycle-1")
            try share.save(Envelope(stage: "done", receiptID: "cycle-2"), account: 42, kind: "delivery", id: "job")
            XCTAssertEqual(try app.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")?.stage, "done")
            XCTAssertEqual(try app.projectedValue(Receipt.self, account: 42, kind: "delivery", id: "job")?.receiptID, "cycle-2")
            try app.save(Envelope(stage: "attention", receiptID: "cycle-3"), account: 42, kind: "delivery", id: "job")
            try app.save(Envelope(stage: "queued", receiptID: "other-account"), account: 99, kind: "delivery", id: "job")
            XCTAssertEqual(try app.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")?.stage, "attention")
            XCTAssertEqual(try app.projectedValue(Stage.self, account: 99, kind: "delivery", id: "job")?.stage, "queued")
            try share.remove(account: 42, kind: "delivery", id: "job")
            XCTAssertNil(try app.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job"))
            XCTAssertEqual(try app.projectedValue(Receipt.self, account: 99, kind: "delivery", id: "job")?.receiptID, "other-account")
        }
    }

    @MainActor func testProjectionReadInsideRolledBackMutationCannotEscapeRollback() throws {
        enum Abort: Error { case requested }
        try fixture { store, _ in
            try store.save(Envelope(stage: "queued", receiptID: "cycle-1"), account: 42, kind: "delivery", id: "job")
            _ = try store.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")
            XCTAssertThrowsError(try store.transaction {
                try store.save(Envelope(stage: "done", receiptID: "cycle-2"), account: 42, kind: "delivery", id: "job")
                XCTAssertEqual(try store.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")?.stage, "done")
                throw Abort.requested
            })
            XCTAssertEqual(try store.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")?.stage, "queued")
            XCTAssertThrowsError(try store.transaction {
                try store.remove(account: 42, kind: "delivery", id: "job")
                XCTAssertNil(try store.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job"))
                throw Abort.requested
            })
            XCTAssertEqual(try store.projectedValue(Receipt.self, account: 42, kind: "delivery", id: "job")?.receiptID, "cycle-1")
        }
    }

    @MainActor func testRevisionStillAdvancesWhenStoredClockIsAheadAndOtherWriterSaves() throws {
        try fixture { app, url in
            try app.save(Envelope(stage: "queued", receiptID: "cycle-1"), account: 42, kind: "delivery", id: "job")
            var database: OpaquePointer?
            XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
            defer { sqlite3_close(database) }
            let future = Date().addingTimeInterval(3600).timeIntervalSince1970
            XCTAssertEqual(sqlite3_exec(database, "UPDATE records SET updated=\(future) WHERE kind='delivery'", nil, nil, nil), SQLITE_OK)
            _ = try app.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")
            let share = try CaptureStore(url: url)
            try share.save(Envelope(stage: "attention", receiptID: "cycle-2"), account: 42, kind: "delivery", id: "job")
            let first = try XCTUnwrap(app.recordRevisions(account: 42, kind: "delivery").first?.revision)
            XCTAssertGreaterThan(first, future)
            XCTAssertEqual(try app.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")?.stage, "attention")
            try share.save(Envelope(stage: "done", receiptID: "cycle-3"), account: 42, kind: "delivery", id: "job")
            XCTAssertGreaterThan(try XCTUnwrap(app.recordRevisions(account: 42, kind: "delivery").first?.revision), first)
            XCTAssertEqual(try app.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job")?.stage, "done")
        }
    }

    @MainActor func testProjectionEvictionNeverHidesOlderRecords() throws {
        try fixture { store, _ in
            try store.transaction {
                for index in 0..<530 {
                    try store.save(["stage": "stage-\(index)"], account: 42, kind: "delivery", id: "job-\(index)")
                    XCTAssertEqual(try store.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job-\(index)")?.stage, "stage-\(index)")
                }
            }
            XCTAssertEqual(try store.projectedValue(Stage.self, account: 42, kind: "delivery", id: "job-0")?.stage, "stage-0")
            XCTAssertEqual(try store.recordIDs(account: 42, kind: "delivery").count, 530)
        }
    }

    @MainActor private func fixture(_ body: (CaptureStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-projection-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("capture.sqlite")
        try body(CaptureStore(url: url), url)
    }
}
