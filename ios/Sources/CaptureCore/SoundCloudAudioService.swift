import CryptoKit
import Foundation

public struct SoundCloudAudioDownload: Sendable {
    public var url: URL
    public var sha256: String
    public var byteCount: Int
}

private final class SoundCloudServiceRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public struct SoundCloudAudioService: Sendable {
    private let endpoint: URL
    private let token: String
    private let session: URLSession

    public init(endpoint: URL, token: String, session: URLSession? = nil) throws {
        guard endpoint.scheme == "https", endpoint.host != nil, endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil, !token.isEmpty,
              !token.contains(where: { $0.isNewline }) else {
            throw CaptureError.message("Enter an HTTPS media service address and its access token in Settings.")
        }
        self.endpoint = endpoint
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        self.session = session ?? URLSession(configuration: configuration, delegate: SoundCloudServiceRedirects(), delegateQueue: nil)
    }

    public func render(plan: JSONValue) async throws -> SoundCloudAudioDownload {
        guard plan["block"]?["kind"]?.string == "audio", let planHash = plan["hash"]?.string,
              plan["sources"]?.array.count == 1,
              plan["sources"]?.array.first?["provider"]?.string == "soundcloud" else {
            throw CaptureError.message("Choose a SoundCloud track for MP3 capture.")
        }
        let version = try await request("v1/version")
        guard version["planCapabilities"]?.array.contains(.string("soundcloud-mp3-v1")) == true else {
            throw CaptureError.message("Update the media service to support SoundCloud MP3 capture.")
        }
        let response = try await request("v1/render", body: plan)
        guard response["plan"]?["hash"]?.string == planHash,
              let media = response["media"], media["extension"]?.string == "mp3", media["mimeType"]?.string == "audio/mpeg",
              let address = media["url"]?.string, let url = URL(string: address), url.scheme == "https",
              url.host != nil, url.user == nil, url.password == nil,
              let hash = media["hash"]?.string, hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }),
              url.lastPathComponent == "\(hash).mp3", let size = media["size"]?.int,
              size > 0, size <= 250 * 1024 * 1024 else {
            throw CaptureError.message("The media service returned an incomplete SoundCloud MP3.")
        }
        return .init(url: url, sha256: hash, byteCount: size)
    }

    public func verify(file: URL, download: SoundCloudAudioDownload) async throws {
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        var hash = SHA256(), size = 0
        while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
            try Task.checkCancellation()
            size += data.count
            guard size <= download.byteCount else { throw CaptureError.message("The SoundCloud MP3 size changed during download.") }
            hash.update(data: data)
        }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard size == download.byteCount, digest == download.sha256 else {
            throw CaptureError.message("The SoundCloud MP3 could not be verified. Retry this capture.")
        }
    }

    private func request(_ path: String, body: JSONValue? = nil) async throws -> JSONValue {
        let url = endpoint.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.timeoutInterval = body == nil ? 30 : 660
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, response.url == url, response.statusCode == 200 else {
            throw CaptureError.message("The SoundCloud media service could not complete the request. Check its address and access token in Settings.")
        }
        guard data.count <= 4 * 1024 * 1024 else { throw CaptureError.message("The media service response exceeded its size limit.") }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
