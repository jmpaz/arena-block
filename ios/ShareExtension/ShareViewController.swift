import CaptureCore
import CaptureUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

final class ShareViewController: UIViewController {
    private var session: CaptureSession?
    private var intake: Task<Void, Never>?
    private var invocation = UUID()
    private var contextID: ObjectIdentifier?

    override func viewDidLoad() {
        super.viewDidLoad()
        beginInvocationIfNeeded()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        beginInvocationIfNeeded()
    }

    private func beginInvocationIfNeeded() {
        guard let context = extensionContext else { return }
        let nextContextID = ObjectIdentifier(context)
        guard contextID != nextContextID else { return }
        finishIntake()
        session = nil
        contextID = nextContextID
        for child in children {
            child.willMove(toParent: nil); child.view.removeFromSuperview(); child.removeFromParent()
        }
        do {
            let session = try CaptureSession(freshShare: true); self.session = session
            let id = invocation, accountID = session.account?.id
            let view = CaptureRootView(session: session, isExtension: true) { [weak self, weak context] in
                guard let self, invocation == id else { return }
                finishIntake()
                context?.completeRequest(returningItems: nil)
            }
            embed(UIHostingController(rootView: view))
            intake = Task { [weak self] in
                guard let self else { return }
                await receiveInput(session, invocation: id, accountID: accountID)
                if !Task.isCancelled, invocation == id, self.session === session {
                    if session.account?.id != accountID { session.reportInputFailure("The account changed. Share this page again.") }
                    session.finishReceivingShareInput()
                }
            }
        } catch {
            embed(UIHostingController(rootView: ContentUnavailableView("Capture could not open", systemImage: "exclamationmark.triangle", description: Text(error.localizedDescription))))
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || parent?.isBeingDismissed == true || navigationController?.isBeingDismissed == true { finishIntake() }
    }

    deinit { intake?.cancel() }

    private func finishIntake() {
        invocation = UUID()
        intake?.cancel(); intake = nil
        session?.finishSharing()
    }

    private func isCurrent(_ id: UUID, session: CaptureSession, accountID: Int?) -> Bool {
        !Task.isCancelled && invocation == id && self.session === session && session.account?.id == accountID
            && contextID == extensionContext.map(ObjectIdentifier.init)
    }

    private func load(_ provider: NSItemProvider, type: String, session: CaptureSession, invocation: UUID, accountID: Int?) async throws -> NSSecureCoding? {
        let value = try await provider.loadItem(forTypeIdentifier: type)
        guard isCurrent(invocation, session: session, accountID: accountID) else { throw CancellationError() }
        return value
    }

    private func embed(_ controller: UIViewController) {
        addChild(controller); view.addSubview(controller.view)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: view.topAnchor), controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        controller.didMove(toParent: self)
    }

    private func receiveInput(_ session: CaptureSession, invocation: UUID, accountID: Int?) async {
        guard isCurrent(invocation, session: session, accountID: accountID) else { return }
        var urls: [URL] = []
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        // A typed page capture retains its provider-specific error and recovery path.
        for item in items {
            for provider in item.attachments ?? [] where provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
                let value: NSSecureCoding?
                do { value = try await load(provider, type: UTType.propertyList.identifier, session: session, invocation: invocation, accountID: accountID) }
                catch {
                    guard isCurrent(invocation, session: session, accountID: accountID) else { return }
                    continue
                }
                guard let value, let dictionary = CaptureShareInput.propertyList(value),
                      let result = dictionary[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any] else { continue }
                do {
                    guard let result = CaptureShareInput.browserResult(result) else { continue }
                    switch result {
                    case .failure(let message): session.reportInputFailure(message)
                    case .capture(let json): try session.receiveBrowserCapture(json)
                    case .url(let url): session.receive(urls: [url])
                    }
                    return
                } catch { session.reportInputFailure(error.localizedDescription); return }
            }
        }
        // Files are explicit captured records; unrelated JSON metadata must not mask a URL.
        for item in items {
            for provider in item.attachments ?? [] where provider.hasItemConformingToTypeIdentifier(UTType.json.identifier) {
                let value: NSSecureCoding?
                do { value = try await load(provider, type: UTType.json.identifier, session: session, invocation: invocation, accountID: accountID) }
                catch {
                    guard isCurrent(invocation, session: session, accountID: accountID) else { return }
                    continue
                }
                do {
                    if let url = value as? URL, url.isFileURL { try session.receiveBrowserCaptureFile(url); return }
                    let json = (value as? String) ?? (value as? Data).flatMap { $0.count <= CaptureShareInput.maximumBytes ? String(data: $0, encoding: .utf8) : nil }
                    if let json, let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
                       ["arena-block/reddit-browser-capture", "arena-block/substack-browser-capture"].contains(object["schema"] as? String ?? "") {
                        try session.receiveBrowserCapture(json); return
                    }
                } catch { session.reportInputFailure(error.localizedDescription); return }
            }
        }
        for item in items {
            let before = urls.count
            for provider in item.attachments ?? [] {
                let types = [UTType.url, .plainText, .utf8PlainText, .text]
                    .filter { provider.hasItemConformingToTypeIdentifier($0.identifier) }.map(\.identifier)
                do {
                    let source = try await CaptureShareInput.sourceRepresentation(types: types) { type in
                        try await self.load(provider, type: type, session: session, invocation: invocation, accountID: accountID)
                    }
                    switch source {
                    case .links(let received): urls += received
                    case .captureFile(let url):
                        guard url.pathExtension.lowercased() == "json" else { throw CaptureError.message("Couldn’t read the shared file. Share the page from Safari instead.") }
                        try session.receiveBrowserCaptureFile(url); return
                    case nil: break
                    }
                } catch {
                    guard isCurrent(invocation, session: session, accountID: accountID) else { return }
                    session.reportInputFailure(error.localizedDescription); return
                }
            }
            if before == urls.count, let text = item.attributedContentText { urls += CaptureShareInput.urls(in: text) }
        }
        guard isCurrent(invocation, session: session, accountID: accountID) else { return }
        var seen = Set<String>()
        urls = urls.filter { seen.insert(CaptureInput.canonicalSourceIdentity($0)).inserted }
        if urls.isEmpty { session.reportInputFailure("Couldn’t read the shared link. Share the page again.") }
        else { session.receive(urls: urls) }
    }
}
