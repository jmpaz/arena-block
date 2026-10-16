import Foundation

/// Keep diagnostic entry points separate from capture/session initialization.
public enum CaptureLaunchPolicy {
    public static func storageAuditOnly(environment: [String: String], forcedAuditBuild: Bool = false) -> Bool {
        forcedAuditBuild || environment["CAPTURE_STORAGE_AUDIT_ONLY"] == "1"
    }

    /// An exact app-local route: no paths, parameters, credentials or destination.
    public static func storageReportURL(_ url: URL, scheme: String) -> Bool {
        guard !scheme.isEmpty, let value = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return value.scheme?.lowercased() == scheme.lowercased() && value.host == "storage-report"
            && value.path.isEmpty && value.query == nil && value.fragment == nil
            && value.user == nil && value.password == nil && value.port == nil
    }
}

/// The app, foreground scene and background callbacks share this ownership gate.
/// A diagnostic request cannot erase ownership already admitted by a normal launch.
public struct CaptureStorageLaunchGate: Sendable {
    public enum Destination: Sendable, Equatable { case waiting, capture, report }
    public private(set) var destination: Destination = .waiting
    public private(set) var normalWorkAdmitted = false
    public var isolatedReport: Bool { destination == .report && !normalWorkAdmitted }
    public init() {}
    public mutating func connectScene(reportRequested: Bool) {
        if reportRequested { destination = .report }
        else if destination == .waiting { destination = .capture }
    }
    public mutating func requestReport() { destination = .report }
    public mutating func requestCapture() { destination = .capture }
    public mutating func admitNormalWork(background: Bool = false) -> Bool {
        guard !isolatedReport, destination == .capture || background || normalWorkAdmitted else { return false }
        normalWorkAdmitted = true
        if destination == .waiting { destination = .capture }
        return true
    }
}

/// Retain OS completions without claiming their URLSession events were drained.
@MainActor public final class CaptureStorageDeferredEvents {
    private var pending: [(String, () -> Void)] = []
    public var count: Int { pending.count }
    public init() {}
    public func append(_ identifier: String, completion: @escaping () -> Void) { pending.append((identifier, completion)) }
    public func drain(_ handler: (String, @escaping () -> Void) -> Void) {
        let events = pending; pending.removeAll()
        var order: [String] = [], groups: [String: [() -> Void]] = [:]
        for (identifier, completion) in events {
            if groups[identifier] == nil { order.append(identifier) }
            groups[identifier, default: []].append(completion)
        }
        for identifier in order {
            let callbacks = groups[identifier]!
            var completed = false
            handler(identifier) {
                guard !completed else { return }; completed = true
                callbacks.forEach { $0() }
            }
        }
    }
}
