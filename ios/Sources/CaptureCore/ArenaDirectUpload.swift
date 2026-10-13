import Foundation

public struct ArenaUploadFile: Codable, Sendable {
    public var filename: String
    public var contentType: String
    public init(filename: String, contentType: String) {
        self.filename = filename
        self.contentType = contentType
    }
    enum CodingKeys: String, CodingKey { case filename; case contentType = "content_type" }
}

public struct ArenaPresignedUpload: Codable, Sendable {
    public var uploadURL: URL
    public var sourceURL: URL
    public var contentType: String
    public var expiresAt: Date
}

public enum ArenaDirectUpload {
    public static func prepare(files: [ArenaUploadFile], token: String, session: URLSession = CaptureTransport.session) async throws -> [ArenaPresignedUpload] {
        guard !files.isEmpty, files.count <= 50 else { throw CaptureError.message("Choose between one and fifty files to upload.") }
        struct Request: Encodable { var files: [ArenaUploadFile] }
        struct File: Decodable { var upload_url: URL; var key: String; var content_type: String }
        struct Response: Decodable { var files: [File]; var expires_in: Double }
        var request = URLRequest(url: URL(string: "https://api.are.na/v3/uploads/presign")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Request(files: files))
        let started = Date()
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CaptureError.message("Are.na returned an unreadable upload response.") }
        guard (200..<300).contains(http.statusCode) else { throw CaptureError.http(http.statusCode, "Are.na could not prepare this upload (HTTP \(http.statusCode)).") }
        let result = try JSONDecoder().decode(Response.self, from: data)
        guard result.files.count == files.count, result.expires_in > 0 else { throw CaptureError.message("Are.na returned incomplete upload instructions.") }
        return try zip(result.files, files).map { file, expected in
            guard file.upload_url.scheme == "https", file.upload_url.user == nil, file.upload_url.password == nil,
                  file.content_type == expected.contentType, !file.key.isEmpty,
                  !file.key.split(separator: "/").contains("..") else {
                throw CaptureError.message("Are.na returned invalid upload instructions.")
            }
            let source = URL(string: "https://s3.amazonaws.com/arena_images-temp/")!.appendingPathComponent(file.key)
            return ArenaPresignedUpload(uploadURL: file.upload_url, sourceURL: source, contentType: file.content_type, expiresAt: started.addingTimeInterval(result.expires_in))
        }
    }
}
