import Foundation

public actor ArenaAPI {
    private let token: String
    private let session: URLSession
    private var cache: [URL: (etag: String, body: Data)] = [:]
    private var retryAfter: Date?

    public init(token: String, session: URLSession = CaptureTransport.session) {
        self.token = token; self.session = session
    }

    public func me() async throws -> Account { try await get("me") }

    public func channel(_ identifier: String) async throws -> Channel {
        let safe = identifier.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return try await get("channels/\(safe)")
    }

    public func channels(accountID: Int, page: Int = 1) async throws -> Page<Channel> {
        try await get("users/\(accountID)/contents", query: ["type": "Channel", "sort": "updated_at_desc", "per": "30", "page": String(page)])
    }

    public func search(_ query: String, scope: SearchScope, page: Int = 1) async throws -> Page<Channel> {
        try await get("search", query: ["query": query.isEmpty ? "*" : query, "type": "Channel", "scope": scope.rawValue, "per": "30", "page": String(page)])
    }

    public func block(_ id: Int) async throws -> JSONValue { try await get("blocks/\(id)") }

    public func connections(_ blockID: Int, page: Int = 1) async throws -> Page<Channel> {
        try await get("blocks/\(blockID)/connections", query: ["per": "100", "page": String(page)])
    }

    public func create(_ payload: [String: JSONValue], channels: [Int]) async throws -> JSONValue {
        var body = payload
        body["channel_ids"] = .array(channels.map { .number(Double($0)) })
        return try await request("blocks", method: "POST", body: JSONEncoder().encode(body))
    }

    public func update(_ blockID: Int, fields: [String: JSONValue]) async throws -> JSONValue {
        try await request("blocks/\(blockID)", method: "PUT", body: JSONEncoder().encode(fields))
    }

    public func connect(_ blockID: Int, channels: [Int]) async throws {
        let body: [String: JSONValue] = ["connectable_id": .number(Double(blockID)), "connectable_type": .string("Block"), "channel_ids": .array(channels.map { .number(Double($0)) })]
        let _: JSONValue = try await request("connections", method: "POST", body: JSONEncoder().encode(body))
    }

    private func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await request(path, query: query)
    }

    private func request<T: Decodable>(_ path: String, query: [String: String] = [:], method: String = "GET", body: Data? = nil) async throws -> T {
        if let retryAfter, retryAfter > Date() { throw CaptureError.rateLimited(retryAfter) }
        var url = URLComponents(string: "https://api.are.na/v3/\(path)")!
        if !query.isEmpty { url.queryItems = query.sorted { $0.key < $1.key }.map { .init(name: $0.key, value: $0.value) } }
        let address = url.url!
        var request = URLRequest(url: address, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if method == "GET", let old = cache[address] { request.setValue(old.etag, forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CaptureError.message("Are.na returned an unreadable response.") }
        if http.statusCode == 304, let old = cache[address] { return try JSONDecoder().decode(T.self, from: old.body) }
        if http.statusCode == 429 {
            let date = http.value(forHTTPHeaderField: "X-RateLimit-Reset").flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
                ?? Date().addingTimeInterval(Double(http.value(forHTTPHeaderField: "Retry-After") ?? "60") ?? 60)
            retryAfter = max(date, Date().addingTimeInterval(1))
            throw CaptureError.rateLimited(retryAfter!)
        }
        guard (200..<300).contains(http.statusCode) else {
            let detail = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw CaptureError.http(http.statusCode, detail?["details"]?["message"]?.string ?? detail?["error"]?.string ?? "Are.na could not complete this request.")
        }
        if method == "GET", let etag = http.value(forHTTPHeaderField: "ETag") {
            if cache.count >= 128 { cache.removeAll() }
            cache[address] = (etag, data)
        } else if method != "GET" { cache.removeAll() }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
