import CryptoKit
import Foundation

/// The complete approved draft and recipe stay in the local delivery journal. The connection gets an explicit summary.
public struct CaptureConnectionProvenance: Codable, Equatable, Sendable {
    public var channelID: Int
    public var metadata: [String: JSONValue]
    public var snapshotJSON: String

    public init(draft: CaptureDraft, prepared: PreparedCapture, createdAt: Date = Date()) throws {
        guard let channelID = draft.provenanceChannelID, draft.selection.channels.contains(where: { $0.id == channelID }) else {
            throw CaptureError.message("Include the default channel to save capture details.")
        }
        struct Snapshot: Encodable { let draft: CaptureDraft; let prepared: PreparedCapture }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        var approved = draft; approved.provenanceSnapshotJSON = nil; approved.provenanceConnectionID = nil
        let bytes = try encoder.encode(Snapshot(draft: approved, prepared: prepared))
        guard bytes.count <= 2 * 1024 * 1024 else { throw CaptureError.message("Capture details exceed the 2 MiB limit. No block was created.") }
        snapshotJSON = String(decoding: bytes, as: UTF8.self)
        self.channelID = channelID
        metadata = [
            "ac_schema": .number(1), "ac_capture_id": .string(draft.id.uuidString),
            "ac_snapshot_sha256": .string(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()),
            "ac_snapshot_complete": .bool(false), "ac_origin": .string("ios"),
            "ac_event_kind": .string(draft.isPlacementOnly ? "placements" : "capture"),
            "ac_account_id": .number(Double(draft.accountID)), "ac_created_at": .string(ISO8601DateFormatter().string(from: createdAt)),
            "ac_default_channel_id": .number(Double(channelID)), "ac_default_mode": .string((draft.defaultChannelMode ?? .fallback).rawValue),
            "ac_requested_count": .number(Double(draft.requestedChannelIDs?.count ?? draft.selection.channels.count)),
            "ac_destination_count": .number(Double(draft.selection.channels.count))
        ]
    }

    /// Preserve the first event and unrelated metadata; repeated saves retain a distinct local event and latest summary.
    public func patch(current: [String: JSONValue]) throws -> [String: JSONValue] {
        func checked(_ patch: [String: JSONValue]) throws -> [String: JSONValue] {
            let merged = current.merging(patch) { _, new in new }
            guard merged.count <= 50, try JSONEncoder().encode(merged).count <= 32 * 1024 else {
                throw CaptureError.message("Capture details exceed the limit for this block. Review this save in History.")
            }
            return patch
        }
        let sameEvent = current["ac_capture_id"] == nil || current["ac_capture_id"] == metadata["ac_capture_id"]
        if sameEvent {
            for (key, value) in metadata where current[key] != nil && current[key] != value {
                throw CaptureError.message("Saved capture details differ from this capture. Review this save in History.")
            }
            return try checked(metadata)
        }
        let latest = Dictionary(uniqueKeysWithValues: metadata.map { ("ac_latest_" + $0.key.dropFirst(3), $0.value) })
        return try checked(latest)
    }
}
