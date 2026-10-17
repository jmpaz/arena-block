import Foundation
import SQLite3

/// Metadata and existing-record references only. Never initializes CaptureStore,
/// a delivery session, account credentials or a network task; never deletes data.
public enum CaptureStorageAudit {
    public struct File: Codable, Sendable {
        public var path: String
        public var logicalBytes: Int64
        public var allocatedBytes: Int64?
        public var category: String
        public var referencedBy: [String]
    }
    public struct Report: Codable, Sendable {
        public var createdAt: Date
        public var files: [File]
        public var logicalBytes: Int64
        public var measuredAllocatedBytes: Int64
        public var allocatedSizeUnknownForFiles: Int
        public var categoryBytes: [String: Int64]
        public var recordCounts: [String: Int]
        public var recordStateCounts: [String: Int]
        public var problems: [String]
        public var complete: Bool
        public var deletionPerformed = false
        public var networkOrDeliveryInitialized = false
    }

    public static func inspect(container: URL, database: URL? = nil) -> Report {
        let fm = FileManager.default
        var problems: [String] = [], references: [String: Set<String>] = [:], counts: [String: Int] = [:]
        var states: [String: Int] = [:]
        func databaseMetadata() -> [String: String] {
            guard let database else { return [:] }
            var result: [String: String] = [:]
            for suffix in ["", "-wal"] {
                if let attributes = try? fm.attributesOfItem(atPath: database.path + suffix) {
                    let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSinceReferenceDate ?? -1
                    result[suffix] = "\(attributes[.size] ?? 0):\(modified):\(attributes[.systemFileNumber] ?? 0)"
                }
            }
            return result
        }
        let databaseBefore = databaseMetadata()
        if let database {
            var db: OpaquePointer?
            if sqlite3_open_v2(database.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db {
                defer { sqlite3_close(db) }
                sqlite3_busy_timeout(db, 3000)
                let transaction = sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK
                if !transaction { problems.append("The record reference snapshot could not begin consistently.") }
                defer { if transaction { sqlite3_exec(db, "ROLLBACK", nil, nil, nil) } }
                var statement: OpaquePointer?
                if sqlite3_prepare_v2(db, "SELECT kind,value FROM records", -1, &statement, nil) == SQLITE_OK, let statement {
                    defer { sqlite3_finalize(statement) }
                    var step = sqlite3_step(statement)
                    while step == SQLITE_ROW {
                        let kind = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? "unknown"
                        counts[kind, default: 0] += 1
                        if let bytes = sqlite3_column_blob(statement, 1) {
                            let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 1)))
                            if let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
                                if let record = object as? [String: Any] {
                                    let draft = record["draft"] as? [String: Any] ?? record
                                    if let phase = draft["phase"] as? String, CapturePhase(rawValue: phase) != nil {
                                        states[kind + ".phase." + phase, default: 0] += 1
                                    }
                                    if let stage = record["stage"] as? String, CaptureDeliveryStage(rawValue: stage) != nil {
                                        states[kind + ".stage." + stage, default: 0] += 1
                                    }
                                    if record["transferID"] is String { states[kind + ".retained-transfer-reference", default: 0] += 1 }
                                    if record["stopRequestedAt"] != nil { states[kind + ".stop-requested", default: 0] += 1 }
                                    if record["canceledAt"] != nil { states[kind + ".canceled", default: 0] += 1 }
                                }
                                func visit(_ value: Any) {
                                    if let text = value as? String {
                                        let url = text.hasPrefix("file://") ? URL(string: text) : (text.hasPrefix("/") ? URL(fileURLWithPath: text) : nil)
                                        if let url, url.isFileURL, url.standardizedFileURL.path.hasPrefix(container.standardizedFileURL.path + "/") {
                                            references[url.standardizedFileURL.path, default: []].insert(kind)
                                        }
                                    } else if let dictionary = value as? [String: Any] { dictionary.values.forEach(visit) }
                                    else if let array = value as? [Any] { array.forEach(visit) }
                                }
                                visit(object)
                            } else { problems.append("A \(kind) record could not be decoded; dependencies are incomplete.") }
                        }
                        step = sqlite3_step(statement)
                    }
                    if step != SQLITE_DONE { problems.append("The record scan did not finish; dependencies are incomplete.") }
                } else { problems.append("The existing records table could not be read.") }
            } else {
                if let db { sqlite3_close(db) }
                problems.append("The existing database could not be opened read-only.")
            }
        }
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .totalFileAllocatedSizeKey]
        var files: [File] = []
        if let walker = fm.enumerator(at: container, includingPropertiesForKeys: Array(keys), options: [], errorHandler: { _, _ in
            problems.append("A directory could not be enumerated."); return true
        }) {
            for case let url as URL in walker {
                do {
                    let values = try url.resourceValues(forKeys: keys)
                    if values.isSymbolicLink == true { walker.skipDescendants(); problems.append("A symbolic link was preserved without following it."); continue }
                    guard values.isRegularFile == true else { continue }
                    guard let size = values.fileSize else { problems.append("A file size could not be measured."); continue }
                    let prefix = container.standardizedFileURL.path + "/"
                    let relative = String(url.standardizedFileURL.path.dropFirst(prefix.count))
                    let owners = references[url.standardizedFileURL.path] ?? []
                    let first = relative.split(separator: "/").first.map(String.init) ?? relative
                    let category: String
                    if ["capture.sqlite", "capture.sqlite-wal", "capture.sqlite-shm"].contains(relative) { category = "capture-database" }
                    else if first == "renders" {
                        if !owners.isDisjoint(with: ["delivery", "canceledDelivery"]) { category = "render-referenced-by-pending-or-canceled-save" }
                        else if !owners.isEmpty { category = "render-referenced-by-retained-capture-or-receipt" }
                        else { category = "render-without-observed-record-reference-preserve" }
                    } else if first == "previews" { category = owners.isEmpty ? "link-preview-without-observed-reference-preserve" : "link-preview-referenced-by-retained-capture" }
                    else if first == "composition-previews" { category = "legacy-composition-preview-preserve" }
                    else if first == NativeMediaWorkspace.directoryName { category = "owned-temporary-workspace-check-lease-before-expiry" }
                    else if first == "delivery" { category = "transfer-request-response-and-lock-artifacts-preserve" }
                    else if relative.hasPrefix("Documents/CaptureDiagnostics/") { category = "diagnostic-evidence-preserve" }
                    else if relative.hasPrefix("Library/") { category = "system-managed-or-unclassified-library-data-preserve" }
                    else { category = "other-data-preserve" }
                    files.append(.init(path: relative, logicalBytes: Int64(size),
                                       allocatedBytes: values.totalFileAllocatedSize.map(Int64.init), category: category, referencedBy: owners.sorted()))
                } catch { problems.append("Metadata could not be read for an entry.") }
            }
        } else { problems.append("The container could not be enumerated.") }
        if databaseMetadata() != databaseBefore {
            problems.append("Database metadata changed during inspection; repeat with capture and transfers inactive before classifying dependencies.")
        }
        var categories: [String: Int64] = [:]
        for file in files { categories[file.category, default: 0] += file.logicalBytes }
        return .init(createdAt: Date(), files: files.sorted { $0.path < $1.path }, logicalBytes: files.reduce(0) { $0 + $1.logicalBytes },
                     measuredAllocatedBytes: files.reduce(0) { $0 + ($1.allocatedBytes ?? 0) },
                     allocatedSizeUnknownForFiles: files.filter { $0.allocatedBytes == nil }.count,
                     categoryBytes: categories, recordCounts: counts, recordStateCounts: states,
                     problems: problems, complete: problems.isEmpty)
    }
}
