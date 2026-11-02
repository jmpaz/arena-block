import Foundation

/// Retained system requests use either the original operation ID or an explicit
/// receipt suffix. Only this app's exact identifier shape can register a handler.
public struct CaptureContinuedTaskIdentity: Equatable, Sendable {
    public let operationID: UUID
    public let receiptID: UUID

    public init?(identifier: String, bundleIdentifier: String) {
        let prefix = bundleIdentifier + ".save."
        guard !bundleIdentifier.isEmpty, identifier.hasPrefix(prefix) else { return nil }
        let parts = identifier.dropFirst(prefix.count).split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), let operation = UUID(uuidString: String(parts[0])) else { return nil }
        let receipt: UUID
        if parts.count == 2 {
            guard let value = UUID(uuidString: String(parts[1])) else { return nil }
            receipt = value
        } else { receipt = operation }
        operationID = operation; receiptID = receipt
    }
}
