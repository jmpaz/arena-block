import CaptureCore
import XCTest

final class DefaultRoutingTests: XCTestCase {
    private let owner = Owner(id: 41, name: "Fixture", slug: "fixture", type: "User")
    private func channel(_ id: Int = 71, visibility: String = "private", ownerID: Int = 41, canAdd: Bool = true) -> Channel {
        Channel(id: id, title: "Chosen default", slug: "chosen-\(id)", visibility: visibility,
                owner: Owner(id: ownerID, name: "Fixture", slug: "fixture", type: "User"), can: .init(addTo: canAdd))
    }

    func testProvenanceTargetMustBeOwnedPrivateWritableAndMatchTheChosenDefault() throws {
        XCTAssertEqual(try CaptureDefaultRoute.verifiedProvenanceChannel(channel(), accountID: owner.id, expectedChannelID: 71).id, 71)
        XCTAssertThrowsError(try CaptureDefaultRoute.verifiedProvenanceChannel(channel(visibility: "public"), accountID: owner.id, expectedChannelID: 71))
        XCTAssertThrowsError(try CaptureDefaultRoute.verifiedProvenanceChannel(channel(ownerID: 10), accountID: owner.id, expectedChannelID: 71))
        XCTAssertThrowsError(try CaptureDefaultRoute.verifiedProvenanceChannel(channel(canAdd: false), accountID: owner.id, expectedChannelID: 71))
        XCTAssertThrowsError(try CaptureDefaultRoute.verifiedProvenanceChannel(channel(), accountID: owner.id, expectedChannelID: 72))
    }

    func testExplicitSelectionAddsToFallbackAndAlwaysPolicyShowsOneActualDefault() throws {
        var selection = DestinationSelection(defaultChannel: channel())
        selection.toggle(channel(72))
        XCTAssertEqual(try CaptureDefaultRoute.destinations(selection, defaultChannel: channel(), mode: .fallback).map(\.id), [71, 72])
        XCTAssertEqual(try CaptureDefaultRoute.destinations(selection, defaultChannel: channel(), mode: .always).map(\.id), [71, 72])
        selection.toggle(channel())
        XCTAssertEqual(try CaptureDefaultRoute.destinations(selection, defaultChannel: channel(), mode: .always).map(\.id), [71, 72])
    }

    func testDefaultPolicyRespectsTwentyDestinationLimitAndIsNotAccountSpecific() throws {
        var selection = DestinationSelection(defaultChannel: nil)
        for id in 1...20 { selection.toggle(channel(id)) }
        XCTAssertThrowsError(try CaptureDefaultRoute.destinations(selection, defaultChannel: channel(), mode: .always))
        XCTAssertEqual(try CaptureDefaultRoute.destinations(selection, defaultChannel: nil, mode: .always).count, 20)
        XCTAssertEqual(try JSONDecoder().decode(DefaultChannelPolicy.self, from: JSONEncoder().encode(DefaultChannelPolicy(mode: .always))), .init(mode: .always))
    }

    func testReleaseSeedCanReplaceOnlyMatchingRetiredDefaultBeforeUserChoice() {
        func applies(accountID: Int = 41, target: Int? = 73, replacement: Int? = 71, current: Int?, configured: Bool = false) -> Bool {
            CaptureDefaultRoute.shouldApplyInitialDefault(accountID: accountID, configuredAccountID: 41,
                                                         targetChannelID: target, replacingChannelID: replacement,
                                                         currentDefaultID: current, alreadyConfigured: configured)
        }
        XCTAssertTrue(applies(current: nil))
        XCTAssertTrue(applies(current: 71))
        XCTAssertFalse(applies(current: 72))
        XCTAssertTrue(applies(current: 73))
        XCTAssertFalse(applies(accountID: 42, current: 71))
        XCTAssertFalse(applies(replacement: nil, current: 71))
        XCTAssertFalse(applies(target: nil, current: nil))
        XCTAssertFalse(applies(target: 0, current: 71))
        XCTAssertFalse(applies(current: nil, configured: true))
        XCTAssertFalse(applies(current: 71, configured: true))
        XCTAssertEqual(CaptureDefaultRoute.initialPolicy(stored: nil, initialMode: .always, configuredAccountID: 41).mode, .fallback)
        XCTAssertEqual(CaptureDefaultRoute.initialPolicy(stored: .init(mode: .always), initialMode: .fallback, configuredAccountID: 41).mode, .always)
        XCTAssertEqual(CaptureDefaultRoute.initialPolicy(stored: nil, initialMode: .always, configuredAccountID: nil).mode, .always)
    }

    func testProvenanceSummaryKeepsOriginalAndUnrelatedMetadataWhenSavingAgain() throws {
        var draft = CaptureDraft(accountID: owner.id, defaultChannel: channel(), input: "https://example.test/article?access_token=private")
        draft.requestedChannelIDs = []; draft.provenanceChannelID = 71; draft.defaultChannelMode = .always
        let prepared = PreparedCapture(payload: ["value": .string(draft.input)], update: [:])
        let first = try CaptureConnectionProvenance(draft: draft, prepared: prepared)
        XCTAssertEqual(first.metadata["ac_snapshot_complete"], .bool(false))
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(first.metadata), as: UTF8.self).contains("access_token"))
        XCTAssertTrue(first.snapshotJSON.contains("access_token=private"))
        var current = first.metadata; current["user_note"] = .string("Keep this note")
        draft.id = UUID()
        let second = try CaptureConnectionProvenance(draft: draft, prepared: prepared)
        let patch = try second.patch(current: current)
        XCTAssertNil(patch["ac_capture_id"])
        XCTAssertEqual(patch["ac_latest_capture_id"], .string(draft.id.uuidString))
        XCTAssertEqual(current["ac_capture_id"], first.metadata["ac_capture_id"])
        XCTAssertNil(patch["user_note"])
        current["ac_snapshot_sha256"] = .string("conflict")
        XCTAssertThrowsError(try first.patch(current: current))
    }
}
