import CaptureRuntime
import CryptoKit
import Foundation

public struct PendingShare: Codable {
    public var id: UUID
    public var urls: [String]
    public var redditCaptureJSON: String?
    public init(id: UUID, urls: [String], redditCaptureJSON: String? = nil) {
        self.id = id; self.urls = urls; self.redditCaptureJSON = redditCaptureJSON
    }
}

extension CaptureDraft {
    public func sourceReadIdentity(primary: [String], extra: [String]) -> String {
        let digest = SHA256.hash(data: Data((redditCapturesJSON ?? "[]").utf8))
            .map { String(format: "%02x", $0) }.joined()
        return "\(accountID):\(id):primary=\(primary.joined(separator: "|")):extra=\(extra.joined(separator: "|")):thread=\(threadExpansion?.rawValue ?? "auto"):reddit=\(digest)"
    }
}

extension CaptureRuntime {
    @MainActor public func resolve(draft: CaptureDraft, refs: [String], extraRefs: [String], policyJSON: String) async throws -> String {
        try await resolve(refs: refs, extraRefs: extraRefs, policyJSON: policyJSON,
                          redditCapturesJSON: draft.redditCapturesJSON ?? "[]")
    }
}

extension CaptureStore {
    /// Return replacement state only after the draft and workspace commit together.
    public func replaceBrowserSnapshot(in current: CaptureDraft, recordsJSON: String, workspaceID: String) throws -> CaptureDraft {
        var replacement = current
        replacement.redditCapturesJSON = recordsJSON
        replacement.problem = nil; replacement.originalLinkOnly = nil; replacement.phase = .editing
        replacement.previewSnapshot = nil; replacement.renderPath = nil; replacement.updatedAt = Date()
        try transaction {
            if try value(DeletedCapture.self, account: current.accountID, kind: "deletedDraft", id: current.id.uuidString) != nil {
                throw CaptureError.message("This draft was deleted. Start a new capture.")
            }
            if let stored = try value(CaptureDraft.self, account: current.accountID, kind: "draft", id: current.id.uuidString),
               [.queued, .creating, .checking, .uncertain, .saved].contains(stored.phase) {
                throw CaptureError.message("This capture has already been submitted. Start a new capture.")
            }
            try save(replacement, account: current.accountID, kind: "draft", id: current.id.uuidString)
            var workspace = try value(CaptureWorkspace.self, account: current.accountID, kind: "workspace", id: workspaceID) ?? CaptureWorkspace()
            workspace.activeDraftID = current.id; workspace.emptySelection = nil
            try save(workspace, account: current.accountID, kind: "workspace", id: workspaceID)
        }
        return replacement
    }

    public func commitNewCapture(_ draft: CaptureDraft, workspace: CaptureWorkspace, workspaceID: String,
                                 consumingIncoming: Bool) throws -> (draft: CaptureDraft, incoming: [String]?) {
        var next = draft
        var incoming: [String]?
        try transaction {
            if consumingIncoming {
                let pending = try values(PendingShare.self, account: 0, kind: "incoming")
                let matching = pending.filter { $0.urls.contains(next.input) }
                // Newest matching snapshot supersedes earlier intake for this URL.
                next.redditCapturesJSON = matching.first(where: { $0.redditCaptureJSON != nil })?.redditCaptureJSON.map { "[" + $0 + "]" }
                for item in matching {
                    let remaining = item.urls.filter { $0 != next.input }
                    if remaining.isEmpty { try remove(account: 0, kind: "incoming", id: item.id.uuidString) }
                    else { try save(PendingShare(id: item.id, urls: remaining), account: 0, kind: "incoming", id: item.id.uuidString) }
                }
                var seen = Set<String>()
                incoming = pending.flatMap(\.urls).filter { $0 != next.input && seen.insert($0).inserted }
            }
            if next.hasDraftContent { try save(next, account: next.accountID, kind: "draft", id: next.id.uuidString) }
            try save(workspace, account: next.accountID, kind: "workspace", id: workspaceID)
        }
        return (next, incoming)
    }
}
