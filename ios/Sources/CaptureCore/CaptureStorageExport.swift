import CryptoKit
import Darwin
import Foundation
import SQLite3

/// A bounded observation of local metadata and recognized persisted references.
/// It never opens a CaptureStore, credentials, a URLSession, or a delivery owner.
public enum CaptureStorageExport {
    public struct Limits: Sendable {
        public var seconds: Double = 30
        public var records: Int = 20_000
        public var files: Int = 20_000
        public var recordBytes: Int = 4 * 1024 * 1024
        public var totalRecordBytes: Int = 64 * 1024 * 1024
        public var nodes: Int = 250_000
        public var depth: Int = 64
        public var outputBytes: Int = 2 * 1024 * 1024
        public init() {}
    }
    public struct Reference: Codable, Sendable {
        public var field: String
        public var pathSHA256: String
        public var embedded: Bool
        public var alias: Bool
    }
    public struct Record: Codable, Sendable {
        public var kind: String
        public var idSHA256: String
        public var valueSHA256: String
        public var valueBytes: Int
        public var captureIDs: [String]
        public var references: [Reference]
        public var phase: String?
        public var stage: String?
        public var transferID: String?
        public var sessionIdentifierSHA256: String?
    }
    public struct File: Codable, Sendable {
        public var container: String
        public var pathSHA256: String
        public var category: String
        public var logicalBytes: Int64
        public var allocatedBytes: Int64
        public var associatedRecordIDs: [String]
    }
    public struct Report: Codable, Sendable {
        public var format = "capture-storage-export-v1"
        public var createdAt = Date()
        public var completedAt: Date?
        public var normalCaptureAlreadyActive: Bool
        public var interrupted = false
        public var recordScanComplete = false
        public var fileScanComplete = false
        public var stable = false
        public var stabilityScope = "record-digests-and-regular-file-metadata-only"
        public var dependencyClosureComplete = false
        public var osTaskCoverage = "not-queried-preserve"
        public var extensionAndSystemDependencies = "unknown-preserve"
        public var skippedSourceAndUnknownFields = "unprojected-preserve"
        public var captureSessionsStartedByExport = 0
        public var mediaBytesRead = 0
        public var records: [Record] = []
        public var files: [File] = []
        public var problems: [String] = []
        public var deletionPerformed = false
    }
    public enum Failure: Error { case invalidLimits, outputLimit }
    private enum Stop: Error { case limit(String) }
    private final class Budget {
        let end: Double
        let limits: Limits
        var projectedBytes = 2048
        var nodes = 0
        init(_ limits: Limits) { self.limits = limits; end = ProcessInfo.processInfo.systemUptime + limits.seconds }
        var expired: Bool { Task.isCancelled || ProcessInfo.processInfo.systemUptime >= end }
        func check() throws {
            try Task.checkCancellation()
            if expired { throw Stop.limit("time-limit") }
        }
        func reserve(_ bytes: Int) throws {
            try check()
            guard bytes >= 0, projectedBytes <= limits.outputBytes - bytes else { throw Stop.limit("projection-limit-preserve") }
            projectedBytes += bytes
        }
    }
    private static let kinds: Set<String> = ["draft", "deletedDraft", "delivery", "canceledDelivery", "deliveryReceipt", "prepared", "workspace", "incoming", "publicationLock", "mediaPromotion", "deliveryAttempt", "deliveryProgress", "deliveryTransfer"]
    private static let pathFields: Set<String> = ["mediapath", "renderpath", "previewpath", "reusablerenderpath", "directorypath", "relativedirectory", "fileurl", "recordingpath", "localmediapath"]
    private static let jsonFields: Set<String> = ["snapshotjson", "planjson", "sourcesjson"]
    private static let containers: Set<String> = ["draft", "submission", "previewsnapshot"]
    private static let privateFields: Set<String> = ["authorization", "token", "accesstoken", "refreshtoken", "uploadurl", "uploadkey", "uploadtoken", "credentials", "headers", "cookies", "body", "text", "html", "markdown", "description", "title", "previewtext", "content", "caption", "alt", "alttext", "input", "editedtext", "titleoverride", "descriptionoverride", "problem"]
    private static let roots: Set<String> = ["renders", "previews", "composition-previews", "originals", "recordings", "temporary-media-v1", "delivery"]
    private static let identityFields: Set<String> = ["id", "captureid", "draftid", "operationid", "receiptid", "activedraftid", "retainedresultid"]
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func hash(_ text: String) -> String { hash(Data(text.utf8)) }
    private static func pathKey(_ relative: String) -> String { hash(relative) }

    /// Alias matches add preservation evidence; they do not authenticate a path.
    private static func relative(_ text: String, container: URL) -> (String, Bool)? {
        let value: String
        if text.hasPrefix("file://"), let url = URL(string: text), url.isFileURL, url.host == nil || url.host == "localhost" { value = url.path }
        else { value = text }
        let parts = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.contains(".."), !value.contains("\\"), !value.contains("\0") else { return nil }
        let prefix = container.standardizedFileURL.path + "/"
        if value.hasPrefix(prefix) { return (String(value.dropFirst(prefix.count)), false) }
        if prefix.hasPrefix("/private/var/"), value.hasPrefix(String(prefix.dropFirst("/private".count))) {
            return (String(value.dropFirst(prefix.count - "/private".count)), true)
        }
        if prefix.hasPrefix("/private/tmp/"), value.hasPrefix(String(prefix.dropFirst("/private".count))) {
            return (String(value.dropFirst(prefix.count - "/private".count)), true)
        }
        if let first = parts.first, roots.contains(first) { return (value, false) }
        // Historical App Group container identity may change after an update.
        if let marker = value.range(of: "/Containers/Shared/AppGroup/") {
            let tail = value[marker.upperBound...].split(separator: "/").map(String.init)
            if tail.count > 1, UUID(uuidString: tail[0]) != nil, roots.contains(tail[1]) { return (tail.dropFirst().joined(separator: "/"), true) }
        }
        return nil
    }

    private static func snapshot(database: URL, container: URL, budget: Budget, project: Bool = true) throws -> ([Record], String, [String]) {
        var before = stat()
        guard lstat(database.path, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG else { throw Stop.limit("database-missing-or-not-regular") }
        var pointer: OpaquePointer?
        guard sqlite3_open_v2(database.path, &pointer, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, nil) == SQLITE_OK, let db = pointer else {
            if let pointer { sqlite3_close(pointer) }; throw Stop.limit("read-only-database-unavailable")
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 250)
        sqlite3_limit(db, SQLITE_LIMIT_LENGTH, Int32(budget.limits.recordBytes + 4096))
        sqlite3_progress_handler(db, 1000, { raw in
            guard let raw else { return 1 }
            return Unmanaged<Budget>.fromOpaque(raw).takeUnretainedValue().expired ? 1 : 0
        }, Unmanaged.passUnretained(budget).toOpaque())
        defer { sqlite3_progress_handler(db, 0, nil, nil) }
        guard sqlite3_exec(db, "PRAGMA query_only=ON; BEGIN", nil, nil, nil) == SQLITE_OK else { throw Stop.limit("read-only-snapshot-unavailable") }
        defer { sqlite3_exec(db, "ROLLBACK", nil, nil, nil) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT account,kind,id,value,updated FROM records ORDER BY account,kind,id", -1, &statement, nil) == SQLITE_OK, let statement else { throw Stop.limit("records-unavailable") }
        defer { sqlite3_finalize(statement) }
        var rows: [Record] = [], total = 0, digest = SHA256(), problems: Set<String> = []
        var count = 0
        while true {
            try budget.check()
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw Stop.limit("record-query-incomplete") }
            count += 1
            guard count <= budget.limits.records else { throw Stop.limit("record-count-limit") }
            let size = Int(sqlite3_column_bytes(statement, 3))
            guard size > 0, size <= budget.limits.recordBytes, total <= budget.limits.totalRecordBytes - size,
                  let bytes = sqlite3_column_blob(statement, 3),
                  let rawKind = sqlite3_column_text(statement, 1), let rawID = sqlite3_column_text(statement, 2) else { throw Stop.limit("record-byte-limit") }
            total += size
            let kind = String(cString: rawKind), id = String(cString: rawID), data = Data(bytes: bytes, count: size)
            // Framed, deterministic row identity. No raw values leave the report.
            for column in 0..<5 {
                let n = Int(sqlite3_column_bytes(statement, Int32(column)))
                var length = UInt64(n).bigEndian
                withUnsafeBytes(of: &length) { digest.update(data: Data($0)) }
                if let value = sqlite3_column_blob(statement, Int32(column)) { digest.update(data: Data(bytes: value, count: n)) }
            }
            if !project { continue }
            try budget.reserve(512)
            let key = "\(sqlite3_column_int64(statement, 0)):\(kind.utf8.count):\(kind):\(id)"
            var row = Record(kind: kinds.contains(kind) ? kind : "other-preserve", idSHA256: hash(key), valueSHA256: hash(data), valueBytes: size, captureIDs: [], references: [])
            guard kinds.contains(kind) else { rows.append(row); problems.insert("unprojected-record-kinds-preserve"); continue }
            guard let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { problems.insert("invalid-record-json-preserve"); rows.append(row); continue }
            var ids: Set<String> = []
            if let uuid = UUID(uuidString: id) { try budget.reserve(40); ids.insert(uuid.uuidString) }
            func walk(_ value: Any, field: String, depth: Int, embedded: Bool) throws {
                try budget.check(); budget.nodes += 1
                guard budget.nodes <= budget.limits.nodes, depth <= budget.limits.depth else { throw Stop.limit("dependency-walk-limit") }
                if let text = value as? String {
                    if identityFields.contains(field), let uuid = UUID(uuidString: text), !ids.contains(uuid.uuidString) {
                        try budget.reserve(40); ids.insert(uuid.uuidString)
                    }
                    if pathFields.contains(field) {
                        if let (path, alias) = relative(text, container: container) {
                            try budget.reserve(256)
                            row.references.append(.init(field: field, pathSHA256: pathKey(path), embedded: embedded, alias: alias))
                        } else { problems.insert("unresolved-local-reference-preserve") }
                    } else if jsonFields.contains(field) {
                        guard text.utf8.count <= budget.limits.recordBytes, let nested = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) else { problems.insert("invalid-embedded-json-preserve"); return }
                        try walk(nested, field: "", depth: depth + 1, embedded: true)
                    }
                } else if let dictionary = value as? [String: Any] {
                    for key in dictionary.keys.sorted() where !privateFields.contains(key.lowercased()) {
                        let name = key.lowercased(), child = dictionary[key]!
                        if child is String || containers.contains(name) {
                            try walk(child, field: name, depth: depth + 1, embedded: embedded)
                        }
                    }
                } else if let array = value as? [Any] { for child in array { try walk(child, field: field, depth: depth + 1, embedded: embedded) } }
            }
            try walk(object, field: "", depth: 0, embedded: false)
            row.captureIDs = ids.sorted()
            let dictionary = object as? [String: Any] ?? [:], draft = dictionary["draft"] as? [String: Any] ?? dictionary
            row.phase = (draft["phase"] as? String).flatMap { CapturePhase(rawValue: $0)?.rawValue }
            row.stage = (dictionary["stage"] as? String).flatMap { CaptureDeliveryStage(rawValue: $0)?.rawValue }
            row.transferID = (dictionary["transferID"] as? String).flatMap { UUID(uuidString: $0)?.uuidString }
            if let name = dictionary["transferSession"] as? String, name.hasPrefix("net.fjpaz.arena-capture"), name.hasSuffix(".delivery"), !name.contains("/"), !name.contains("..") { row.sessionIdentifierSHA256 = hash(name) }
            rows.append(row)
        }
        var after = stat()
        guard lstat(database.path, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino else { throw Stop.limit("database-identity-changed") }
        return (rows, digest.finalize().map { String(format: "%02x", $0) }.joined(), problems.sorted())
    }

    public static func collect(main: URL, shared: URL, normalCaptureAlreadyActive: Bool, limits: Limits = .init()) throws -> Report {
        guard limits.seconds.isFinite, limits.seconds > 0, limits.seconds <= 30, limits.records > 0, limits.records <= 20_000,
              limits.files > 0, limits.files <= 20_000, limits.recordBytes > 0, limits.recordBytes <= 4 * 1024 * 1024,
              limits.totalRecordBytes > 0, limits.totalRecordBytes <= 64 * 1024 * 1024, limits.nodes > 0, limits.nodes <= 250_000,
              limits.depth > 0, limits.depth <= 64, limits.outputBytes >= 4096, limits.outputBytes <= 2 * 1024 * 1024 else { throw Failure.invalidLimits }
        let budget = Budget(limits)
        var report = Report(normalCaptureAlreadyActive: normalCaptureAlreadyActive)
        if normalCaptureAlreadyActive { report.problems.append("normal-capture-already-active-preserve") }
        // Foundation can retain /var or /tmp aliases. SQLite NOFOLLOW correctly
        // rejects those ancestors; use realpath for the two platform-owned roots.
        func canonical(_ url: URL) throws -> URL {
            guard let path = realpath(url.path, nil) else { throw Stop.limit("container-unavailable") }
            defer { free(path) }
            return URL(fileURLWithPath: String(cString: path), isDirectory: true)
        }
        let main = try canonical(main), shared = try canonical(shared)
        let database = shared.appendingPathComponent("capture.sqlite")
        var initialDigest: String?
        do {
            let (records, digest, problems) = try snapshot(database: database, container: shared, budget: budget)
            report.records = records; initialDigest = digest; report.problems += problems; report.recordScanComplete = true
        } catch let error as Stop { if case let .limit(code) = error { report.problems.append(code) } }
        let recordByPath = Dictionary(grouping: report.records.flatMap { row in row.references.map { ($0.pathSHA256, row.idSHA256) } }, by: { $0.0 })
        let recordByCapture = Dictionary(grouping: report.records.flatMap { row in row.captureIDs.map { ($0, row.idSHA256) } }, by: { $0.0 })
        var fingerprints: [String: String] = [:]
        func metadata(_ root: URL, role: String, retain: Bool) throws -> [String: String] {
            var result: [String: String] = [:]
            var entries = 0
            var enumerationFailed = false
            guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: [], errorHandler: { _, _ in enumerationFailed = true; return false }) else { throw Stop.limit("container-unavailable") }
            let rootParts = root.pathComponents
            while let url = walker.nextObject() as? URL {
                try budget.check()
                entries += 1
                guard entries <= limits.files else { throw Stop.limit("file-count-limit") }
                var info = stat()
                guard lstat(url.path, &info) == 0 else { throw Stop.limit("metadata-unavailable") }
                let kind = info.st_mode & S_IFMT
                if kind == S_IFLNK { walker.skipDescendants(); report.problems.append("symlink-preserve"); continue }
                if kind == S_IFDIR { continue }
                guard kind == S_IFREG else { report.problems.append("nonregular-entry-preserve"); continue }
                // Enumerator URLs may use the /var alias of our /private/var
                // root. Drop the known number of root components, not a text prefix.
                let parts = url.pathComponents
                let difference = root.path.hasPrefix("/private/") && !url.path.hasPrefix("/private/") ? 1 : 0
                guard parts.count > rootParts.count - difference else { throw Stop.limit("enumerated-path-unavailable") }
                let path = parts.dropFirst(rootParts.count - difference).joined(separator: "/"), key = pathKey(path)
                // -shm read marks are SQLite coordination, not persisted capture bytes.
                if path != "capture.sqlite-shm" { result[key] = "\(info.st_dev):\(info.st_ino):\(info.st_size):\(info.st_mtimespec.tv_sec):\(info.st_mtimespec.tv_nsec):\(info.st_ctimespec.tv_sec):\(info.st_ctimespec.tv_nsec)" }
                if retain {
                    guard report.files.count < limits.files else { throw Stop.limit("file-count-limit") }
                    var owners = Set(role == "shared" ? recordByPath[key, default: []].map { $0.1 } : [])
                    if role == "shared" {
                        for component in path.split(separator: "/") {
                            if let uuid = UUID(uuidString: String(component)) { owners.formUnion(recordByCapture[uuid.uuidString, default: []].map { $0.1 }) }
                        }
                        // Directory references preserve descendants, not just the directory entry.
                        var parent = (path as NSString).deletingLastPathComponent
                        while !parent.isEmpty && parent != "." {
                            owners.formUnion(recordByPath[pathKey(parent), default: []].map { $0.1 })
                            parent = (parent as NSString).deletingLastPathComponent
                        }
                    }
                    let first = path.split(separator: "/").first.map(String.init) ?? ""
                    let category = roots.contains(first) ? first : (path.hasPrefix("capture.sqlite") ? "capture-database" : "other-preserve")
                    try budget.reserve(512 + owners.count * 72)
                    report.files.append(.init(container: role, pathSHA256: key, category: category, logicalBytes: Int64(info.st_size), allocatedBytes: Int64(info.st_blocks) * 512, associatedRecordIDs: owners.sorted()))
                }
            }
            if enumerationFailed { throw Stop.limit("enumeration-incomplete") }
            return result
        }
        do {
            for (role, root) in [("main", main), ("shared", shared)] {
                let values = try metadata(root, role: role, retain: true)
                for (key, value) in values { fingerprints[role + ":" + key] = value }
            }
            report.fileScanComplete = true
            let (_, digest, _) = try snapshot(database: database, container: shared, budget: budget, project: false)
            var after: [String: String] = [:]
            for (role, root) in [("main", main), ("shared", shared)] {
                for (key, value) in try metadata(root, role: role, retain: false) { after[role + ":" + key] = value }
            }
            report.stable = initialDigest == digest && fingerprints == after
            if !report.stable { report.problems.append("snapshot-changed-preserve") }
        } catch let error as Stop { if case let .limit(code) = error { report.problems.append(code) } }
        try budget.check()
        report.problems = Array(Set(report.problems)).sorted()
        report.completedAt = Date()
        // Fail safely rather than silently truncating dependencies to fit the export.
        _ = try encoded(report, maximumBytes: limits.outputBytes)
        try budget.check()
        return report
    }

    public static func encoded(_ report: Report, maximumBytes: Int = 2 * 1024 * 1024) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(report)
        guard maximumBytes > 0, maximumBytes <= 2 * 1024 * 1024, data.count <= maximumBytes else { throw Failure.outputLimit }
        return data
    }
}
