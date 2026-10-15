import Foundation
import WebKit

/// Reads an ordinary public Reddit page in its own ephemeral browser session.
/// The reader returns source records only. Browser profiles, cookies and credentials are never exported.
@MainActor public final class RedditPublicPageAcquirer: NSObject, WKNavigationDelegate {
    private let readerScript: String
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<String, Error>?
    private var deadline: Task<Void, Never>?
    private var poll: Task<Void, Never>?
    private var source = ""
    private var mainNavigations = 0
    private var reading = false
    private var generation = UUID()
    public init(readerScript: String) { self.readerScript = readerScript }

    public func acquire(url: String) async throws -> String {
        guard continuation == nil else { throw RedditPublicPageReadError("A Reddit public read is already running") }
        guard let address = URL(string: url), Self.allowed(address), url.utf8.count <= 2048 else { throw RedditPublicPageReadError("Expected an HTTPS Reddit public source") }
        try Task.checkCancellation()
        source = url; mainNavigations = 0; reading = false
        let generation = UUID(); self.generation = generation
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { next in
                continuation = next
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                config.defaultWebpagePreferences.allowsContentJavaScript = true
                config.mediaTypesRequiringUserActionForPlayback = .all
                let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1280, height: 900), configuration: config)
                view.navigationDelegate = self
                webView = view
                deadline = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
                    guard self?.generation == generation else { return }
                    self?.finish(.failure(RedditPublicPageReadError("Reddit public page did not become complete within 30 seconds")))
                }
                view.load(URLRequest(url: address))
            }
        }, onCancel: { [weak self] in Task { @MainActor in
            guard self?.generation == generation else { return }
            self?.finish(.failure(CancellationError()))
        } })
    }
    private static func allowed(_ url: URL) -> Bool {
        url.scheme == "https" && url.user == nil && url.password == nil && url.port == nil &&
        ["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].contains(url.host ?? "")
    }
    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === self.webView else { decisionHandler(.cancel); return }
        guard let frame = action.targetFrame else { decisionHandler(.cancel); return }
        guard let url = action.request.url, Self.allowed(url) else {
            decisionHandler(.cancel)
            if frame.isMainFrame { finish(.failure(RedditPublicPageReadError("Reddit public page navigated outside Reddit"))) }
            return
        }
        if frame.isMainFrame {
            mainNavigations += 1
            guard mainNavigations <= 6 else { decisionHandler(.cancel); finish(.failure(RedditPublicPageReadError("Reddit public page exceeded its navigation bound"))); return }
        }
        decisionHandler(.allow)
    }
    public func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard webView === self.webView else { decisionHandler(.cancel); return }
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse,
           !(200...299).contains(http.statusCode) {
            decisionHandler(.cancel); finish(.failure(RedditPublicPageReadError("Reddit public page returned HTTP \(http.statusCode); no access workaround was attempted"))); return
        }
        decisionHandler(.allow)
    }
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { if webView === self.webView { read() } }
    private func read() {
        guard continuation != nil, !reading, let view = webView else { return }
        reading = true
        let generation = self.generation
        view.callAsyncJavaScript(readerScript + "\nreturn JSON.stringify(await globalThis.arenaAcquireRedditPublicPage(expected));", arguments: ["expected": source], in: nil, in: .page) { [weak self] result in
            Task { @MainActor in
                guard let self, self.generation == generation, self.continuation != nil else { return }
                self.reading = false
                do {
                    let value = try result.get()
                    guard let text = value as? String, text.utf8.count <= 2 * 1024 * 1024,
                          let reply = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw RedditPublicPageReadError("Reddit public reader exceeded its bound or returned no record") }
                    if reply["ok"] as? Bool == true, let capture = reply["capture"] as? [String: Any] {
                        let bytes = try JSONSerialization.data(withJSONObject: capture, options: [.sortedKeys])
                        guard bytes.count <= 2 * 1024 * 1024 else { throw RedditPublicPageReadError("Reddit public record exceeds 2 MiB") }
                        self.finish(.success(String(decoding: bytes, as: UTF8.self)))
                    } else if reply["pending"] as? Bool == true {
                        self.poll?.cancel()
                        self.poll = Task { [weak self] in
                            do { try await Task.sleep(nanoseconds: 300_000_000) } catch { return }
                            self?.read()
                        }
                    } else { throw RedditPublicPageReadError(reply["error"] as? String ?? "Reddit public source is unavailable") }
                } catch {
                    let info = (error as NSError).userInfo
                    self.finish(.failure(RedditPublicPageReadError(info["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription)))
                }
            }
        }
    }
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if webView === self.webView { finish(.failure(error)) } }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if webView === self.webView { finish(.failure(error)) } }
    private func finish(_ result: Result<String, Error>) {
        guard let next = continuation else { return }
        continuation = nil
        deadline?.cancel(); poll?.cancel(); deadline = nil; poll = nil
        webView?.navigationDelegate = nil; webView?.stopLoading(); webView = nil
        next.resume(with: result)
    }
}

public struct RedditPublicPageReadError: LocalizedError {
    public let errorDescription: String?
    public init(_ message: String) { errorDescription = message }
}
