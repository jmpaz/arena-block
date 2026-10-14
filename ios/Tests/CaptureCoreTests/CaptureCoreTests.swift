import XCTest
@testable import CaptureCore

final class CaptureCoreTests: XCTestCase {
    func channel(_ id: Int) -> Channel {
        Channel(id: id, title: "Channel \(id)", slug: "channel-\(id)", visibility: "private", owner: Owner(id: 1, name: "Owner", slug: "owner", type: "User"))
    }

    func testRetainedBrowseShowsAllOwnedChannelsAfterRecents() {
        let retained = (1...30).map(channel)
        XCTAssertEqual(ChannelSearch.retainedBrowse(retained, accountID: 1, excluding: [channel(3), channel(1)]).map(\.id),
                       [2] + Array(4...30))
        XCTAssertTrue(ChannelSearch.retainedBrowse(retained, accountID: nil, excluding: []).isEmpty)
        XCTAssertTrue(ChannelSearch.retainedBrowse(retained, accountID: 2, excluding: []).isEmpty)
        XCTAssertEqual(ChannelSearch.retainedBrowse([channel(1), channel(1)], accountID: 1, excluding: []).map(\.id), [1])
    }

    func testAnotherChannelAddsToTheInboxDefault() {
        var selection = DestinationSelection(defaultChannel: channel(1))
        selection.toggle(channel(2))
        XCTAssertEqual(selection.channels.map(\.id), [1, 2])
        selection.toggle(channel(3))
        selection.toggle(channel(1))
        XCTAssertEqual(selection.channels.map(\.id), [2, 3])
        selection.toggle(channel(2)); selection.toggle(channel(3))
        XCTAssertTrue(selection.channels.isEmpty)
        XCTAssertFalse(selection.implicitDefault)
    }

    func testOrderedSourcePostsRemainDistinctAndBounded() throws {
        let x = "https://x.com/fixture/status/123"
        let soundcloud = "https://soundcloud.com/fixture/track"
        XCTAssertEqual(try CaptureInput.postURLs("\(x)\n\n\(soundcloud)").map(\.absoluteString), [x, soundcloud])
        XCTAssertEqual(try CaptureInput.postURLs("\(x)\n\(x)").map(\.absoluteString), [x])
        XCTAssertThrowsError(try CaptureInput.postURLs(Array(repeating: x, count: 21).joined(separator: "\n")))
        XCTAssertThrowsError(try CaptureInput.postURLs("\(x)\nfile:///private/secret"))
    }

    func testPostVariantsCannotDuplicateOneCanonicalSource() throws {
        let x = "https://x.com/fixture/status/123"
        XCTAssertEqual(try CaptureInput.postURLs("\(x)?s=20\nhttps://twitter.com/another/status/123").count, 1)
        XCTAssertEqual(try CaptureInput.postURLs("https://bsky.app/profile/example.test/post/abc?ref=share\nat://example.test/app.bsky.feed.post/abc").count, 1)
        XCTAssertEqual(try CaptureInput.postURLs("\(x)?s=20\nhttps://x.com/fixture/status/124").count, 2)
        let links = ["99999999999999999003", "99999999999999999003", "99999999999999999004", "99999999999999999005"]
            .enumerated().map { index, id in "https://x.com/example_writer/status/\(id)\(index == 1 ? "?s=20" : "")" }
        XCTAssertEqual(try CaptureInput.postURLs(links.joined(separator: "\n")).map(\.path), [
            "/example_writer/status/99999999999999999003",
            "/example_writer/status/99999999999999999004",
            "/example_writer/status/99999999999999999005"
        ])
        XCTAssertTrue(CaptureInput.isBlueskyPost(URL(string: "https://bsky.app/profile/example.test/post/abc")!))
    }

    func testSourceRolesKeepPrimaryPrecedenceAndSourceOrder() throws {
        let first = "https://x.com/example/status/101"
        let second = "https://x.com/example/status/102"
        let third = "https://x.com/example/status/103"
        let selection = try CaptureInput.selectedPosts("\(first)\n\(second)\nhttps://twitter.com/alias/status/101?s=20\n\(third)",
            roles: [.extra, .primary, .primary, .extra])
        XCTAssertEqual(selection.primary.map(\.absoluteString), [second, "https://twitter.com/alias/status/101?s=20"])
        XCTAssertEqual(selection.extra.map(\.absoluteString), [third])
        XCTAssertThrowsError(try CaptureInput.selectedPosts(first, roles: [.extra]))
        XCTAssertEqual(try CaptureInput.selectedPosts("\(first)\n\n\(second)", roles: [.primary, .extra, .extra]).extra.map(\.absoluteString), [second])
    }

    func testSubmissionFreezesMediaOnlyRoleAndInvalidatesStaleReview() throws {
        let first = "https://x.com/example/status/101"
        let extra = "https://x.com/example/status/102"
        var draft = CaptureDraft(accountID: 1, defaultChannel: channel(1), input: "\(first)\n\(extra)")
        draft.sourceRoles = [.primary, .extra]
        draft.phase = .ready
        draft.previewSnapshot = CapturePreview(kind: "social", url: first,
            plan: .object(["sources": .array([
                .object(["canonicalUrl": .string(first), "selection": .object(["role": .string("primary"), "origin": .string("explicit")])]),
                .object(["canonicalUrl": .string(extra), "selection": .object(["role": .string("extra"), "origin": .string("explicit")])])
            ])]), inputRefs: [first], extraInputRefs: [extra])
        let frozen = try CaptureSubmissionSnapshot(draft: draft)
        XCTAssertEqual(frozen.sourceRefs, [first])
        XCTAssertEqual(frozen.supplementaryRefs, [extra])
        XCTAssertEqual(try JSONDecoder().decode(CaptureSubmissionSnapshot.self, from: JSONEncoder().encode(frozen)).supplementaryRefs, [extra])
        XCTAssertEqual(frozen.preview?.extraInputRefs, [extra])
        draft.sourceRoles = [.primary, .primary]
        XCTAssertNil(try CaptureSubmissionSnapshot(draft: draft).preview)
    }

    func testExpandedSourceReviewStatesRoleOriginAndMediaContribution() {
        let preview = CapturePreview(kind: "social", url: "https://bsky.app/profile/example.test/post/one", plan: .object([
            "sources": .array([
                .object(["canonicalUrl": .string("https://bsky.app/profile/example.test/post/one"),
                         "selection": .object(["role": .string("primary"), "origin": .string("explicit")]),
                         "media": .array([.object(["ref": .string("1.1")])])]),
                .object(["canonicalUrl": .string("https://bsky.app/profile/example.test/post/two"),
                         "selection": .object(["role": .string("primary"), "origin": .string("expanded")]),
                         "media": .array([.object(["ref": .string("2.1")])])]),
                .object(["canonicalUrl": .string("https://x.com/fixture/status/123"),
                         "selection": .object(["role": .string("extra"), "origin": .string("explicit")]),
                         "media": .array([.object(["ref": .string("3.1")])])])
            ]), "block": .object(["selectedMedia": .array([.string("2.1"), .string("3.1")])])
        ]))
        XCTAssertEqual(preview.sourceReviews.map(\.roleLabel), ["Text and media", "Text and media", "Media only"])
        XCTAssertEqual(preview.sourceReviews.map(\.originLabel), ["Chosen post", "Connected post", "Chosen post"])
        XCTAssertEqual(preview.sourceReviews.map(\.mediaLabel), ["0 of 1 media included", "1 of 1 media included", "1 of 1 media included"])
        XCTAssertEqual(preview.sourceSummary, "3 sources · 2 in text · 2 media included")
    }

    func testRecompositionMovesMediaOnlyExtraAfterExpandedPrimaries() throws {
        let sources: JSONValue = .array([
            .object(["selection": .object(["role": .string("primary")])]),
            .object(["selection": .object(["role": .string("primary")])]),
            .object(["selection": .object(["role": .string("extra")])])
        ])
        let policy = try CaptureSourcePolicy.composing(.object(["media": .string("selected"),
            "selectedMedia": .array([.string("3.1")]), "mediaOnlyPosts": .array([.number(2)])]), sources: sources)
        XCTAssertEqual(policy["mediaOnlyPosts"], .array([.number(3)]))
        XCTAssertEqual(policy["selectedMedia"], .array([.string("3.1")]))
        XCTAssertThrowsError(try CaptureSourcePolicy.composing(.object([:]), sources: .array([
            .object(["selection": .object(["role": .string("primary")])]), .object([:])
        ])))
        XCTAssertEqual(try CaptureSourcePolicy.composing(.object(["media": .string("auto")]),
            sources: .array([.object([:])]))["media"], .string("auto"))
    }

    func testSubmissionFreezesEveryPostAndRefusesAnEarlierRenderAfterSourceChange() throws {
        let first = "https://x.com/fixture/status/123"
        let second = "https://x.com/another/status/124"
        var draft = CaptureDraft(accountID: 1, defaultChannel: channel(1), input: "\(first)\n\(second)")
        draft.phase = .ready
        draft.previewSnapshot = CapturePreview(kind: "social", url: first, plan: .object([
            "sources": .array([.object(["canonicalUrl": .string(first)]), .object(["canonicalUrl": .string(second)])])]))
        draft.renderPath = "/tmp/prior-composite.jpg"
        let snapshot = try CaptureSubmissionSnapshot(draft: draft)
        XCTAssertEqual(snapshot.url, first)
        XCTAssertEqual(snapshot.sourceRefs, [first, second])
        XCTAssertEqual(snapshot.reusableRenderPath, draft.renderPath)
        XCTAssertEqual(try JSONDecoder().decode(CaptureSubmissionSnapshot.self, from: JSONEncoder().encode(snapshot)).sourceRefs, [first, second])
        draft.input = "\(first)\nhttps://x.com/different/status/125"
        let changed = try CaptureSubmissionSnapshot(draft: draft)
        XCTAssertNil(changed.preview)
        XCTAssertNil(changed.reusableRenderPath)
    }

    func testSubmissionRetainsExpandedSourcesByExplicitPrimaryIdentity() throws {
        let first = "https://bsky.app/profile/example.test/post/one"
        let second = "https://bsky.app/profile/example.test/post/two"
        var draft = CaptureDraft(accountID: 1, defaultChannel: channel(1), input: first + "?ref=share")
        draft.phase = .ready
        draft.previewSnapshot = CapturePreview(kind: "social", url: first, plan: .object(["sources": .array([
            .object(["canonicalUrl": .string(second), "selection": .object(["role": .string("primary"), "origin": .string("expanded")])]),
            .object(["canonicalUrl": .string(first), "selection": .object(["role": .string("primary"), "origin": .string("explicit")])])
        ])]))
        draft.renderPath = "/tmp/reviewed-thread.jpg"
        let snapshot = try CaptureSubmissionSnapshot(draft: draft)
        XCTAssertEqual(snapshot.preview?.plan?["sources"]?.array.count, 2)
        XCTAssertEqual(snapshot.reusableRenderPath, draft.renderPath)
        XCTAssertNil(snapshot.policy["threadExpansion"])
        draft.threadExpansion = .off
        XCTAssertEqual(try CaptureSubmissionSnapshot(draft: draft).policy["threadExpansion"], .string("off"))
        draft.input = "https://bsky.app/profile/example.test/post/different"
        XCTAssertNil(try CaptureSubmissionSnapshot(draft: draft).preview)
    }

    func testEnteredATURIKeepsReviewedPreviewWhenProviderUsesHandleURL() throws {
        let entered = "at://did:plc:example/app.bsky.feed.post/one"
        let normalized = "https://bsky.app/profile/did:plc:example/post/one"
        let resolved = "https://bsky.app/profile/example.test/post/one"
        var draft = CaptureDraft(accountID: 1, defaultChannel: channel(1), input: entered)
        draft.phase = .ready
        draft.previewSnapshot = CapturePreview(kind: "social", url: normalized,
            plan: .object(["sources": .array([.object(["canonicalUrl": .string(resolved),
                "selection": .object(["role": .string("primary"), "origin": .string("explicit")])])])]),
            inputRefs: [normalized])
        let snapshot = try CaptureSubmissionSnapshot(draft: draft)
        XCTAssertEqual(snapshot.sourceRefs, [normalized])
        XCTAssertEqual(snapshot.preview?.plan?["sources"]?.array.count, 1)
    }

    func testRemovingDefaultDoesNotRestoreItAndNewDraftDoes() {
        var selection = DestinationSelection(defaultChannel: channel(1))
        selection.toggle(channel(1))
        XCTAssertTrue(selection.channels.isEmpty)
        selection.toggle(channel(2))
        XCTAssertEqual(selection.channels.map(\.id), [2])
        XCTAssertEqual(CaptureDraft(accountID: 1, defaultChannel: channel(1)).selection.channels.map(\.id), [1])
    }

    func testSelectionUsesIdentityAndRespectsAPILimit() {
        var selection = DestinationSelection(defaultChannel: nil)
        for id in 1...25 { selection.toggle(channel(id)) }
        XCTAssertEqual(selection.channels.count, 20)
        var renamed = channel(1); renamed.title = "New title"
        selection.toggle(renamed)
        XCTAssertFalse(selection.contains(channel(1)))
    }

    func testChannelURLAndSlugResolution() throws {
        XCTAssertEqual(try CaptureInput.channelIdentifier(" https://www.are.na/owner/my-channel?view=grid "), "my-channel")
        XCTAssertEqual(try CaptureInput.channelIdentifier("my-channel"), "my-channel")
        XCTAssertThrowsError(try CaptureInput.channelIdentifier("https://www.are.na/block/123"))
        XCTAssertThrowsError(try CaptureInput.channelIdentifier("https://are.na.evil.test/owner/channel"))
        XCTAssertThrowsError(try CaptureInput.channelIdentifier("https://secret@are.na/owner/channel"))
        XCTAssertThrowsError(try CaptureInput.channelIdentifier("https://www.are.na/owner/channel/contents"))
    }

    func testSharedTextDoesNotSilentlyChooseAmongSeveralLinks() throws {
        XCTAssertEqual(try CaptureInput.singleURL("Look: https://example.com/article").host, "example.com")
        XCTAssertThrowsError(try CaptureInput.singleURL("https://example.com/a https://example.com/b"))
        XCTAssertEqual(CaptureInput.urls(in: "https://example.com/a https://example.com/a").count, 1)
        XCTAssertThrowsError(try CaptureInput.singleURL("file:///private/example"))
        XCTAssertThrowsError(try CaptureInput.singleURL("https://user:secret@example.com"))
        XCTAssertEqual(try CaptureInput.singleURL("at://example.com/app.bsky.feed.post/abc").scheme, "at")
    }

    func testDelveClipboardATURIAndSourceRolesPreserveReviewedIdentity() throws {
        let uri = "at://did:plc:2vb3emjr2ttkwc2dj534fdqj/town.delve.feed.post/3mxe7nb7vfk2u"
        let web = "https://delve.town/profile/did:plc:2vb3emjr2ttkwc2dj534fdqj/post/3mxe7nb7vfk2u"
        let atURL = try CaptureInput.singleURL(uri)
        let webURL = try CaptureInput.singleURL(web)
        XCTAssertTrue(CaptureInput.isAtprotoPost(atURL))
        XCTAssertFalse(CaptureInput.isBlueskyPost(atURL))
        XCTAssertEqual(CaptureInput.canonicalSourceIdentity(atURL), CaptureInput.canonicalSourceIdentity(webURL))
        XCTAssertNotNil(CaptureInput.pasteableSourceText("Read this: " + uri))
        let links = try CaptureInput.selectedPosts(uri + "\n" + web, roles: [.primary, .extra])
        XCTAssertEqual(links.primary.count, 1)
        XCTAssertTrue(links.extra.isEmpty)
        let webDID = "did:web:example.com%3A8443"
        let encoded = "https://delve.town/profile/did:web:example.com%253A8443/post/a"
        let didAT = try CaptureInput.singleURL("at://\(webDID)/town.delve.feed.post/a")
        XCTAssertEqual(CaptureInput.canonicalSourceIdentity(didAT), CaptureInput.canonicalSourceIdentity(try CaptureInput.singleURL(encoded)))
        XCTAssertNil(CaptureInput.pasteableSourceText("Just some text about Delve"))
    }

    func testForumMagnumClipboardAndSourceRowsKeepDistinctComments() throws {
        let root = "https://www.lesswrong.com/posts/6eaKqtmDuo6CmkqMK/loops-s-shortform"
        let first = root + "?commentId=7C9iqsDCdxC2PfKDf"
        let alternate = "https://greaterwrong.com/posts/6eaKqtmDuo6CmkqMK/loops-s-shortform/comment/7C9iqsDCdxC2PfKDf"
        let second = root + "#comment-jFB6xwANhpqJkkvc4"
        let post = URL(string: root)!
        let firstURL = URL(string: first)!
        let secondURL = URL(string: second)!
        XCTAssertTrue(CaptureInput.isForumMagnumComment(firstURL))
        XCTAssertTrue(CaptureInput.isForumMagnumComment(secondURL))
        XCTAssertFalse(CaptureInput.isForumMagnumComment(post))
        XCTAssertEqual(CaptureInput.canonicalSourceIdentity(firstURL),
                       CaptureInput.canonicalSourceIdentity(URL(string: alternate)!))
        XCTAssertNotEqual(CaptureInput.canonicalSourceIdentity(firstURL), CaptureInput.canonicalSourceIdentity(secondURL))
        XCTAssertNotEqual(CaptureInput.canonicalSourceIdentity(firstURL), CaptureInput.canonicalSourceIdentity(post))
        let selected = try CaptureInput.selectedPosts([first, alternate, second, root].joined(separator: "\n"), roles: nil)
        XCTAssertEqual(selected.primary.map(\.absoluteString), [first, second, root])
        XCTAssertEqual(CaptureInput.pasteableSourceText([first, alternate, second, root].joined(separator: "\n")),
                       [first, second, root].joined(separator: "\n"))
        XCTAssertNotEqual(CaptureInput.canonicalSourceIdentity(URL(string: root + "#comment-bad")!),
                          CaptureInput.canonicalSourceIdentity(post))
    }

    func testClipboardIntakeRetainsOnlyExplicitLinks() {
        XCTAssertNil(CaptureInput.pasteableSourceText(""))
        XCTAssertNil(CaptureInput.pasteableSourceText("initially read this as “stochastic” lol"))
        XCTAssertNil(CaptureInput.pasteableSourceText("https://"))
        XCTAssertNil(CaptureInput.pasteableSourceText("example.com"))
        XCTAssertNil(CaptureInput.pasteableSourceText("file:///private/example"))
        XCTAssertNil(CaptureInput.pasteableSourceText("https://user:secret@example.com"))
        XCTAssertEqual(CaptureInput.pasteableSourceText("https://x.com/fixture/status/123"),
                       "https://x.com/fixture/status/123")
        XCTAssertEqual(CaptureInput.pasteableSourceText("Read this https://example.com/article before lunch."),
                       "https://example.com/article")
        XCTAssertEqual(CaptureInput.pasteableSourceText("https://example.com/a\nhttps://example.com/b"),
                       "https://example.com/a\nhttps://example.com/b")
        XCTAssertEqual(CaptureInput.pasteableSourceText("at://example.com/app.bsky.feed.post/abc"),
                       "at://example.com/app.bsky.feed.post/abc")
        XCTAssertNil(CaptureInput.pasteableSourceText((1...21).map { "https://example.com/\($0)" }.joined(separator: "\n")))
    }

    func testMediaChoicesFollowSourceIdentityWhenThreadExpansionMovesAnExtra() throws {
        let old = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        [
          {"canonicalUrl":"https://x.com/author/status/1","media":[{"ref":"1.1","url":"https://cdn.test/root.jpg","kind":"image"}]},
          {"canonicalUrl":"https://x.com/other/status/2","media":[{"ref":"2.1","url":"https://cdn.test/extra.mp4","kind":"video"}]}
        ]
        """#.utf8))
        let expanded = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        [
          {"canonicalUrl":"https://x.com/author/status/1","media":[{"ref":"1.1","url":"https://cdn.test/root.jpg","kind":"image"}]},
          {"canonicalUrl":"https://x.com/author/status/3","media":[{"ref":"2.1","url":"https://cdn.test/expanded.jpg","kind":"image"}]},
          {"canonicalUrl":"https://x.com/other/status/2","media":[{"ref":"3.1","url":"https://cdn.test/extra.mp4","kind":"video"}]}
        ]
        """#.utf8))
        let preview = CapturePreview(kind: "social", url: "https://x.com/author/status/1", plan: .object(["sources": old]))
        let anchors = try CaptureMediaChoiceAnchors.capture(preview: preview, selected: ["2.1"], frames: ["2.1"])
        let policy: JSONValue = .object(["media": .string("selected"), "selectedMedia": .array([.string("2.1")]),
                                         "videoFrames": .array([.string("2.1")])])
        let remapped = try anchors.applying(to: policy, sources: expanded)
        XCTAssertEqual(remapped["selectedMedia"], .array([.string("3.1")]))
        XCTAssertEqual(remapped["videoFrames"], .array([.string("3.1")]))
        XCTAssertThrowsError(try anchors.applying(to: policy, sources: .array(Array(expanded.array.prefix(2)))))

        var draft = CaptureDraft(accountID: 1, defaultChannel: channel(1),
                                 input: "https://x.com/author/status/1\nhttps://x.com/other/status/2")
        draft.sourceRoles = [.primary, .extra]
        draft.media = .selected; draft.selectedMedia = ["2.1"]; draft.videoFrames = ["2.1"]
        draft.pendingMediaChoices = anchors
        draft.titleOverride = "My title"; draft.descriptionOverride = "My description"
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        let snapshot = try CaptureSubmissionSnapshot(draft: restored)
        XCTAssertEqual(snapshot.title, "My title")
        XCTAssertEqual(snapshot.description, "My description")
        XCTAssertNotNil(snapshot.pendingMediaChoices)
        XCTAssertEqual(try snapshot.pendingMediaChoices?.applying(to: snapshot.policy, sources: expanded)["selectedMedia"],
                       .array([.string("3.1")]))
    }

    func testCrashRecoveryNeverReclassifiesAnUnknownCreateAsSafeToRetry() throws {
        var draft = CaptureDraft(accountID: 1, defaultChannel: channel(1), input: "https://example.com")
        draft.phase = .creating
        let serialized = try JSONEncoder().encode(draft)
        var restored = try JSONDecoder().decode(CaptureDraft.self, from: serialized)
        restored.recoverAfterInterruption()
        XCTAssertEqual(restored.phase, .uncertain)
        XCTAssertNotNil(restored.problem)
        restored.blockID = 42; restored.phase = .checking; restored.recoverAfterInterruption()
        XCTAssertEqual(restored.phase, .checking)
        XCTAssertEqual(restored.blockID, 42)
    }

    func testSharedStorageSeparatesAccountsAndSurvivesReopening() async throws {
        try await MainActor.run {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("capture.sqlite")
        let first = try CaptureStore(url: url)
        try first.save(channel(1), account: 10, kind: "channel", id: "1")
        try first.save(channel(2), account: 20, kind: "channel", id: "2")
        let second = try CaptureStore(url: url)
        XCTAssertTrue(try first.reservePublication(account: 10, key: "same-source", draftID: UUID()))
        XCTAssertFalse(try second.reservePublication(account: 10, key: "same-source", draftID: UUID()))
        XCTAssertTrue(try second.reservePublication(account: 20, key: "same-source", draftID: UUID()))
        XCTAssertEqual(try second.values(Channel.self, account: 10, kind: "channel").map(\.id), [1])
        XCTAssertEqual(try second.values(Channel.self, account: 20, kind: "channel").map(\.id), [2])
        XCTAssertNil(try second.value(Channel.self, account: 20, kind: "channel", id: "1"))
        try second.remove(account: 10, kind: "channel", id: "1")
        XCTAssertTrue(try first.values(Channel.self, account: 10, kind: "channel").isEmpty)
        }
    }

    func testV3ChannelPermissionAndGroupOwnerDecode() throws {
        let json = #"{"id":42,"title":"Field notes","slug":"field-notes","visibility":"closed","owner":{"id":7,"name":"Studio","slug":"studio","type":"Group"},"can":{"add_to":true},"counts":{"blocks":186,"channels":2,"contents":188,"collaborators":1}}"#
        let channel = try JSONDecoder().decode(Channel.self, from: Data(json.utf8))
        XCTAssertEqual(channel.label, "Studio / Field notes")
        XCTAssertEqual(channel.can?.addTo, true)
        XCTAssertEqual(channel.counts?.contents, 188)
        XCTAssertEqual(channel.owner.type, "Group")
    }

    func testRetainedChannelSearchToleratesTyposAndPreservesStableTies() {
        var first = channel(1); first.title = "Predictions"; first.slug = "predictions"
        var second = channel(2); second.title = "Prediction archive"; second.slug = "prediction-archive"
        var third = channel(3); third.title = "Pattern studies"; third.slug = "pattern-studies"
        let retained = [first, second, third]
        XCTAssertEqual(ChannelSearch.matches(retained, query: "pred" ).map(\.id), [1, 2])
        XCTAssertEqual(ChannelSearch.matches(retained, query: "predctions").first?.id, 1)
        XCTAssertEqual(ChannelSearch.matches(retained, query: "prediction archve").map(\.id), [2])
        XCTAssertEqual(ChannelSearch.matches(retained, query: "pttrn").map(\.id), [3])
        XCTAssertEqual(ChannelSearch.matches(retained, query: "totally unrelated"), [])
        XCTAssertEqual(ChannelSearch.matches(retained, query: "").map(\.id), [1, 2, 3])
        var accented = channel(4); accented.title = "Café studies"; accented.slug = "cafe-studies"
        XCTAssertEqual(ChannelSearch.matches([accented], query: "cafe").map(\.id), [4])
        XCTAssertEqual(ChannelSearch.matches([first, second], query: "owner prediction").first?.id, 2)
    }
}
