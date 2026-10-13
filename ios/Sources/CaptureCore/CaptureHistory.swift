import Foundation

public struct DeletedCapture: Codable, Identifiable, Sendable {
    public var id: UUID { draft.id }
    public let draft: CaptureDraft
    public let deletedAt: Date

    public init(draft: CaptureDraft, deletedAt: Date = Date()) {
        self.draft = draft; self.deletedAt = deletedAt
    }
}

extension CaptureDraft {
    public var hasDraftContent: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || titleOverride?.isEmpty == false || descriptionOverride?.isEmpty == false
            || previewSnapshot != nil || renderPath != nil || blockID != nil || !isUnsubmittedDraft
    }

    public var isUnsubmittedDraft: Bool {
        [.editing, .preparing, .ready, .failed].contains(phase)
    }

    public var hasUserEdits: Bool { titleOverride != nil || descriptionOverride != nil }

    public func automaticDraftExpired(at date: Date) -> Bool {
        isUnsubmittedDraft && !hasUserEdits && blockID == nil && deliveryState == nil
            && date.timeIntervalSince(updatedAt) >= 24 * 60 * 60
    }
}

extension CaptureStore {
    private struct DeliveryCompletion: Decodable { var stage: String }

    public func canDeleteDraft(_ draft: CaptureDraft) throws -> Bool {
        if draft.phase == .saved {
            let job = try value(DeliveryCompletion.self, account: 0, kind: "delivery", id: draft.id.uuidString)
            return job == nil || job?.stage == "done"
        }
        guard draft.isUnsubmittedDraft else { return false }
        return try !recordIDs(account: 0, kind: "delivery").contains(draft.id.uuidString)
    }

    /// Retention is reversible. No captured text or file is permanently purged.
    @discardableResult public func archiveExpiredAutomaticDrafts(account: Int, excluding: Set<UUID> = [], now: Date = Date()) throws -> [UUID] {
        var protected = excluding
        for workspace in try recordIDs(account: account, kind: "workspace").compactMap({ try value(CaptureWorkspace.self, account: account, kind: "workspace", id: $0) }) {
            if let id = workspace.activeDraftID { protected.insert(id) }
            if let id = workspace.retainedResultID { protected.insert(id) }
        }
        let ids = try recordIDs(account: account, kind: "draft").compactMap { try value(CaptureDraft.self, account: account, kind: "draft", id: $0) }
            .filter { !protected.contains($0.id) && $0.automaticDraftExpired(at: now) }
            .filter { (try? canDeleteDraft($0)) == true }.map(\.id)
        return try deleteDrafts(ids, account: account)
    }

    /// Keep a recoverable copy, and detach every composer reference atomically.
    @discardableResult public func deleteDrafts(_ ids: [UUID], account: Int) throws -> [UUID] {
        var removed: [UUID] = []
        try transaction {
            for id in ids {
                guard let draft = try value(CaptureDraft.self, account: account, kind: "draft", id: id.uuidString) else { continue }
                guard try canDeleteDraft(draft) else {
                    throw CaptureError.message("This capture has been submitted. Review its save in History.")
                }
                try save(DeletedCapture(draft: draft), account: account, kind: "deletedDraft", id: id.uuidString)
                try remove(account: account, kind: "draft", id: id.uuidString)
                removed.append(id)
            }
            let removedIDs = Set(removed)
            for id in try recordIDs(account: account, kind: "workspace") {
                guard var workspace = try value(CaptureWorkspace.self, account: account, kind: "workspace", id: id) else { continue }
                let active = workspace.activeDraftID, retained = workspace.retainedResultID
                if let active, removedIDs.contains(active) { workspace.activeDraftID = nil }
                if let retained, removedIDs.contains(retained) { workspace.retainedResultID = nil }
                if workspace.activeDraftID != active || workspace.retainedResultID != retained {
                    try save(workspace, account: account, kind: "workspace", id: id)
                }
            }
        }
        return removed
    }

    public func restoreDeletedDrafts(_ ids: [UUID], account: Int) throws {
        try transaction {
            for id in ids {
                guard let deleted = try value(DeletedCapture.self, account: account, kind: "deletedDraft", id: id.uuidString) else { continue }
                if try value(CaptureDraft.self, account: account, kind: "draft", id: id.uuidString) == nil {
                    var draft = deleted.draft
                    draft.recoverAfterInterruption()
                    draft.updatedAt = Date()
                    try save(draft, account: account, kind: "draft", id: id.uuidString)
                }
                try remove(account: account, kind: "deletedDraft", id: id.uuidString)
            }
        }
    }
}
