import Foundation

/// Read the representations supplied by a share provider without interpreting
/// arbitrary page metadata or accepting local files as source links.
public enum CaptureShareInput {
    public enum BrowserResult: Equatable {
        case failure(String), capture(String), url(URL)
    }
    public enum SourceRepresentation: Equatable {
        case links([URL]), captureFile(URL)
    }
    public static let maximumBytes = 2 * 1024 * 1024

    public static func urls(in value: Any) -> [URL] {
        if let url = value as? URL {
            let scheme = url.scheme?.lowercased() ?? ""
            guard url.absoluteString.utf8.count <= maximumBytes,
                  ["http", "https"].contains(scheme) || (scheme == "at" && CaptureInput.isAtprotoPost(url)),
                  url.host?.isEmpty == false, url.user == nil, url.password == nil else { return [] }
            return [CaptureInput.canonicalSourceURL(url)]
        }
        let text: String
        if let string = value as? String { text = string }
        else if let attributed = value as? NSAttributedString { text = attributed.string }
        else if let data = value as? Data, data.count <= maximumBytes,
                let string = String(data: data, encoding: .utf8) { text = string }
        else { return [] }
        guard text.utf8.count <= maximumBytes,
              let links = CaptureInput.pasteableSourceText(text) else { return [] }
        return links.components(separatedBy: "\n").compactMap(URL.init(string:))
    }

    public static func propertyList(_ value: Any) -> [String: Any]? {
        if let dictionary = value as? [String: Any] { return dictionary }
        guard let data = value as? Data, data.count <= maximumBytes else { return nil }
        return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }

    public static func browserPageURL(_ result: [String: Any]) -> URL? {
        guard let value = result["sourceUrl"] else { return nil }
        let urls = urls(in: value)
        guard urls.count == 1, let url = urls.first,
              ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }

    public static func browserResult(_ result: [String: Any]) -> BrowserResult? {
        for key in ["substackError", "redditError"] where result[key] != nil {
            return .failure(result[key] as? String ?? "Couldn’t read the shared page.")
        }
        for key in ["substackCapture", "redditCapture"] where result[key] != nil {
            guard let json = result[key] as? String else { return .failure("Couldn’t read the shared page.") }
            return .capture(json)
        }
        if result["redditSourceUrl"] != nil {
            guard let source = result["redditSourceUrl"] as? String,
                  let url = URL(string: source), url.scheme == "https", url.user == nil, url.password == nil, url.port == nil,
                  ["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].contains(url.host ?? "") else {
                return .failure("Couldn’t identify the shared Reddit page.")
            }
            return .url(url)
        }
        return browserPageURL(result).map(BrowserResult.url)
    }

    @MainActor public static func sourceRepresentation(types: [String], load: (String) async throws -> Any?) async throws -> SourceRepresentation? {
        for type in types {
            try Task.checkCancellation()
            let value: Any?
            do { value = try await load(type) }
            catch is CancellationError { throw CancellationError() }
            catch { continue }
            try Task.checkCancellation()
            guard let value else { continue }
            if let url = value as? URL, url.isFileURL {
                if url.pathExtension.lowercased() == "json" { return .captureFile(url) }
                continue
            }
            let urls = urls(in: value)
            if !urls.isEmpty { return .links(urls) }
        }
        return nil
    }
}
