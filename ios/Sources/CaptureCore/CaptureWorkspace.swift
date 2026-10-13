import Foundation

public struct CaptureWorkspaceContents: Sendable {
    public let draft: CaptureDraft
    public let retainedResult: CaptureDraft?
}

extension CaptureStore {
    /// Claim a composer before returning its draft. Only a main app's first
    /// initialization may adopt an unowned draft from the legacy shared store.
    public func openWorkspace(account: Int, id: String, defaultChannel: Channel?, migrateLegacy: Bool) throws -> CaptureWorkspaceContents {
        var active = CaptureDraft(accountID: account, defaultChannel: defaultChannel)
        var retained: CaptureDraft?
        try transaction {
            let existing = try value(CaptureWorkspace.self, account: account, kind: "workspace", id: id)
            var workspace = existing ?? CaptureWorkspace()
            if let selected = workspace.activeDraftID,
               let saved = try value(CaptureDraft.self, account: account, kind: "draft", id: selected.uuidString) {
                active = saved
            } else {
                if existing == nil && migrateLegacy {
                    var owned = Set<UUID>()
                    for ownerID in try recordIDs(account: account, kind: "workspace") {
                        if let owner = try value(CaptureWorkspace.self, account: account, kind: "workspace", id: ownerID) {
                            if let selected = owner.activeDraftID { owned.insert(selected) }
                            if let previous = owner.retainedResultID { owned.insert(previous) }
                        }
                    }
                    if let legacy = try values(CaptureDraft.self, account: account, kind: "draft").first(where: {
                        !owned.contains($0.id) && $0.phase != .saved && !$0.input.isEmpty
                    }) { active = legacy }
                }
                if active.hasDraftContent {
                    try save(active, account: account, kind: "draft", id: active.id.uuidString)
                    workspace.activeDraftID = active.id
                } else {
                    if let selection = workspace.emptySelection { active.selection = selection }
                    workspace.activeDraftID = nil
                }
                try save(workspace, account: account, kind: "workspace", id: id)
            }
            if let previous = workspace.retainedResultID {
                retained = try value(CaptureDraft.self, account: account, kind: "draft", id: previous.uuidString)
            }
        }
        return CaptureWorkspaceContents(draft: active, retainedResult: retained)
    }
}
