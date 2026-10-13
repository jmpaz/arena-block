#if os(iOS)
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Accept both the URL representation used by Share/Copy Link and plain text.
/// Validation happens before anything enters the capture's source field.
struct SourcePasteControl: UIViewRepresentable {
    var receive: (String) -> Void

    func makeUIView(context: Context) -> PasteTarget {
        let target = PasteTarget()
        target.receive = receive
        target.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.url.identifier, UTType.plainText.identifier])
        let configuration = UIPasteControl.Configuration()
        configuration.displayMode = .iconOnly
        configuration.cornerStyle = .small
        configuration.baseBackgroundColor = .secondarySystemBackground
        configuration.baseForegroundColor = .secondaryLabel
        let control = UIPasteControl(configuration: configuration)
        control.target = target
        control.translatesAutoresizingMaskIntoConstraints = false
        target.control = control
        target.addSubview(control)
        NSLayoutConstraint.activate([
            control.leadingAnchor.constraint(equalTo: target.leadingAnchor),
            control.trailingAnchor.constraint(equalTo: target.trailingAnchor),
            control.topAnchor.constraint(equalTo: target.topAnchor),
            control.bottomAnchor.constraint(equalTo: target.bottomAnchor)
        ])
        control.accessibilityLabel = "Paste link"
        control.accessibilityIdentifier = "capture.paste"
        return target
    }

    func updateUIView(_ target: PasteTarget, context: Context) { target.receive = receive }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PasteTarget, context: Context) -> CGSize? {
        // Intrinsic size excludes the parent-imposed bounds that sizeThatFits
        // inherits from UIControl, and preserves the native secure button layout.
        let size = uiView.control!.intrinsicContentSize
        return CGSize(width: max(44, ceil(size.width)), height: max(44, ceil(size.height)))
    }

    final class PasteTarget: UIView {
        var control: UIPasteControl?
        var receive: ((String) -> Void)?

        override func paste(itemProviders: [NSItemProvider]) {
            Task { @MainActor in
                var values: [String] = []
                for provider in itemProviders {
                    let value: String? = await withCheckedContinuation { continuation in
                        if provider.canLoadObject(ofClass: NSURL.self) {
                            _ = provider.loadObject(ofClass: NSURL.self) { object, _ in
                                continuation.resume(returning: (object as? URL)?.absoluteString)
                            }
                        } else if provider.canLoadObject(ofClass: NSString.self) {
                            _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                                continuation.resume(returning: object as? String)
                            }
                        } else { continuation.resume(returning: nil) }
                    }
                    if let value { values.append(value) }
                }
                receive?(values.joined(separator: "\n"))
            }
        }
    }
}
#endif
