import CryptoKit
import Foundation

public struct CapturePDFInput: Codable, Equatable, Sendable {
    public static let maximumBytes = 50 * 1024 * 1024
    public let filePath: String
    public let filename: String
    public let sha256: String
    public let byteCount: Int
    public let title: String?
    public let pageCount: Int
    public let originalURL: String?

    public var incomingReference: String { "pdf-input:" + URL(fileURLWithPath: filePath).deletingPathExtension().lastPathComponent }

    public static func retain(_ source: URL, in container: URL, originalURL: String? = nil) throws -> CapturePDFInput {
        let original = try CaptureWebLink.sourceOverride(originalURL)
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let properties = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard source.isFileURL, properties.isRegularFile == true, properties.isSymbolicLink != true,
              let size = properties.fileSize, (1...maximumBytes).contains(size) else {
            throw CaptureError.message("Choose a PDF file up to 50 MB.")
        }
        let data = try Data(contentsOf: source, options: .mappedIfSafe)
        guard data.count == size else { throw CaptureError.message("The shared PDF changed while it was being read. Share it again.") }
        let details = try CaptureWebLink.pdfDetails(data)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        let directory = container.appendingPathComponent("originals").appendingPathComponent("pdfs")
        for path in [directory.deletingLastPathComponent(), directory] {
            try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
            guard try path.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else {
                throw CaptureError.message("The PDF storage location is invalid.")
            }
        }
        let file = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("pdf")
        try CaptureStorageCapacity.withSpace(container: container, additionalBytes: Int64(size)) {
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        return CapturePDFInput(filePath: file.path, filename: String(source.lastPathComponent.prefix(200)),
                               sha256: digest(data), byteCount: size, title: details.title, pageCount: details.pageCount, originalURL: original)
    }

    public func validatedFile(in container: URL) throws -> URL {
        let file = URL(fileURLWithPath: filePath).standardizedFileURL
        let root = container.appendingPathComponent("originals").appendingPathComponent("pdfs").standardizedFileURL
        guard file.deletingLastPathComponent() == root,
              root.resolvingSymlinksInPath().path.hasPrefix(container.resolvingSymlinksInPath().path + "/"),
              file.resolvingSymlinksInPath().deletingLastPathComponent() == root.resolvingSymlinksInPath(),
              UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil,
              try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]).isRegularFile == true,
              try file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true,
              try file.resourceValues(forKeys: [.fileSizeKey]).fileSize == byteCount,
              (1...Self.maximumBytes).contains(byteCount) else {
            throw CaptureError.message("The retained PDF is missing or changed. Import it again before saving.")
        }
        let data = try Data(contentsOf: file, options: .mappedIfSafe)
        guard data.count == byteCount, Self.digest(data) == sha256 else {
            throw CaptureError.message("The retained PDF changed. Import it again before saving.")
        }
        _ = try CaptureWebLink.pdfDetails(data)
        return file
    }

    public var planFile: JSONValue { .object(["sha256": .string(sha256), "byteCount": .number(Double(byteCount))]) }

    public func discardUnaccepted(in container: URL) {
        if let file = try? validatedFile(in: container) { try? FileManager.default.removeItem(at: file) }
    }

    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

#if os(iOS)
import UniformTypeIdentifiers

extension CapturePDFInput {
    public static func receive(from provider: NSItemProvider, in container: URL, originalURL: String? = nil) async throws -> CapturePDFInput {
        let input: CapturePDFInput = try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { url, error in
                do {
                    if let error { throw error }
                    guard let url else { throw CaptureError.message("The host did not provide a PDF file. Download it in Safari, then import the file.") }
                    continuation.resume(returning: try retain(url, in: container, originalURL: originalURL))
                } catch { continuation.resume(throwing: error) }
            }
        }
        do { try Task.checkCancellation(); return input }
        catch { input.discardUnaccepted(in: container); throw error }
    }
}
#endif
