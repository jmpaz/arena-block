import Foundation
import SQLite3

@MainActor
public final class CaptureStore {
    /// A read-only snapshot for diagnosing a shared-container lock at suspension.
    /// SQLite's main-file lock state does not include every WAL/shared-memory lock.
    public struct LockSnapshot: Equatable {
        public let isOpen: Bool
        public let transactionState: Int32
        public let autocommit: Bool
        public let preparedStatements: Int
        public let mainFileLockState: Int32?
    }

    private var database: OpaquePointer?
    private let url: URL
    private var schemaConfigured = false
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(url: URL) throws {
        self.url = url
        try openDatabase()
    }

    private func openDatabase() throws {
        guard database == nil else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            if let database { sqlite3_close(database) }
            database = nil
            throw CaptureError.message("Could not open saved captures.")
        }
        do {
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.deletingLastPathComponent().path)
            #endif
            sqlite3_busy_timeout(database, 3000)
            if !schemaConfigured { try execute("PRAGMA journal_mode=WAL") }
            try execute("PRAGMA synchronous=FULL")
            if !schemaConfigured {
                try execute("CREATE TABLE IF NOT EXISTS records (account INTEGER NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value BLOB NOT NULL, updated REAL NOT NULL, PRIMARY KEY(account,kind,id))")
                schemaConfigured = true
            }
            #if os(iOS)
            for path in [url.path, url.path + "-wal", url.path + "-shm"] where FileManager.default.fileExists(atPath: path) {
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
            }
            #endif
        } catch {
            sqlite3_close(database)
            database = nil
            throw error
        }
    }

    deinit { sqlite3_close(database) }

    public func diagnosticLockSnapshot() -> LockSnapshot {
        guard let database else {
            return LockSnapshot(isOpen: false, transactionState: 0, autocommit: true,
                                preparedStatements: 0, mainFileLockState: nil)
        }
        let transactionState = sqlite3_txn_state(database, "main")
        let autocommit = sqlite3_get_autocommit(database) != 0
        var preparedStatements = 0
        var statement = sqlite3_next_stmt(database, nil)
        while statement != nil {
            preparedStatements += 1
            statement = sqlite3_next_stmt(database, statement)
        }
        var fileLock: Int32 = 0
        let mainFileLockState = sqlite3_file_control(database, "main", SQLITE_FCNTL_LOCKSTATE, &fileLock) == SQLITE_OK ? fileLock : nil
        return LockSnapshot(isOpen: true, transactionState: transactionState, autocommit: autocommit,
                            preparedStatements: preparedStatements, mainFileLockState: mainFileLockState)
    }

    /// Relinquish an idle shared-container lock before iOS suspends the process.
    /// Work that resumes in the background can reopen the same database on demand.
    @discardableResult public func releaseIdleConnection() -> Bool {
        guard let database else { return true }
        guard sqlite3_get_autocommit(database) != 0,
              sqlite3_txn_state(database, "main") == 0,
              sqlite3_next_stmt(database, nil) == nil,
              sqlite3_close(database) == SQLITE_OK else { return false }
        self.database = nil
        return true
    }

    public func save<T: Encodable>(_ value: T, account: Int, kind: String, id: String) throws {
        let data = try JSONEncoder().encode(value)
        let sql = "INSERT INTO records(account,kind,id,value,updated) VALUES(?,?,?,?,?) ON CONFLICT(account,kind,id) DO UPDATE SET value=excluded.value,updated=excluded.updated"
        let statement = try prepare(sql); defer { sqlite3_finalize(statement) }
        bind(account: account, kind: kind, statement: statement)
        sqlite3_bind_text(statement, 3, id, -1, transient)
        _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, 4, $0.baseAddress, Int32($0.count), transient) }
        sqlite3_bind_double(statement, 5, Date().timeIntervalSince1970)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
    }

    public func recordIDs(account: Int, kind: String) throws -> [String] {
        let statement = try prepare("SELECT id FROM records WHERE account=? AND kind=? ORDER BY updated DESC")
        defer { sqlite3_finalize(statement) }
        bind(account: account, kind: kind, statement: statement)
        var ids: [String] = []
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
            if let text = sqlite3_column_text(statement, 0) { ids.append(String(cString: text)) }
            result = sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw failure() }
        return ids
    }

    public func containsValue<T: Decodable>(_ type: T.Type, account: Int, kind: String, matching: (T) -> Bool) throws -> Bool {
        for id in try recordIDs(account: account, kind: kind) {
            if let value = try value(type, account: account, kind: kind, id: id), matching(value) { return true }
        }
        return false
    }

    public func values<T: Decodable>(_ type: T.Type, account: Int, kind: String, limit: Int = 100) throws -> [T] {
        let statement = try prepare("SELECT value FROM records WHERE account=? AND kind=? ORDER BY updated DESC LIMIT ?")
        defer { sqlite3_finalize(statement) }
        bind(account: account, kind: kind, statement: statement)
        sqlite3_bind_int(statement, 3, Int32(limit))
        var values: [T] = []
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
            if let pointer = sqlite3_column_blob(statement, 0) {
                let data = Data(bytes: pointer, count: Int(sqlite3_column_bytes(statement, 0)))
                values.append(try JSONDecoder().decode(type, from: data))
            }
            result = sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw failure() }
        return values
    }

    public func remove(account: Int, kind: String, id: String) throws {
        let statement = try prepare("DELETE FROM records WHERE account=? AND kind=? AND id=?")
        defer { sqlite3_finalize(statement) }
        bind(account: account, kind: kind, statement: statement)
        sqlite3_bind_text(statement, 3, id, -1, transient)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
    }

    public func value<T: Decodable>(_ type: T.Type, account: Int, kind: String, id: String) throws -> T? {
        let statement = try prepare("SELECT value FROM records WHERE account=? AND kind=? AND id=?")
        defer { sqlite3_finalize(statement) }
        bind(account: account, kind: kind, statement: statement)
        sqlite3_bind_text(statement, 3, id, -1, transient)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW, let pointer = sqlite3_column_blob(statement, 0) else { throw failure() }
        return try JSONDecoder().decode(type, from: Data(bytes: pointer, count: Int(sqlite3_column_bytes(statement, 0))))
    }

    public func prune(account: Int, kind: String, keeping: Int) throws {
        let statement = try prepare("DELETE FROM records WHERE account=? AND kind=? AND id NOT IN (SELECT id FROM records WHERE account=? AND kind=? ORDER BY updated DESC LIMIT ?)")
        defer { sqlite3_finalize(statement) }
        bind(account: account, kind: kind, statement: statement)
        sqlite3_bind_int64(statement, 3, Int64(account)); sqlite3_bind_text(statement, 4, kind, -1, transient)
        sqlite3_bind_int(statement, 5, Int32(keeping))
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
    }

    public func reservePublication(account: Int, key: String, draftID: UUID) throws -> Bool {
        let statement = try prepare("INSERT OR IGNORE INTO records(account,kind,id,value,updated) VALUES(?,?,?,?,?)")
        defer { sqlite3_finalize(statement) }
        bind(account: account, kind: "publicationLock", statement: statement)
        sqlite3_bind_text(statement, 3, key, -1, transient)
        let data = try JSONEncoder().encode(draftID)
        _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, 4, $0.baseAddress, Int32($0.count), transient) }
        sqlite3_bind_double(statement, 5, Date().timeIntervalSince1970)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() }
        return sqlite3_changes(database) == 1
    }

    public func transaction(_ operation: () throws -> Void) throws {
        try openDatabase()
        let nested = sqlite3_get_autocommit(database) == 0
        let name = "capture_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        try execute(nested ? "SAVEPOINT \(name)" : "BEGIN IMMEDIATE")
        do { try operation(); try execute(nested ? "RELEASE SAVEPOINT \(name)" : "COMMIT") }
        catch {
            _ = sqlite3_exec(database, nested ? "ROLLBACK TO SAVEPOINT \(name)" : "ROLLBACK", nil, nil, nil)
            if nested { _ = sqlite3_exec(database, "RELEASE SAVEPOINT \(name)", nil, nil, nil) }
            throw error
        }
    }

    private func bind(account: Int, kind: String, statement: OpaquePointer) {
        sqlite3_bind_int64(statement, 1, Int64(account)); sqlite3_bind_text(statement, 2, kind, -1, transient)
    }
    private func failure() -> CaptureError { .message("Could not save local data. Your capture has not been discarded.") }
    private func prepare(_ sql: String) throws -> OpaquePointer {
        try openDatabase()
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure() }
        return statement
    }
    private func execute(_ sql: String) throws {
        try openDatabase()
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
    }
}
