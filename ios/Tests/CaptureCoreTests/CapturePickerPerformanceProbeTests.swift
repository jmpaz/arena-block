import Foundation
import XCTest
@testable import CaptureCore

/// Opt-in diagnostics for the actual picker cache/search work. This does not
/// change the release app or use a network account. Timings are observations,
/// not acceptance thresholds; a simulator/Mac is not the user's phone.
final class CapturePickerPerformanceProbeTests: XCTestCase {
    @MainActor func testChannelPageAndFuzzySearchCosts() throws {
        guard let output = ProcessInfo.processInfo.environment["CAPTURE_PERFORMANCE_PROBE_OUTPUT"] else {
            throw XCTSkip("Opt-in performance probe")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capture-picker-probe-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let channels = (1...2000).map { id in
            Channel(id: id, title: "\(id.isMultiple(of: 3) ? "Interface design" : "Field notes") \(id)",
                    slug: "channel-\(id)", visibility: id.isMultiple(of: 2) ? "private" : "public",
                    owner: Owner(id: 1, name: "Example Writer", slug: "example-user", type: "User"))
        }
        var samples: [[String: Any]] = []
        func time(_ name: String, count: Int, iteration: Int, _ work: () throws -> Void) rethrows {
            let start = ContinuousClock.now
            try work()
            let duration = start.duration(to: .now).components
            samples.append(["operation": name, "channels": count, "iteration": iteration,
                            "milliseconds": Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15])
        }
        for batched in [false, true] {
            let store = try CaptureStore(url: root.appendingPathComponent(batched ? "batched.sqlite" : "individual.sqlite"))
            try store.transaction {
                for channel in channels.prefix(500) {
                    try store.save(channel, account: 1, kind: "channel", id: String(channel.id))
                }
            }
            for iteration in 0..<5 {
                let page = Array(channels[(500 + iteration * 30)..<(530 + iteration * 30)])
                try time(batched ? "page-batched-transaction" : "page-current-individual-commits", count: 30, iteration: iteration) {
                    let writes = {
                        for channel in page {
                            try store.save(channel, account: 1, kind: "channel", id: String(channel.id))
                        }
                        try store.prune(account: 1, kind: "channel", keeping: 500)
                    }
                    if batched { try store.transaction(writes) } else { try writes() }
                    let cached = try store.values(Channel.self, account: 1, kind: "channel", limit: 500)
                    XCTAssertEqual(cached.count, 500)
                    XCTAssertEqual(Set(cached.map(\.id)).count, 500)
                    XCTAssertTrue(page.allSatisfy { channel in cached.contains { $0.id == channel.id } })
                }
            }
        }
        for count in [500, 2000] {
            let cache = Array(channels.prefix(count))
            let index = ChannelSearch.Index(cache)
            for query in ["interface", "interfce", "josh interface", "xyzabc", "field notes"] {
                for iteration in 0..<5 {
                    time("indexed-search:\(query)", count: count, iteration: iteration) {
                        _ = index.matches(query: query)
                    }
                }
            }
        }
        let result: [String: Any] = ["schemaVersion": 1, "platform": ProcessInfo.processInfo.operatingSystemVersionString,
                                   "source": "capture-picker-performance-fixture", "samples": samples,
                                   "limits": "Mac Core test timings. Does not measure on-phone frame latency or rendered interaction acceptance."]
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: output))
    }
}
