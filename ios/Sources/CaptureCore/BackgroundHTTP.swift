import Foundation

public struct BackgroundHTTPResult: Codable, Sendable {
    public var status: Int?
    public var body: Data
    public var error: String?
    public var retryAfter: Date?
    public var errorCode: Int? = nil
    public var errorDomain: String? = nil
    public var json: JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: body) }
}

public final class BackgroundHTTP: NSObject, URLSessionDownloadDelegate, URLSessionDataDelegate, @unchecked Sendable {
    public let identifier: String
    private let directory: URL
    private let group: String?
    private let queue: OperationQueue
    private var responseBodies: [Int: Data] = [:]
    private var responseErrors: [Int: String] = [:]
    private var eventTasks: [Task<Void, Never>] = []
    private let callbackLock = NSLock()
    private var resultHandler: (@Sendable (String) async -> Void)?
    private var finishedHandler: (@Sendable () async -> Void)?
    private var invalidatedHandler: (@Sendable () async -> Void)?
    public var onResult: (@Sendable (String) async -> Void)? {
        get { callbackLock.withLock { resultHandler } }
        set { callbackLock.withLock { resultHandler = newValue } }
    }
    public var onFinishedEvents: (@Sendable () async -> Void)? {
        get { callbackLock.withLock { finishedHandler } }
        set { callbackLock.withLock { finishedHandler = newValue } }
    }
    public var onInvalidated: (@Sendable () async -> Void)? {
        get { callbackLock.withLock { invalidatedHandler } }
        set { callbackLock.withLock { invalidatedHandler = newValue } }
    }
    private lazy var session: URLSession = {
        #if os(iOS)
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sharedContainerIdentifier = group
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        #else
        let configuration = URLSessionConfiguration.ephemeral
        #endif
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }()

    public init(identifier: String, group: String?, directory: URL) throws {
        self.identifier = identifier; self.group = group; self.directory = directory
        queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        super.init()
    }

    public func connect() { _ = session }
    public func finish() { session.finishTasksAndInvalidate() }
    public func removeResult(_ id: String) {
        try? FileManager.default.removeItem(at: resultURL(id))
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(id).appendingPathExtension("request.json"))
    }
    public func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        if let onInvalidated { Task { await onInvalidated() } }
    }

    public func result(_ id: String) throws -> BackgroundHTTPResult? {
        let file = resultURL(id)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        do { return try JSONDecoder().decode(BackgroundHTTPResult.self, from: Data(contentsOf: file)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    public func tasks() async -> [URLSessionTask] { await session.allTasks }

    public func submit(id: String, request: URLRequest, file: URL?, notBefore: Date? = nil) -> URLSessionTask {
        let task: URLSessionTask
        if let file { task = session.uploadTask(with: request, fromFile: file) }
        else { task = session.downloadTask(with: request) }
        task.taskDescription = id
        task.earliestBeginDate = notBefore
        return task
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if (responseBodies[dataTask.taskIdentifier]?.count ?? 0) + data.count <= 16 * 1024 * 1024 {
            responseBodies[dataTask.taskIdentifier, default: Data()].append(data)
        } else {
            responseErrors[dataTask.taskIdentifier] = "The server response exceeded the supported size."
            dataTask.cancel()
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            guard let size = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 16 * 1024 * 1024 else {
                responseErrors[downloadTask.taskIdentifier] = "The server response exceeded the supported size."
                return
            }
            responseBodies[downloadTask.taskIdentifier] = try Data(contentsOf: location)
        } catch { responseErrors[downloadTask.taskIdentifier] = error.localizedDescription }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        let response = task.response as? HTTPURLResponse
        let retry = Self.retryDate(response)
        var result = BackgroundHTTPResult(status: response?.statusCode, body: responseBodies.removeValue(forKey: task.taskIdentifier) ?? Data(), error: responseErrors.removeValue(forKey: task.taskIdentifier) ?? error?.localizedDescription, retryAfter: retry)
        if let error = error as NSError? { result.errorCode = error.code; result.errorDomain = error.domain }
        do {
            let data = try JSONEncoder().encode(result)
            #if os(iOS)
            try data.write(to: resultURL(id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: resultURL(id), options: .atomic)
            #endif
            if let onResult { eventTasks.append(Task { await onResult(id) }) }
        } catch {
            if let onResult { eventTasks.append(Task { await onResult(id) }) }
        }
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let pending = eventTasks; eventTasks = []
        let finish = onFinishedEvents
        Task {
            for task in pending { await task.value }
            await finish?()
        }
    }

    private func resultURL(_ id: String) -> URL {
        directory.appendingPathComponent(id).appendingPathExtension("response.json")
    }

    /// Retry-After permits either delay seconds or an HTTP date. Preserve the
    /// server's deadline before recovery opens the persisted transfer result.
    static func retryDate(_ response: HTTPURLResponse?, now: Date = Date()) -> Date? {
        if let raw = response?.value(forHTTPHeaderField: "X-RateLimit-Reset"),
           let seconds = Double(raw), seconds.isFinite, seconds >= 0 {
            return Date(timeIntervalSince1970: seconds)
        }
        guard let raw = response?.value(forHTTPHeaderField: "Retry-After")?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        if let seconds = Double(raw), seconds.isFinite, seconds >= 0 { return now.addingTimeInterval(seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        formatter.calendar = calendar
        formatter.twoDigitStartDate = calendar.date(byAdding: .year, value: -50, to: now)
        formatter.isLenient = false
        let cutoff = calendar.date(byAdding: .year, value: 50, to: now)!
        for (index, format) in ["EEE, dd MMM yyyy HH:mm:ss 'GMT'", "EEEE, dd-MMM-yy HH:mm:ss 'GMT'", "EEE MMM d HH:mm:ss yyyy"].enumerated() {
            formatter.dateFormat = format
            guard let date = formatter.date(from: raw) else { continue }
            if index == 1 {
                // DateFormatter's two-digit window does not resolve the strict
                // seconds-level boundary. Only dates beyond 50 years roll back.
                if date > cutoff { return calendar.date(byAdding: .year, value: -100, to: date) }
                if let nextCentury = calendar.date(byAdding: .year, value: 100, to: date), nextCentury <= cutoff {
                    return nextCentury
                }
            }
            return date
        }
        return nil
    }
}
