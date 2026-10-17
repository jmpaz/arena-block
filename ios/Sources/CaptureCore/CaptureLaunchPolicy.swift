import Foundation

/// Keep diagnostic entry points separate from capture/session initialization.
public enum CaptureLaunchPolicy {
    public static func storageAuditOnly(environment: [String: String], forcedAuditBuild: Bool = false) -> Bool {
        forcedAuditBuild || environment["CAPTURE_STORAGE_AUDIT_ONLY"] == "1"
    }
}
