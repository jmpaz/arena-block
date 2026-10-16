import CryptoKit
import Foundation
import JavaScriptCore
import OSLog

@MainActor
public final class CaptureRuntime {
    private let context: JSContext
    private var requests: [Int: URLSessionDataTask] = [:]
    private var timers: [Int: Timer] = [:]
    private var timerCallbacks: [Int: JSValue] = [:]
    private var nextTimer = 0
    private var continuations: [String: CheckedContinuation<String, Error>] = [:]
    private let session: URLSession
    private let sourceLog = Logger(subsystem: "net.fjpaz.arena-capture", category: "source")
    public private(set) var lastSourceDiagnostic: String?

    public init() throws {
        guard let context = JSContext(), let resource = Bundle.module.url(forResource: "capture-core", withExtension: "js") else {
            throw RuntimeError("The bundled capture core is unavailable")
        }
        self.context = context
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 45
        session = URLSession(configuration: configuration, delegate: CaptureRedirectDelegate(), delegateQueue: nil)
        let hash: @convention(block) (String) -> String = { value in
            SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        let http: @convention(block) (Int, String) -> Void = { [weak self] id, request in self?.request(id: id, json: request) }
        let cancel: @convention(block) (Int) -> Void = { [weak self] id in self?.requests.removeValue(forKey: id)?.cancel() }
        let diagnostic: @convention(block) (String) -> Void = { [weak self] value in
            guard value.utf8.count <= 1024 else { return }
            self?.lastSourceDiagnostic = value
            self?.sourceLog.error("Source read detail: \(value, privacy: .private)")
        }
        let complete: @convention(block) (String, JSValue, JSValue) -> Void = { [weak self] id, result, error in
            guard let continuation = self?.continuations.removeValue(forKey: id) else { return }
            if !error.isNull && !error.isUndefined { continuation.resume(throwing: RuntimeError(error.toString())) }
            else { continuation.resume(returning: result.toString()) }
        }
        let setTimer: @convention(block) (JSValue, Double) -> Int = { [weak self] callback, delay in
            guard let self else { return 0 }
            self.nextTimer += 1
            let id = self.nextTimer
            self.timerCallbacks[id] = callback
            self.timers[id] = Timer.scheduledTimer(withTimeInterval: max(0.001, delay / 1000), repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.timers.removeValue(forKey: id)
                    self?.timerCallbacks.removeValue(forKey: id)?.call(withArguments: [])
                }
            }
            return id
        }
        let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in
            self?.timers.removeValue(forKey: id)?.invalidate()
            self?.timerCallbacks.removeValue(forKey: id)
        }
        context.setObject(hash, forKeyedSubscript: "nativeSHA256" as NSString)
        context.setObject(http, forKeyedSubscript: "nativeHTTP" as NSString)
        context.setObject(cancel, forKeyedSubscript: "nativeCancelHTTP" as NSString)
        context.setObject(diagnostic, forKeyedSubscript: "nativeSourceDiagnostic" as NSString)
        context.setObject(complete, forKeyedSubscript: "nativeResolveComplete" as NSString)
        context.setObject(setTimer, forKeyedSubscript: "setTimeout" as NSString)
        context.setObject(clearTimer, forKeyedSubscript: "clearTimeout" as NSString)
        context.evaluateScript(try String(contentsOf: resource, encoding: .utf8))
        if let error = context.exception { throw RuntimeError(error.toString()) }
    }

    public func resolve(refs: [String], extraRefs: [String] = [], policyJSON: String = "{}", refresh: Bool = false, redditCapturesJSON: String = "[]", substackCapturesJSON: String = "[]") async throws -> String {
        lastSourceDiagnostic = nil
        let refsJSON = String(decoding: try JSONEncoder().encode(refs), as: UTF8.self)
        let arguments = [refsJSON, policyJSON, refresh ? "true" : "false",
                         String(decoding: try JSONEncoder().encode(extraRefs), as: UTF8.self), redditCapturesJSON, substackCapturesJSON]
        return try await invokeAsync("captureResolve", arguments: arguments)
    }

    public func resolveMediaURL(_ url: String) async throws -> String {
        try await invokeAsync("captureResolveMediaURL", arguments: [url])
    }

    public func mediaSources(_ url: String) async throws -> String {
        try await invokeAsync("captureMediaSources", arguments: [url])
    }

    private func invokeAsync(_ name: String, arguments: [String]) async throws -> String {
        let id = UUID().uuidString
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                continuations[id] = continuation
                do { _ = try invoke(name, [id] + arguments) }
                catch { continuations.removeValue(forKey: id)?.resume(throwing: error) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self else { return }
                _ = try? self.invoke("captureCancel", [id])
                self.continuations.removeValue(forKey: id)?.resume(throwing: CancellationError())
            }
        }
    }

    public func compose(postsJSON: String, policyJSON: String = "{}") throws -> String {
        try invoke("captureCompose", [postsJSON, policyJSON])
    }

    public func fields(planJSON: String) throws -> String { try invoke("captureFields", [planJSON]) }
    public func importRedditCapture(_ value: String) throws -> String {
        guard value.utf8.count <= 2 * 1024 * 1024 else { throw RuntimeError("Reddit capture exceeds 2 MiB") }
        return try invoke("captureRedditImport", [value])
    }
    public func importSubstackCapture(_ value: String) throws -> String {
        guard value.utf8.count <= 2 * 1024 * 1024 else { throw RuntimeError("Substack capture exceeds 2 MiB") }
        return try invoke("captureSubstackImport", [value])
    }
    public func source(_ value: String) throws -> String { try invoke("captureSource", [value]) }
    /// Convert an existing on-device authenticated Are.na read to a media source without transmitting its credential.
    public func arenaMediaPost(blockJSON: String, blockID: Int) throws -> String {
        try invoke("captureArenaMediaPost", [blockJSON, String(blockID)])
    }
    public func renderRecipe(planJSON: String, probesJSON: String = "{}") throws -> String {
        try invoke("captureRenderRecipe", [planJSON, probesJSON])
    }
    public func payload(planJSON: String, publicBase: String, mediaJSON: String = "null", channelsJSON: String = "[]") throws -> String {
        try invoke("capturePayload", [planJSON, publicBase, mediaJSON, channelsJSON])
    }

    public func copiedCover(blockJSON: String) throws -> String { try invoke("captureCopiedCover", [blockJSON]) }
    public func verify(planJSON: String, blockJSON: String) throws { _ = try invoke("captureVerify", [planJSON, blockJSON]) }
    public func edit(planJSON: String, editsJSON: String) throws -> String { try invoke("captureEdit", [planJSON, editsJSON]) }
    public func localPayload(planJSON: String, mediaURL: String = "", ingestURL: String = "", channelsJSON: String = "[]") throws -> String {
        try invoke("captureLocalPayload", [planJSON, mediaURL, ingestURL, channelsJSON])
    }

    private func invoke(_ name: String, _ arguments: [Any]) throws -> String {
        context.exception = nil
        guard let function = context.objectForKeyedSubscript(name), !function.isUndefined else { throw RuntimeError("Missing capture function: \(name)") }
        let result = function.call(withArguments: arguments)
        if let error = context.exception { throw RuntimeError(error.toString()) }
        return result?.toString() ?? "null"
    }

    private func request(id: Int, json: String) {
        do {
            let input = try JSONDecoder().decode(HTTPRequest.self, from: Data(json.utf8))
            guard let url = URL(string: input.url), url.scheme == "https", url.user == nil, url.password == nil else {
                throw RuntimeError("Provider requests must use HTTPS without credentials")
            }
            var request = URLRequest(url: url)
            request.httpMethod = input.method
            request.allHTTPHeaderFields = input.headers
            request.httpBody = input.body.map { Data($0.utf8) }
            let task = session.dataTask(with: request) { [weak self] data, response, error in
                let result: [String: Any]
                if let error { result = ["error": error.localizedDescription] }
                else if let response = response as? HTTPURLResponse {
                    result = ["status": response.statusCode, "url": response.url?.absoluteString ?? input.url,
                              "headers": response.allHeaderFields.reduce(into: [String: String]()) { value, field in value[String(describing: field.key)] = String(describing: field.value) },
                              "body": String(decoding: data ?? Data(), as: UTF8.self)]
                } else { result = ["error": "Provider returned no HTTP response"] }
                let encoded = (try? JSONSerialization.data(withJSONObject: result)).map { String(decoding: $0, as: UTF8.self) } ?? "{\"error\":\"Invalid provider response\"}"
                Task { @MainActor [weak self] in
                    guard let self, self.requests.removeValue(forKey: id) != nil else { return }
                    _ = try? self.invoke("captureHTTPComplete", [id, encoded])
                }
            }
            task.taskDescription = input.redirect
            requests[id] = task
            task.resume()
        } catch {
            let data = try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription])
            _ = try? invoke("captureHTTPComplete", [id, String(decoding: data ?? Data(), as: UTF8.self)])
        }
    }
}

private struct HTTPRequest: Decodable {
    let url: String
    let method: String
    let headers: [String: String]
    let body: String?
    let redirect: String
}

public struct RuntimeError: LocalizedError {
    public let errorDescription: String?
    public init(_ message: String) { errorDescription = message }
}

final class CaptureRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let refusesRedirect = task.taskDescription == "manual" || task.taskDescription == "error"
        guard !refusesRedirect, request.url?.scheme == "https", request.url?.user == nil, request.url?.password == nil else { completionHandler(nil); return }
        completionHandler(request)
    }
}
