#if DEBUG && targetEnvironment(simulator)
import CaptureCore
import CaptureRuntime
import Foundation
import UIKit
import SwiftUI
import Observation

struct PreviewFixtures {
    @MainActor static var backgroundProbe: FixtureBackgroundProbe?
    let account: Account
    let channels: [Channel]
    let draft: CaptureDraft
    let preview: CapturePreview
    let history: CaptureDraft

    @MainActor
    init(mode: String, directory: URL) throws {
        account = try JSONDecoder().decode(Account.self, from: Data(#"{"id":-42,"name":"Morgan","slug":"morgan","tier":"premium"}"#.utf8))
        let baseChannels = try JSONDecoder().decode([Channel].self, from: Data(#"[{"id":101,"title":"Inbox","slug":"inbox","visibility":"private","owner":{"id":-42,"name":"Morgan","slug":"morgan","type":"User"},"can":{"add_to":true}},{"id":102,"title":"Interface design","slug":"interface-design","visibility":"public","owner":{"id":-42,"name":"Morgan","slug":"morgan","type":"User"},"can":{"add_to":true}},{"id":103,"title":"Visual notes","slug":"visual-notes","visibility":"private","owner":{"id":-42,"name":"Morgan","slug":"morgan","type":"User"},"can":{"add_to":true}}]"#.utf8))
        channels = mode == "many-channels" ? baseChannels + (104...144).map { id in
            Channel(id: id, title: "Reference study \(id - 100)", slug: "reference-\(id)",
                    visibility: id.isMultiple(of: 2) ? "private" : "closed", owner: baseChannels[0].owner, can: .init(addTo: true))
        } : baseChannels
        let imageURLs = try (0..<(mode == "media-selection" ? 3 : ["multi-post", "multi-post-extra", "multi-post-long"].contains(mode) ? 2 : 1)).map { index -> URL in
            let url = directory.appendingPathComponent("fixture-\(index).jpg")
            let image = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 500)).image { context in
                UIColor(white: 0.9 - Double(index) * 0.1, alpha: 1).setFill()
                context.fill(CGRect(x: 0, y: 0, width: 800, height: 500))
                UIColor(white: 0.2, alpha: 1).setFill()
                if index == 1 { context.cgContext.fillEllipse(in: CGRect(x: 160, y: 70, width: 420, height: 360)) }
                else if index == 2 {
                    context.fill(CGRect(x: 100, y: 100, width: 550, height: 70))
                    context.fill(CGRect(x: 200, y: 240, width: 450, height: 150))
                } else {
                    context.fill(CGRect(x: 100, y: 100, width: 230, height: 300))
                    UIColor(white: 0.65, alpha: 1).setFill()
                    context.cgContext.fillEllipse(in: CGRect(x: 390, y: 100, width: 300, height: 300))
                }
            }
            try image.jpegData(compressionQuality: 0.9)!.write(to: url)
            return url
        }
        let text = mode == "long-text" ? "Beginning of the retained text. This first paragraph introduces an idea that needs more than six lines to read on a phone. The next part gives enough detail to distinguish the collapsed and expanded states during an interaction test. A third sentence continues the original post without changing it. A fourth sentence makes the excerpt long enough on wider devices too. Another paragraph follows with enough original wording to keep the expansion meaningful on a larger screen. It describes an image, a saved fragment, and a conversation that should remain in its original order. The author then adds a note about returning to the same source later, and why the full text matters when placing it into a channel. The end of the retained text is visible only after expansion." : "A small collection of things worth looking at again."
        let media: [JSONValue] = mode == "long-text" || mode == "quoted" ? [] : imageURLs.enumerated().filter { !["multi-post", "multi-post-extra"].contains(mode) || $0.offset == 0 }.map { index, url in
            if mode == "video-frame" {
                return .object(["ref": .string("1.\(index + 1)"), "kind": .string("video"),
                                "url": .string("https://fixture.invalid/clip.mp4"), "posterUrl": .string("https://fixture.invalid/observed-frame.jpg"),
                                "durationSeconds": .number(90), "alt": .string("Recorded clip"),
                                "width": .number(800), "height": .number(500)])
            }
            return .object(["ref": .string("1.\(index + 1)"), "kind": .string("image"), "url": .string(url.absoluteString),
                            "alt": .string(["Geometric study", "Ellipse study", "Line study"][index]), "width": .number(800), "height": .number(500)])
        }
        var post: [String: JSONValue] = ["provider": .string("x"), "id": .string("123"),
            "canonicalUrl": .string("https://x.com/example/status/123"), "author": .object(["handle": .string("example")]),
            "text": .string(text), "media": .array(media)]
        if mode.hasPrefix("bluesky") {
            post["provider"] = .string("bluesky")
            post["canonicalUrl"] = .string("https://bsky.app/profile/example.test/post/3mxfymplzic26")
        }
        if mode == "multi-post-extra" {
            post["selection"] = .object(["role": .string("primary"), "origin": .string("explicit"), "declaredIndex": .number(1)])
        }
        if mode == "soundcloud-playlist" {
            post = ["provider": .string("soundcloud"), "id": .string("2001"),
                    "canonicalUrl": .string("https://soundcloud.com/fixture/sets/synthetic-playlist"),
                    "author": .object(["handle": .string("fixture"), "name": .string("Fixture artist")]),
                    "postTitle": .string("Synthetic playlist"), "text": .string(""), "media": .array([]),
                    "soundcloud": .object([
                        "kind": .string("playlist"), "description": .string("Original synthetic playlist description."),
                        "artworkUrl": .string("https://i1.sndcdn.com/artworks-fixture-large.jpg"),
                        "declaredTrackCount": .number(2), "tracks": .array([
                            .object(["id": .string("1001"), "title": .string("First synthetic track"),
                                     "artists": .array([.string("Fixture artist")]),
                                     "url": .string("https://soundcloud.com/fixture/first-synthetic-track"),
                                     "durationSeconds": .number(61)]),
                            .object(["id": .string("1002"), "title": .string("Second synthetic track"),
                                     "artists": .array([.string("Another artist")]),
                                     "url": .string("https://soundcloud.com/fixture/second-synthetic-track")])
                        ])
                    ])]
        }
        if mode == "quoted" {
            var quote: JSONValue?
            for index in (1...3).reversed() {
                var item: [String: JSONValue] = ["provider": .string("x"), "id": .string("quote-\(index)"),
                    "canonicalUrl": .string("https://x.com/example/status/\(120 + index)"),
                    "author": .object(["handle": .string("quote-\(index)")]),
                    "text": .string("Quoted thought at level \(index)."), "media": .array([])]
                if let quote { item["quote"] = quote }
                quote = .object(item)
            }
            post["quote"] = quote
        }
        let runtime = try CaptureRuntime()
        var sources: [JSONValue] = [.object(post)]
        if mode == "multi-post" || mode == "multi-post-extra" {
            var second: [String: JSONValue] = ["provider": .string("x"), "id": .string("124"),
                "canonicalUrl": .string("https://x.com/another/status/124"),
                "author": .object(["handle": .string("another")]),
                "text": .string("A second post with its own image and source."),
                "media": .array([.object(["ref": .string("2.1"), "kind": .string("image"),
                    "url": .string(imageURLs[1].absoluteString), "alt": .string("Second geometric study"),
                    "width": .number(800), "height": .number(500)])])]
            if mode == "multi-post-extra" {
                second["selection"] = .object(["role": .string("extra"), "origin": .string("explicit"), "declaredIndex": .number(2)])
            }
            sources.append(.object(second))
        } else if mode == "multi-post-long" {
            let longText = "A longer field note about visual references, authorship, and the order of the original conversation. This paragraph should remain available for review without taking over the first Capture screen."
            sources = (0..<4).map { index in
                .object(["provider": .string("x"), "id": .string("\(123 + index)"),
                    "canonicalUrl": .string("https://x.com/fieldnotes/status/\(123 + index)"),
                    "author": .object(["handle": .string("fieldnotes")]),
                    "text": .string("Post \(index + 1). \(longText)"),
                    "media": .array(index.isMultiple(of: 2) ? [.object([
                        "ref": .string("\(index + 1).1"), "kind": .string("image"),
                        "url": .string(imageURLs[index / 2].absoluteString),
                        "alt": .string("Field note image \(index + 1)"),
                        "width": .number(800), "height": .number(500)])] : [])])
            }
        }
        let postJSON = String(decoding: try JSONEncoder().encode(JSONValue.array(sources)), as: UTF8.self)
        let initialPolicy = mode == "media-selection" ? "{\"media\":\"none\"}" :
            mode == "multi-post-extra" ? "{\"mediaOnlyPosts\":[2]}" : "{}"
        let composed = try JSONDecoder().decode(JSONValue.self, from: Data(runtime.compose(postsJSON: postJSON, policyJSON: initialPolicy).utf8))
        preview = CapturePreview(kind: "social", url: sources.first?["canonicalUrl"]?.string ?? "https://x.com/example/status/123", plan: composed["plan"])
        let imageURL = imageURLs[0]
        let multiPostInput = sources.compactMap { $0["canonicalUrl"]?.string }.joined(separator: "\n")
        var sample = CaptureDraft(accountID: account.id, defaultChannel: mode == "no-default" ? nil : channels[0], input: ["multi-post", "multi-post-extra", "multi-post-long"].contains(mode) ? multiPostInput : preview.url)
        sample.phase = .ready; sample.previewSnapshot = preview; sample.renderPath = ["long-text", "media-selection", "quoted", "soundcloud-playlist", "multi-post", "multi-post-extra", "multi-post-long", "video-frame"].contains(mode) ? nil : imageURL.path
        if mode == "multi-post-extra" { sample.sourceRoles = [.primary, .extra] }
        if mode == "media-selection" || mode == "video-frame" { sample.media = .none }
        sample.titleOverride = ["soundcloud-playlist", "multi-post", "multi-post-extra", "multi-post-long"].contains(mode) ? nil : "A study in shape"
        sample.descriptionOverride = ["soundcloud-playlist", "multi-post", "multi-post-extra", "multi-post-long"].contains(mode) ? nil : "A small collection of things worth looking at again."
        var saved = sample
        saved.id = UUID(); saved.phase = .saved; saved.blockID = 900
        saved.deliveryState = CaptureDeliveryState(operationID: saved.id, stage: .done, confirmedChannelIDs: [101], contentVerified: true)
        saved.savedBlock = .object(["id": .number(900), "type": .string("Link"), "state": .string("available"), "title": .string("A study in shape"), "content": .object(["markdown": .string("")]), "description": .object(["markdown": .string("A small collection of things worth looking at again.")]), "image": .object(["large": .object(["url": .string(imageURL.absoluteString)])])])
        history = saved
        switch mode {
        case "empty", "slow-resolution": sample = CaptureDraft(accountID: account.id, defaultChannel: channels[0])
        case "invalid-restored":
            sample = CaptureDraft(accountID: account.id, defaultChannel: channels[0], input: "initially read this as “stochastic” lol")
            sample.phase = .failed
            sample.problem = "Paste a link to capture."
        case "saved": sample = saved
        case "saved-stopped":
            sample = saved
            sample.deliveryState?.stopRequested = true
        case "queued":
            sample.phase = .queued
            sample.deliveryState = CaptureDeliveryState(operationID: sample.id, stage: .queued)
        case "reddit-denied":
            sample.input = "https://www.reddit.com/r/slatestarcodex/s/7iPiVUIyix"
            sample.titleOverride = nil; sample.descriptionOverride = nil
            if ProcessInfo.processInfo.environment["CAPTURE_UI_REDDIT_WRITING"] == "1" {
                sample.titleOverride = "Kept title"; sample.descriptionOverride = "Kept writing"
            }
            sample.previewSnapshot = nil; sample.renderPath = nil
            sample.selection.toggle(channels[2])
            sample.submittedDefaultChannelID = channels[0].id
            sample.phase = .queued
            sample.problem = "Reddit's live metadata read returned HTTP 403; current content cannot be verified. No archive or block creation was attempted"
            // An old stored projection must be corrected from the retained job on opening.
            sample.deliveryState = CaptureDeliveryState(operationID: sample.id, stage: .attention)
        case "preparing": sample.phase = .preparing
        case "bluesky-error":
            sample.phase = .failed; sample.previewSnapshot = nil; sample.renderPath = nil
            sample.problem = "The source could not be loaded. Check your connection and try again."
        case "unknown":
            sample.phase = .uncertain
            sample.problem = "The earlier save could not be confirmed."
            sample.publicationKey = "offline-unknown-save"
            sample.deliveryState = CaptureDeliveryState(operationID: sample.id, stage: .attention)
        case "connecting":
            sample.selection.toggle(channels[1])
            sample.phase = .checking; sample.blockID = saved.blockID; sample.savedBlock = saved.savedBlock
            sample.deliveryState = CaptureDeliveryState(operationID: sample.id, stage: .connections, confirmedChannelIDs: [101], contentVerified: true)
        case "partial":
            sample.selection.toggle(channels[1]); sample.selection.toggle(channels[2])
            sample.phase = .checking; sample.blockID = saved.blockID; sample.savedBlock = saved.savedBlock
            sample.problem = "The block is available. Visual notes still needs confirmation."
            sample.deliveryState = CaptureDeliveryState(operationID: sample.id, stage: .attention, confirmedChannelIDs: [102], contentVerified: true)
        default: break
        }
        draft = sample
    }

    func api() -> ArenaAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureURLProtocol.self]
        return ArenaAPI(token: "fixture", session: URLSession(configuration: configuration))
    }
}

private final class FixtureURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let raw = #"[{"id":101,"title":"Inbox","slug":"inbox","visibility":"private","owner":{"id":-42,"name":"Morgan","slug":"morgan","type":"User"},"can":{"add_to":true}},{"id":102,"title":"Interface design","slug":"interface-design","visibility":"public","owner":{"id":-42,"name":"Morgan","slug":"morgan","type":"User"},"can":{"add_to":true}},{"id":103,"title":"Visual notes","slug":"visual-notes","visibility":"private","owner":{"id":-42,"name":"Morgan","slug":"morgan","type":"User"},"can":{"add_to":true}}]"#
        do {
            guard let url = request.url else { throw URLError(.badURL) }
            let channels = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [[String: Any]]
            let value: Any
            if url.path.contains("/channels/"), let id = Int(url.lastPathComponent), let channel = channels.first(where: { $0["id"] as? Int == id }) { value = channel }
            else if url.path.contains("/blocks/") {
                value = ["id": 900, "type": "Link", "state": "available", "title": "A study in shape", "description": ["markdown": "A small collection of things worth looking at again."]]
            } else {
                let term = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "query" }?.value ?? ""
                let found = term.isEmpty || term == "*" ? channels : channels.filter { ($0["title"] as? String)?.localizedCaseInsensitiveContains(term) == true }
                value = ["data": found, "meta": ["has_more_pages": false]]
            }
            let data = try JSONSerialization.data(withJSONObject: value)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
}
@MainActor @Observable
final class FixtureBackgroundProbe {
    private struct Record: Codable {
        var id: String
        var sessionIdentifier: String
        var submitted: Bool
    }
    var status = "Ready"
    var canSubmit: Bool { !record.submitted }
    private let transport: BackgroundHTTP
    private let directory: URL
    private var record: Record
    private var recordURL: URL { directory.appendingPathComponent("probe.json") }

    init(group: String?, directory fixtureDirectory: URL) throws {
        let base: URL
        if let group {
            guard let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
                throw CaptureError.message("The QA App Group is unavailable.")
            }
            base = shared
        } else { base = fixtureDirectory }
        directory = base.appendingPathComponent("background-probe").appendingPathComponent(fixtureDirectory.lastPathComponent)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let recordFile = directory.appendingPathComponent("probe.json")
        let loadedRecord: Record
        if FileManager.default.fileExists(atPath: recordFile.path) {
            loadedRecord = try JSONDecoder().decode(Record.self, from: Data(contentsOf: recordFile))
        } else {
            let id = UUID().uuidString
            loadedRecord = Record(id: id, sessionIdentifier: "capture.fixture." + id + ".delivery", submitted: false)
            try JSONEncoder().encode(loadedRecord).write(to: recordFile, options: .atomic)
        }
        record = loadedRecord
        transport = try BackgroundHTTP(identifier: loadedRecord.sessionIdentifier, group: group, directory: directory)
        transport.onResult = { [weak self] _ in await self?.refresh() }
        transport.connect()
        refresh()
    }
    func submit() {
        guard canSubmit else { return }
        do {
            guard let raw = ProcessInfo.processInfo.environment["CAPTURE_BACKGROUND_URL"], let url = URL(string: raw),
                  ["localhost", "127.0.0.1"].contains(url.host ?? "") else { status = "Invalid fixture URL"; return }
            let file = directory.appendingPathComponent("background-request.txt")
            try Data("Capture background transfer fixture".utf8).write(to: file)
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue(record.id, forHTTPHeaderField: "X-Capture-Probe-ID")
            record.submitted = true
            try JSONEncoder().encode(record).write(to: recordURL, options: .atomic)
            transport.submit(id: record.id, request: request, file: file).resume()
            status = "Submitted"
        } catch { status = error.localizedDescription }
    }
    func refresh() {
        do {
            if let result = try transport.result(record.id) {
                status = result.status == 200 && result.error == nil ? "Background transfer completed" : "Transfer failed: \(result.errorDomain ?? "HTTP") \(result.errorCode ?? result.status ?? 0) \(result.error ?? "")"
            } else { status = record.submitted ? "Submitted" : "Ready" }
        } catch { status = error.localizedDescription }
    }
    func handle(completion: @escaping @Sendable () -> Void) {
        transport.onFinishedEvents = { completion() }
    }
}

struct FixtureBackgroundView: View {
    let directory: URL
    @Environment(\.scenePhase) private var scenePhase
    @State private var probe: FixtureBackgroundProbe?
    @State private var probeError: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(probe?.status ?? probeError ?? "Preparing probe").accessibilityIdentifier("fixture.background.status")
            Button("Start Background Probe") { probe?.submit() }.disabled(probe?.canSubmit != true)
        }
        .task {
            do {
                let created = try FixtureBackgroundProbe(group: Bundle.main.object(forInfoDictionaryKey: "CaptureAppGroup") as? String, directory: directory)
                probe = created; PreviewFixtures.backgroundProbe = created
            } catch { probeError = error.localizedDescription }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { probe?.refresh() } }
    }
}
#endif
