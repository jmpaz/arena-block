import CaptureCore
import CaptureUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

final class ShareViewController: UIViewController {
    private var session: CaptureSession?
    override func viewDidLoad() {
        super.viewDidLoad()
        do {
            let session = try CaptureSession(); self.session = session
            let view = CaptureRootView(session: session, isExtension: true) { [weak self] in
                session.finishSharing()
                self?.extensionContext?.completeRequest(returningItems: nil)
            }
            embed(UIHostingController(rootView: view))
            Task { await receiveInput(session) }
        } catch {
            embed(UIHostingController(rootView: ContentUnavailableView("Capture could not open", systemImage: "exclamationmark.triangle", description: Text(error.localizedDescription))))
        }
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

    private func receiveInput(_ session: CaptureSession) async {
        var urls: [URL] = []
        var unreadable = false
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        for item in items {
            let before = urls.count
            for provider in item.attachments ?? [] {
                do {
                    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                        let value = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
                        if let url = value as? URL { urls.append(url) }
                        else if let text = value as? String { urls += CaptureInput.urls(in: text) }
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                        let value = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
                        if let text = value as? String { urls += CaptureInput.urls(in: text) }
                    }
                } catch { unreadable = true }
            }
            if before == urls.count, let text = item.attributedContentText?.string { urls += CaptureInput.urls(in: text) }
        }
        if urls.isEmpty { session.reportInputFailure() }
        else {
            session.receive(urls: urls)
            if unreadable { session.reportInputFailure("Some shared items could not be read. Paste any missing links.") }
        }
    }
}
