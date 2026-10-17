import Foundation
import SQLite3
import XCTest
@testable import CaptureCore
@testable import CaptureUI

/// Opt-in comparison of the installed full-draft read path and history metadata.
/// A supplied database must be a task-owned copy; this never contacts an account.
final class CaptureHistoryPerformanceProbeTests: XCTestCase {
    @MainActor func testDeliveryMetadataReadCosts() throws {
        let env = ProcessInfo.processInfo.environment
        guard let output = env["CAPTURE_HISTORY_PROBE_OUTPUT"], let database = env["CAPTURE_HISTORY_PROBE_DATABASE"] else {
            throw XCTSkip("Opt-in delivery metadata probe on a task-owned database copy")
        }
        let url = URL(fileURLWithPath: database)
        let full = try CaptureStore(url: url)
        let compact = try CaptureStore(url: url)
        let ids = try full.recordIDs(account: 0, kind: "delivery")
        var samples: [[String: Any]] = []
        func time(_ name: String, iteration: Int, _ work: () throws -> Int) rethrows {
            let start = ContinuousClock.now
            let count = try work()
            let d = start.duration(to: .now).components
            samples.append(["operation": name, "iteration": iteration, "count": count,
                            "milliseconds": Double(d.seconds) * 1000 + Double(d.attoseconds) / 1e15])
        }
        for id in ids {
            let job = try XCTUnwrap(full.value(DeliveryJob.self, account: 0, kind: "delivery", id: id))
            let header = try XCTUnwrap(compact.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id))
            XCTAssertEqual(header.id, job.id)
            XCTAssertEqual(header.receiptID, job.receiptID)
            XCTAssertEqual(header.stage, job.stage)
            XCTAssertEqual(header.connected, job.connected)
            XCTAssertEqual(header.draft.accountID, job.draft.accountID)
            XCTAssertEqual(header.draft.selection, job.draft.selection)
            XCTAssertEqual(header.draft.deliveryState, job.draft.deliveryState)
        }
        let cold = try CaptureStore(url: url)
        try time("delivery-cold-compact-scan", iteration: 0) {
            try ids.compactMap { try cold.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: $0) }.count
        }
        for iteration in 0..<5 {
            try time("delivery-full-pending-getter", iteration: iteration) {
                try full.containsValue(DeliveryJob.self, account: 0, kind: "delivery", matching: { ![.done, .attention].contains($0.stage) }) ? 1 : 0
            }
            try time("delivery-compact-pending-getter", iteration: iteration) {
                for id in try compact.recordIDs(account: 0, kind: "delivery") {
                    if try compact.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id)?.hasPendingWork == true { return 1 }
                }
                return 0
            }
            try time("delivery-full-progress-and-receipt-reads", iteration: iteration) {
                var count = 0
                for id in ids {
                    if try full.value(DeliveryJob.self, account: 0, kind: "delivery", id: id) != nil { count += 1 }
                    if try full.value(DeliveryJob.self, account: 0, kind: "delivery", id: id) != nil { count += 1 }
                }
                return count
            }
            try time("delivery-compact-progress-and-receipt-reads", iteration: iteration) {
                var count = 0
                for id in ids {
                    if let header = try compact.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id) {
                        _ = header.progress; count += 1
                    }
                    if try compact.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id) != nil { count += 1 }
                }
                return count
            }
        }
        let result: [String: Any] = ["schemaVersion": 1, "jobs": ids.count, "samples": samples,
            "limits": "Mac host metadata read costs only; progress/receipt reads cover all jobs, which may exceed one observed coordinator refresh. No network, credentials, device interaction or scheduling acceptance."]
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: output + ".delivery.json"))
    }

    @MainActor func testHistoryReadCosts() throws {
        let env = ProcessInfo.processInfo.environment
        guard let output = env["CAPTURE_HISTORY_PROBE_OUTPUT"] else { throw XCTSkip("Opt-in history performance probe") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-history-probe-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let account = Int(env["CAPTURE_HISTORY_PROBE_ACCOUNT"] ?? "42") ?? 42
        let url = env["CAPTURE_HISTORY_PROBE_DATABASE"].map { URL(fileURLWithPath: $0) } ?? root.appendingPathComponent("capture.sqlite")
        if env["CAPTURE_HISTORY_PROBE_DATABASE"] == nil {
            let count = min(1000, max(1, Int(env["CAPTURE_HISTORY_PROBE_DRAFTS"] ?? "180") ?? 180))
            try seed(url: url, account: account, count: count)
            // Reproduce an installed pre-index database without changing records.
            try withDatabase(url: url) { database in
                guard sqlite3_exec(database, "DROP INDEX records_recent", nil, nil, nil) == SQLITE_OK else {
                    throw CaptureError.message("Could not prepare the history fixture.")
                }
            }
        }
        var samples: [[String: Any]] = []
        let opened = ContinuousClock.now
        let store = try CaptureStore(url: url)
        let openDuration = opened.duration(to: .now).components
        samples.append(["operation": "open-including-covering-index", "iteration": 0, "count": 1,
                        "milliseconds": Double(openDuration.seconds) * 1000 + Double(openDuration.attoseconds) / 1e15])
        let ids = try store.recordIDs(account: account, kind: "draft")
        let protected = Set(ids.compactMap(UUID.init(uuidString:)))
        func time(_ name: String, iteration: Int = 0, _ work: () throws -> Int) rethrows {
            let start = ContinuousClock.now
            let count = try work()
            let d = start.duration(to: .now).components
            samples.append(["operation": name, "iteration": iteration, "count": count,
                            "milliseconds": Double(d.seconds) * 1000 + Double(d.attoseconds) / 1e15])
        }
        // These operations reproduce 815053f's list and badge loops exactly.
        func baseline(activeOnly: Bool? = nil, limit: Int) throws -> [CaptureDraft] {
            var captures: [CaptureDraft] = []
            for id in try store.recordIDs(account: account, kind: "draft") {
                guard let draft = try store.value(CaptureDraft.self, account: account, kind: "draft", id: id), !draft.input.isEmpty,
                      activeOnly == nil || draft.isActiveCapture == activeOnly else { continue }
                captures.append(draft)
                if captures.count == limit { break }
            }
            return captures
        }
        var originalActive: [UUID] = []
        try time("baseline-active-badge") {
            let values = try baseline(activeOnly: true, limit: Int.max)
            originalActive = values.map(\.id); return values.count
        }
        try time("baseline-history-page") { try baseline(limit: 101).count }
        try time("baseline-retention-protecting-all") {
            try store.recordIDs(account: account, kind: "draft").compactMap {
                try store.value(CaptureDraft.self, account: account, kind: "draft", id: $0)
            }.filter { !protected.contains($0.id) && $0.automaticDraftExpired(at: Date()) }.count
        }
        try time("baseline-combined-badge-retention-history") {
            let count = try baseline(activeOnly: true, limit: Int.max).count
            _ = try store.recordIDs(account: account, kind: "draft").compactMap {
                try store.value(CaptureDraft.self, account: account, kind: "draft", id: $0)
            }.filter { !protected.contains($0.id) && $0.automaticDraftExpired(at: Date()) }.count
            _ = try baseline(limit: 101)
            return count
        }
        try time("baseline-installed-history-tab") {
            let count = try baseline(activeOnly: true, limit: Int.max).count
            _ = try store.recordIDs(account: account, kind: "draft").compactMap {
                try store.value(CaptureDraft.self, account: account, kind: "draft", id: $0)
            }.filter { !protected.contains($0.id) && $0.automaticDraftExpired(at: Date()) }.count
            _ = try baseline(activeOnly: false, limit: 101)
            return count
        }
        try time("summary-cold-active-badge") { try store.activeCaptureCount(account: account) }
        XCTAssertEqual(try store.captureHistorySummaries(account: account, activeOnly: true, limit: Int.max).map(\.id), originalActive)
        let cold = try CaptureStore(url: url)
        try time("summary-cold-combined-badge-retention-history") {
            let count = try cold.activeCaptureCount(account: account)
            _ = try cold.archiveExpiredAutomaticDrafts(account: account, excluding: protected)
            _ = try cold.captureHistorySummaries(account: account, limit: 101)
            return count
        }
        let candidate = try CaptureStore(url: url)
        func candidateHistoryTab() throws -> Int {
            let count = try candidate.activeCaptureCount(account: account)
            _ = try candidate.archiveExpiredAutomaticDrafts(account: account, excluding: protected)
            _ = try candidate.captureHistorySummaries(account: account, activeOnly: true, limit: 101)
            _ = try candidate.archiveExpiredAutomaticDrafts(account: account, excluding: protected)
            _ = try candidate.captureHistorySummaries(account: account, activeOnly: false, limit: 101)
            return count
        }
        try time("summary-candidate-history-tab-cold", candidateHistoryTab)
        for iteration in 0..<5 {
            try time("summary-warm-active-badge", iteration: iteration) { try store.activeCaptureCount(account: account) }
            try time("summary-history-page", iteration: iteration) { try store.captureHistorySummaries(account: account, limit: 101).count }
            try time("summary-retention-protecting-all", iteration: iteration) {
                try store.archiveExpiredAutomaticDrafts(account: account, excluding: protected).count
            }
            try time("summary-warm-combined-badge-retention-history", iteration: iteration) {
                let count = try store.activeCaptureCount(account: account)
                _ = try store.archiveExpiredAutomaticDrafts(account: account, excluding: protected)
                _ = try store.captureHistorySummaries(account: account, limit: 101)
                return count
            }
            try time("summary-candidate-history-tab-warm", iteration: iteration, candidateHistoryTab)
        }
        var draftBytes: Int64 = 0
        try withDatabase(url: url) { database in
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(database, "SELECT COALESCE(SUM(LENGTH(value)),0) FROM records WHERE account=? AND kind='draft'", -1, &statement, nil) == SQLITE_OK else { throw CaptureError.message("Could not measure fixture size.") }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_int64(statement, 1, Int64(account))
            guard sqlite3_step(statement) == SQLITE_ROW else { throw CaptureError.message("Could not measure fixture size.") }
            draftBytes = sqlite3_column_int64(statement, 0)
        }
        let summaries = try store.captureHistorySummaries(account: account, limit: Int.max)
        let phases = Dictionary(grouping: summaries, by: { $0.phase.rawValue }).mapValues(\.count)
        let metadataCounts: [String: Any] = ["visibleCaptures": summaries.count,
            "emptyInputs": ids.count - summaries.count, "drafts": summaries.filter(\.isDraftCapture).count,
            "active": summaries.filter(\.isActiveCapture).count, "canceled": summaries.filter(\.isCanceled).count,
            "phases": phases]
        let result: [String: Any] = ["schemaVersion": 1, "drafts": ids.count, "active": originalActive.count,
            "metadataCounts": metadataCounts,
            "draftPayloadBytes": draftBytes, "samples": samples,
            "fixture": env["CAPTURE_HISTORY_PROBE_DATABASE"] == nil ? "fictional-source-heavy-history" : "task-owned-phone-database-copy",
            "limits": "Mac host timings; no on-phone interaction, frame latency, process lifetime or system scheduling acceptance. Retention protects every draft. No network or credentials."]
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: output))
    }

    @MainActor private func seed(url: URL, account: Int, count: Int) throws {
        let store = try CaptureStore(url: url)
        let media = (0..<160).map { index in
            JSONValue.object(["ref": .string("image-\(index)"), "url": .string("https://example.test/image/\(index).jpg"),
                              "alt": .string("Original alt description"), "raw": .object(["width": .number(1200), "height": .number(800)])])
        }
        try store.transaction {
            for index in 0..<count {
                var draft = CaptureDraft(accountID: account, defaultChannel: nil, input: "https://example.test/post/\(index)")
                draft.phase = index < 7 ? .checking : .saved
                draft.substackCapturesJSON = String(repeating: "Retained original public source record. ", count: 1200)
                draft.previewSnapshot = .init(kind: "social", url: draft.input, plan: .object([
                    "block": .object(["title": .string("Post \(index)"), "markdown": .string(String(repeating: "Complete source text\n", count: 400))]),
                    "sources": .array([.object(["media": .array(media)])])]))
                draft.savedBlock = .object(["title": .string("Saved \(index)"), "raw": .array(media)])
                try store.save(draft, account: account, kind: "draft", id: draft.id.uuidString)
            }
        }
    }

    private func withDatabase(url: URL, _ body: (OpaquePointer) throws -> Void) throws {
        var database: OpaquePointer?
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let database else {
            throw CaptureError.message("Could not open the task-owned history fixture.")
        }
        defer { sqlite3_close(database) }
        try body(database)
    }
}
