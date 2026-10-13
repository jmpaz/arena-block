import Foundation
import CaptureCore
import Security

struct CredentialStore {
    var accessGroup: String?
    private func query(_ key: String) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ArenaCapture", kSecAttrAccount as String: key]
        if let accessGroup, !accessGroup.isEmpty { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
    func read(_ key: String) throws -> String? {
        var q = query(key); q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw CaptureError.message("Unlock your device to access your account.")
        }
        return value
    }
    func write(_ value: String, key: String) throws {
        let fields: [String: Any] = [kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(key) as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query(key).merging(fields) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw CaptureError.message("Could not securely store your account.") }
        } else if status != errSecSuccess { throw CaptureError.message("Could not securely store your account.") }
    }
    func remove(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CaptureError.message("Could not disconnect your account.") }
    }
}
