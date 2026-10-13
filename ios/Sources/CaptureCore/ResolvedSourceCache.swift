import Foundation

/// A bounded, memory-only source snapshot. Presentation changes share a running
/// read; changing source identity cancels it. Expiring URLs are never persisted.
@MainActor public final class ResolvedSourceCache {
    private var identity: String?
    private var snapshot: String?
    private var expiresAt = Date.distantPast
    private var pending: Task<String, Error>?
    private var revision = UUID()
    public init() {}

    public func invalidate() {
        pending?.cancel(); pending = nil
        identity = nil; snapshot = nil; expiresAt = .distantPast
        revision = UUID()
    }

    /// A provider may replace an entered short URL with its verified canonical
    /// URL after the read. Keep that exact snapshot for media toggles.
    public func rekey(from old: String, to new: String) {
        guard identity == old, snapshot != nil, pending == nil else { return }
        identity = new
    }

    public func value(identity key: String, now: Date = Date(), lifetime: TimeInterval = 300,
                      load: @escaping @MainActor () async throws -> String) async throws -> String {
        if identity != key || (snapshot != nil && now >= expiresAt) {
            invalidate(); identity = key
        }
        if let snapshot { return snapshot }
        if pending == nil { pending = Task { try await load() } }
        let ticket = revision
        let task = pending!
        do {
            let value = try await task.value
            // A provider that ignores cancellation must not replace a newer source.
            guard revision == ticket, identity == key else { throw CancellationError() }
            if snapshot == nil { snapshot = value; expiresAt = now.addingTimeInterval(lifetime) }
            pending = nil
            return value
        } catch {
            if revision == ticket { pending = nil }
            throw error
        }
    }
}
