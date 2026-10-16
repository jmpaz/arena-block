import Foundation
import Darwin

/// Admission control, never eviction. Retained capture data has a 300 MB budget
/// and inactive owned working copies a separate 10 MB ceiling. Existing work
/// above budget remains intact and can reuse its already prepared upload body.
public enum CaptureStorageCapacity {
    public static let persistentLimit: Int64 = 300_000_000

    public static func requireSpace(container: URL, additionalBytes: Int64 = 1,
                                    excluding: URL? = nil, limit: Int64 = persistentLimit) throws {
        try withSpace(container: container, additionalBytes: additionalBytes, excluding: excluding, limit: limit) { }
    }

    /// The short cross-process lock makes check-and-promotion atomic. It does
    /// not remain held while downloading, rendering, previewing or uploading.
    public static func withSpace<T>(container: URL, additionalBytes: Int64, excluding: URL? = nil,
                                     limit: Int64 = persistentLimit, _ operation: () throws -> T) throws -> T {
        let lock = container.appendingPathComponent(".media-capacity.lock")
        let fd = open(lock.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw CaptureError.message("Capture couldn’t check its stored media. Existing captures were kept.") }
        defer { flock(fd, LOCK_UN); close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw CaptureError.message("Another capture is finishing its media. Try again shortly.") }
        let bytes = try retainedBytes(container: container, excluding: excluding)
        guard additionalBytes >= 0, limit >= 0, bytes <= limit, additionalBytes <= limit - bytes else {
            throw CaptureError.message("Capture needs room within its 300 MB retained-media budget. Existing captures were kept. Finish or review pending captures, then retry this capture.")
        }
        return try operation()
    }

    private static func retainedBytes(container: URL, excluding: URL?) throws -> Int64 {
        var failed = false
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(at: container, includingPropertiesForKeys: Array(keys), errorHandler: { _, _ in failed = true; return true }) else {
            throw CaptureError.message("Capture couldn’t check its stored media. Existing captures were kept.")
        }
        var total: Int64 = 0
        for case let file as URL in walker {
            // Owned working copies cannot be referenced by a save journal and
            // are released when their producer finishes. Counting another live
            // producer here would reject ordinary large captures permanently.
            if let excluding, file.standardizedFileURL == excluding.standardizedFileURL { walker.skipDescendants(); continue }
            if NativeMediaWorkspace.isOwnedDirectory(file, container: container) { walker.skipDescendants(); continue }
            let values = try file.resourceValues(forKeys: keys)
            guard values.isSymbolicLink != true else { failed = true; walker.skipDescendants(); continue }
            if values.isRegularFile == true {
                guard let size = values.fileSize, size >= 0 else { failed = true; continue }
                let (sum, overflow) = total.addingReportingOverflow(Int64(size))
                guard !overflow else { failed = true; continue }; total = sum
            }
        }
        guard !failed else { throw CaptureError.message("Capture couldn’t fully check its stored media. Existing captures were kept.") }
        return total
    }
}
