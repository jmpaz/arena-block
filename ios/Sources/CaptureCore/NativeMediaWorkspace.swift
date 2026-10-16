import Foundation
import Darwin

/// Private working copies, never capture originals or a durable upload body.
/// A file lock spans the entire producer/preview lifetime, including app/Share
/// processes. Only this new, explicitly marked namespace has automatic expiry.
public final class NativeMediaWorkspace {
    public static let directoryName = "temporary-media-v1"
    private struct Marker: Codable {
        var version = 1
        var purpose: String
        var createdAt: Date
    }
    public let directory: URL
    private var descriptor: Int32 = -1
    private var discarded = false

    public init(container: URL, purpose: String, now: Date = Date()) throws {
        guard ["render-inputs", "composition-preview"].contains(purpose) else {
            throw CaptureError.message("The temporary media purpose is invalid.")
        }
        let root = container.appendingPathComponent(Self.directoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Self.rejectSymbolicLink(root)
        Self.prune(container: container, now: now)
        directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let fd = open(directory.appendingPathComponent(".lease").path, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { try? FileManager.default.removeItem(at: directory); throw CaptureError.message("Couldn’t prepare temporary media.") }
        descriptor = fd
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); descriptor = -1; throw CaptureError.message("Temporary media is already in use.") }
        do {
            try JSONEncoder().encode(Marker(purpose: purpose, createdAt: now))
                .write(to: directory.appendingPathComponent(".owner.json"), options: .atomic)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
            #endif
        } catch { discard(); throw error }
    }

    deinit { discard() }

    public func discard() {
        guard !discarded else { return }
        discarded = true
        // Keep the lease held until our private directory has gone.
        try? FileManager.default.removeItem(at: directory)
        if descriptor >= 0 { flock(descriptor, LOCK_UN); close(descriptor); descriptor = -1 }
    }

    /// Move only the finished output to durable storage before a journal can
    /// refer to it. Working inputs remain owned by this workspace.
    public func promote(_ media: NativeRenderedMedia, to destination: URL) throws -> NativeRenderedMedia {
        guard !discarded, Self.isInside(media.fileURL, directory),
              !Self.isTemporaryPath(destination),
              (try media.fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])).isRegularFile == true else {
            throw CaptureError.message("The prepared media is not ready to retain.")
        }
        try Self.rejectSymbolicLink(media.fileURL)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let file = destination.appendingPathComponent(media.fileURL.lastPathComponent)
        try FileManager.default.moveItem(at: media.fileURL, to: file)
        return .init(fileURL: file, contentType: media.contentType, byteCount: media.byteCount)
    }

    public static func isTemporaryPath(_ file: URL) -> Bool {
        file.standardizedFileURL.pathComponents.contains(directoryName)
    }

    private static func isInside(_ file: URL, _ root: URL) -> Bool {
        file.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/")
    }

    private static func rejectSymbolicLink(_ url: URL) throws {
        guard try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else {
            throw CaptureError.message("The temporary media location is invalid.")
        }
    }

    /// Inactive, marked working copies expire after 24 hours or oldest-first
    /// above 250 MiB. Active leases, unknown entries and legacy folders are
    /// always preserved. This does not sweep renders, originals or history.
    @discardableResult public static func prune(container: URL, now: Date = Date(), maximumAge: TimeInterval = 24 * 60 * 60,
                                                maximumBytes: Int64 = 250 * 1024 * 1024) -> Int64 {
        let root = container.appendingPathComponent(directoryName, isDirectory: true)
        guard (try? root.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false,
              let directories = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return 0 }
        struct Candidate { let url: URL; let fd: Int32; let createdAt: Date; let bytes: Int64 }
        var candidates: [Candidate] = []
        defer { for entry in candidates { flock(entry.fd, LOCK_UN); close(entry.fd) } }
        for url in directories {
            guard UUID(uuidString: url.lastPathComponent) != nil,
                  let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink == false,
                  let data = try? Data(contentsOf: url.appendingPathComponent(".owner.json")),
                  let marker = try? JSONDecoder().decode(Marker.self, from: data),
                  marker.version == 1, ["render-inputs", "composition-preview"].contains(marker.purpose), marker.createdAt <= now else { continue }
            let fd = open(url.appendingPathComponent(".lease").path, O_RDWR | O_NOFOLLOW)
            guard fd >= 0 else { continue }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); continue }
            // Producers use flat directories. Unexpected directories or links
            // invalidate automatic removal, even when a marker is present.
            guard let files = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                  files.allSatisfy({ file in
                      guard let value = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return false }
                      return value.isRegularFile == true && value.isSymbolicLink == false
                  }) else { flock(fd, LOCK_UN); close(fd); continue }
            let bytes = files.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
            candidates.append(.init(url: url, fd: fd, createdAt: marker.createdAt, bytes: bytes))
        }
        var total = candidates.reduce(Int64(0)) { $0 + $1.bytes }, removed: Int64 = 0
        for entry in candidates.sorted(by: { $0.createdAt < $1.createdAt }) {
            guard now.timeIntervalSince(entry.createdAt) >= max(0, maximumAge) || total > max(0, maximumBytes) else { continue }
            do { try FileManager.default.removeItem(at: entry.url); total -= entry.bytes; removed += entry.bytes } catch { }
        }
        return removed
    }
}

/// The preview owns its working files until the view releases it. Cancellation
/// between producing the URL and displaying it therefore cannot leak a file.
public final class NativeMediaPreview {
    public let fileURL: URL
    private let workspace: NativeMediaWorkspace
    public init(fileURL: URL, workspace: NativeMediaWorkspace) { self.fileURL = fileURL; self.workspace = workspace }
    public func discard() { workspace.discard() }
}
