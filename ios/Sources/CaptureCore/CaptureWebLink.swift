import Foundation
import PDFKit

public enum CaptureWebLink {
    public static func sourceOverride(_ text: String?) throws -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 8192, let url = URL(string: value),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              url.user == nil, url.password == nil else { throw CaptureError.message("Enter a complete source URL without credentials.") }
        return url.absoluteString
    }

    public struct PDF: Sendable {
        public let fileURL: URL
        public let title: String?
        public let pageCount: Int
    }

    public static func readPDF(_ url: URL, directory: URL, session: URLSession = NativeMediaRenderer.mediaSession) async throws -> PDF? {
        var head = URLRequest(url: url); head.httpMethod = "HEAD"; head.timeoutInterval = 20
        let (_, response) = try await session.data(for: head)
        guard let http = response as? HTTPURLResponse else { throw CaptureError.message("The link returned no response.") }
        let isPDF = http.mimeType?.lowercased() == "application/pdf" || url.pathExtension.lowercased() == "pdf"
        guard isPDF else { return nil }
        guard (200..<300).contains(http.statusCode) || [405, 501].contains(http.statusCode) else {
            throw CaptureError.message("The PDF host returned HTTP \(http.statusCode). Open the PDF in its browser to check access.")
        }
        var request = URLRequest(url: url); request.timeoutInterval = 45
        request.setValue("application/pdf", forHTTPHeaderField: "Accept")
        let (bytes, reply) = try await session.bytes(for: request)
        guard let reply = reply as? HTTPURLResponse, (200..<300).contains(reply.statusCode) else {
            throw CaptureError.message("The PDF could not be downloaded. Check access in its browser.")
        }
        let maximum = 50 * 1024 * 1024
        guard reply.expectedContentLength <= maximum else { throw CaptureError.message("The PDF exceeds the 50 MB preview limit.") }
        var data = Data()
        for try await byte in bytes {
            if data.count % 65536 == 0 { try Task.checkCancellation() }
            guard data.count < maximum else { throw CaptureError.message("The PDF exceeds the 50 MB preview limit.") }
            data.append(byte)
        }
        try Task.checkCancellation()
        let details = try pdfDetails(data)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("pdf")
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return PDF(fileURL: file, title: details.title, pageCount: details.pageCount)
    }

    public static func pdfDetails(_ data: Data) throws -> (title: String?, pageCount: Int) {
        guard data.prefix(1024).range(of: Data("%PDF-".utf8)) != nil,
              let document = PDFDocument(data: data), !document.isLocked, document.pageCount > 0 else {
            throw CaptureError.message("This link did not return a readable PDF.")
        }
        let title = (document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (title?.isEmpty == false ? String(title!.prefix(512)) : nil, document.pageCount)
    }
}
