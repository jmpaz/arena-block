import Foundation
import Darwin

/// Check available device space before allocating working media. Historical
/// records and protected files remain outside this admission calculation.
public enum CaptureStorageCapacity {
    public static let metadataReserve: Int64 = 1024 * 1024

    public static func availableBytes(at container: URL) throws -> Int64 {
        if let values = try? container.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let bytes = values.volumeAvailableCapacityForImportantUsage, bytes > 0 { return bytes }
        let attributes = try FileManager.default.attributesOfFileSystem(forPath: container.path)
        guard let bytes = attributes[.systemFreeSize] as? NSNumber else {
            throw CaptureError.message("Capture couldn’t check available device storage. Try again.")
        }
        return max(0, bytes.int64Value)
    }

    public static func requireSpace(container: URL, additionalBytes: Int64 = 0,
                                    minimumFreeBytes: Int64 = metadataReserve,
                                    availableCapacity: (URL) throws -> Int64 = availableBytes) throws {
        try withSpace(container: container, additionalBytes: additionalBytes, minimumFreeBytes: minimumFreeBytes,
                      availableCapacity: availableCapacity) { }
    }

    /// Hold the short cross-process lock through the final move. Moving a
    /// completed working file within this volume requires no second media copy.
    public static func withSpace<T>(container: URL, additionalBytes: Int64,
                                     minimumFreeBytes: Int64 = metadataReserve,
                                     availableCapacity: (URL) throws -> Int64 = availableBytes,
                                     _ operation: () throws -> T) throws -> T {
        let lock = container.appendingPathComponent(".media-capacity.lock")
        let fd = open(lock.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw CaptureError.message("Capture couldn’t check available device storage. Existing captures were kept.") }
        defer { flock(fd, LOCK_UN); close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw CaptureError.message("Another capture is finishing its media. Try again shortly.") }
        let available = try availableCapacity(container)
        guard additionalBytes >= 0, minimumFreeBytes >= 0, available >= minimumFreeBytes,
              additionalBytes <= available - minimumFreeBytes else {
            throw CaptureError.message("There isn’t enough device storage to prepare this media. Existing captures were kept. Free some device space and try again.")
        }
        return try operation()
    }
}
