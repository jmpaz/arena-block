import CaptureCore
import CaptureRuntime
import Foundation
import ImageIO

struct CapturePreparedSource {
    var preview: CapturePreview
    var prepared: PreparedCapture
    var reusableRenderPath: String?
}

/// Foreground/BGProcessing work. The durable job precedes this object's provider and media reads.
@MainActor
final class CapturePreparation {
    let runtime: CaptureRuntime
    let container: URL
    init(runtime: CaptureRuntime, container: URL) { self.runtime = runtime; self.container = container }

    func read(_ snapshot: CaptureSubmissionSnapshot) async throws -> CapturePreparedSource {
        if snapshot.originalLinkOnly == true {
            guard snapshot.sourceRefs.count == 1, snapshot.supplementaryRefs.isEmpty,
                  let url = try? CaptureInput.singleURL(snapshot.url),
                  ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
                throw CaptureError.message("Choose one supported link for this capture.")
            }
            var prepared = PreparedCapture(payload: ["value": .string(url.absoluteString), "original_source_url": .string(url.absoluteString)], update: [:])
            if let title = snapshot.title { prepared.payload["title"] = .string(title); prepared.update["title"] = .string(title) }
            if let description = snapshot.description { prepared.payload["description"] = .string(description); prepared.update["description"] = .string(description) }
            return .init(preview: .originalLink(url), prepared: prepared)
        }
        let refs = snapshot.sourceRefs
        let extras = snapshot.supplementaryRefs
        let source = try decode(runtime.source(snapshot.url))
        if refs.count + extras.count > 1 {
            for ref in refs + extras {
                let item = try decode(runtime.source(ref))
                guard item["kind"]?.string == "social" else {
                    throw CaptureError.message("Add supported posts here. No block was created.")
                }
            }
        }
        guard source["kind"]?.string == "social" else {
            var preview = snapshot.preview ?? .originalLink(URL(string: snapshot.url)!)
            preview.plan = nil
            var prepared = preview.localPreparation ?? .init(payload: ["value": .string(snapshot.url), "original_source_url": .string(snapshot.url)], update: [:])
            if let title = snapshot.title { prepared.payload["title"] = .string(title); prepared.update["title"] = .string(title) }
            if let description = snapshot.description { prepared.payload["description"] = .string(description); prepared.update["description"] = .string(description) }
            return .init(preview: preview, prepared: prepared)
        }
        let sources: JSONValue
        if let retained = snapshot.preview?.plan?["sources"], !retained.array.isEmpty,
           !(snapshot.preview?.canExpandQuotes == true && (snapshot.policy["quoteDepth"] == .string("full") || (snapshot.policy["quoteDepth"]?.int ?? 0) > (snapshot.preview?.availableQuoteDepth ?? 0))) {
            sources = retained
        } else {
            var acquisition = snapshot.policy.object
            acquisition["quoteDepth"] = (snapshot.policy["quoteDepth"] == .string("full") || (snapshot.policy["quoteDepth"]?.int ?? 0) > 2) ? .string("full") : .number(2)
            let resolved = try decode(await runtime.resolve(refs: refs, extraRefs: extras, policyJSON: json(.object(acquisition)), redditCapturesJSON: snapshot.redditCapturesJSON ?? "[]", substackCapturesJSON: snapshot.substackCapturesJSON ?? "[]"))
            guard let retained = resolved["plan"]?["sources"], !retained.array.isEmpty else { throw CaptureError.message("The source could not be read. Retry this capture.") }
            sources = retained
        }
        try Task.checkCancellation()
        return try compose(snapshot, sources: sources)
    }

    func compose(_ snapshot: CaptureSubmissionSnapshot, sources: JSONValue) throws -> CapturePreparedSource {
        let policy = try snapshot.pendingMediaChoices?.applying(to: snapshot.policy, sources: sources) ?? snapshot.policy
        let requested = policy["selectedMedia"]?.array.compactMap(\.string) ?? []
        let available = Set(CaptureMediaTree.sources(in: sources).flatMap(\.media).compactMap { $0["ref"]?.string })
        guard Set(requested).isSubset(of: available) else { throw CaptureError.message("Some selected media is unavailable. No block was created. Try again.") }
        let effectivePolicy = try CaptureSourcePolicy.composing(policy, sources: sources)
        let composed = try decode(runtime.compose(postsJSON: json(sources), policyJSON: json(effectivePolicy)))
        guard let original = composed["plan"] else { throw CaptureError.message("Couldn't prepare this capture.") }
        var edits: [String: JSONValue] = [:]
        if let title = snapshot.title { edits["title"] = .string(title) }
        if let description = snapshot.description {
            if original["block"]?["kind"]?.string == "text" { edits["description"] = .string(description) }
            else { edits["markdown"] = .string(description); edits["description"] = .string("") }
        }
        let edited = try decode(runtime.edit(planJSON: json(original), editsJSON: json(.object(edits))))
        guard let plan = edited["plan"] else { throw CaptureError.message("Couldn't prepare this capture.") }
        let selected = Set(plan["block"]?["selectedMedia"]?.array.compactMap(\.string) ?? [])
        let visible = Set(CaptureMediaTree.media(in: plan).compactMap { $0["ref"]?.string })
        guard policy["media"] != .string("selected") || selected == Set(requested).intersection(visible) else { throw CaptureError.message("Couldn't prepare the selected media. No block was created.") }
        let preview = CapturePreview(kind: "social", url: snapshot.url, plan: plan,
                                     inputRefs: snapshot.sourceRefs, extraInputRefs: snapshot.supplementaryRefs)
        let payload = try decode(runtime.localPayload(planJSON: json(plan), mediaURL: "https://s3.amazonaws.com/arena_images-temp/pending", ingestURL: snapshot.url)).object
        // Edits cannot change geometry; compare the composed block before applying writing overrides.
        let sameAudio = (snapshot.preview?.plan?["policy"]?["audio"]?.string ?? "auto") == (original["policy"]?["audio"]?.string ?? "auto")
        let sameMedia = sameAudio && snapshot.preview?.plan?["block"] == original["block"] && snapshot.preview?.plan?["sources"] == sources
        let path = sameMedia ? snapshot.reusableRenderPath : nil
        return .init(preview: preview, prepared: .init(payload: payload, update: edited["fields"]?.object ?? [:]), reusableRenderPath: path)
    }

    func render(plan: JSONValue, draftID: UUID) async throws -> NativeRenderedMedia? {
        let selected = Set(plan["block"]?["selectedMedia"]?.array.compactMap(\.string) ?? [])
        guard !selected.isEmpty else { return nil }
        let workspace = try NativeMediaWorkspace(container: container, purpose: "render-inputs")
        defer { workspace.discard() }
        let directory = workspace.directory
        let retainedDirectory = container.appendingPathComponent("renders").appendingPathComponent(draftID.uuidString).appendingPathComponent(UUID().uuidString)
        var media: [NativeStagedMedia] = [], probes: [String: JSONValue] = [:]
        for asset in CaptureMediaTree.media(in: plan) {
            guard let ref = asset["ref"]?.string, selected.contains(ref), let originalKind = asset["kind"]?.string,
                  let originalAddress = asset["url"]?.string else { continue }
            let frame = plan["block"]?["frameMedia"]?.array.first { $0["ref"]?.string == ref }
            let kind = frame == nil ? originalKind : "image"
            let address = frame?["url"]?.string ?? originalAddress
            if kind == "video", case .number(let duration) = asset["durationSeconds"], duration > 600 {
                throw CaptureError.message("This video exceeds the 10-minute composition limit. Choose its Frame or capture text instead.")
            }
            try Task.checkCancellation()
            let sources = try decode(await runtime.mediaSources(address))
            guard let resolved = sources["url"]?.string, let url = URL(string: resolved) else { throw CaptureError.message("Couldn't load the media link.") }
            let audioURL: URL?
            if let audio = sources["audioURL"]?.string {
                guard let parsed = URL(string: audio) else { throw CaptureError.message("Couldn't load the audio link.") }
                audioURL = parsed
            } else { audioURL = nil }
            let staged = try await NativeMediaRenderer.stage(ref: ref, kind: kind, source: url, directory: directory, audioSource: audioURL)
            media.append(staged)
            if frame == nil, asset["acquisition"]?.string == "substack-public-original" {
                guard case .number(let duration) = asset["durationSeconds"] else { throw CaptureError.message("The original media has no verified duration.") }
                try NativeMediaRenderer.verifyOriginalDuration(expected: duration, actual: staged.duration)
            }
            probes[ref] = .object(["width": .number(staged.width), "height": .number(staged.height), "duration": .number(staged.duration), "fps": .number(staged.fps), "audio": .bool(staged.hasAudio)])
        }
        guard media.count == selected.count else { throw CaptureError.message("Some selected media could not be prepared. No block was created.") }
        if plan["block"]?["kind"]?.string == "audio" {
            guard media.count == 1, let audio = media.first else { throw CaptureError.message("Capture one original audio attachment alone.") }
            let result = try NativeMediaRenderer.originalAudio(audio, directory: directory)
            try Task.checkCancellation()
            return try workspace.promote(result, to: retainedDirectory)
        }
        let recipe = try decode(runtime.renderRecipe(planJSON: json(plan), probesJSON: json(.object(probes))))
        let result = try await NativeMediaRenderer.render(recipe: NativeMediaRecipe(json: recipe), media: media, directory: directory)
        try Task.checkCancellation()
        return try workspace.promote(result, to: retainedDirectory)
    }

    /// Optional, image-only preview of the current selected composition. It is
    /// never stored on the draft or reused by the durable Save path.
    func previewComposition(plan: JSONValue, draftID: UUID) async throws -> NativeMediaPreview {
        let selected = Set(plan["block"]?["selectedMedia"]?.array.compactMap(\.string) ?? [])
        guard !selected.isEmpty else { throw CaptureError.message("Select media to preview.") }
        let assets = CaptureMediaTree.media(in: plan)
            .filter { selected.contains($0["ref"]?.string ?? "") }
        guard assets.count == selected.count else { throw CaptureError.message("The selected media is not ready for preview.") }
        let frames = plan["block"]?["frameMedia"]?.array ?? []
        guard assets.allSatisfy({ asset in
            asset["kind"]?.string == "image" || frames.contains { $0["ref"]?.string == asset["ref"]?.string && $0["url"]?.string != nil }
        }) else {
            throw CaptureError.message("Choose Frame to preview this video.")
        }
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] != nil,
           let delay = Int(ProcessInfo.processInfo.environment["CAPTURE_UI_PREVIEW_DELAY_MS"] ?? ""),
           (1...5_000).contains(delay) { try await Task.sleep(for: .milliseconds(delay)) }
        #endif

        let workspace = try NativeMediaWorkspace(container: container, purpose: "composition-preview")
        let directory = workspace.directory
        var stagedFiles: [URL] = []
        var completed = false
        defer {
            if completed { for file in stagedFiles { try? FileManager.default.removeItem(at: file) } }
            else { workspace.discard() }
        }
        var media: [NativeStagedMedia] = [], probes: [String: JSONValue] = [:]
        for asset in assets {
            try Task.checkCancellation()
            guard let ref = asset["ref"]?.string else { throw CaptureError.message("A selected image is unavailable. Reload the source.") }
            let frame = frames.first { $0["ref"]?.string == ref }
            guard let address = (frame == nil ? asset["url"] : frame?["url"])?.string,
                  let originalURL = URL(string: address) else {
                throw CaptureError.message("No preview is available for a selected image.")
            }

            let sourceURL: URL
            #if DEBUG && targetEnvironment(simulator)
            if ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] == "video-frame", frame != nil {
                sourceURL = container.appendingPathComponent("fixture-0.jpg")
            } else if originalURL.isFileURL,
                      originalURL.standardizedFileURL.path.hasPrefix(container.standardizedFileURL.path + "/") {
                sourceURL = originalURL
            } else {
                let sources = try decode(await runtime.mediaSources(address))
                guard let resolved = sources["url"]?.string, let url = URL(string: resolved) else {
                    throw CaptureError.message("Couldn't load the image preview.")
                }
                sourceURL = url
            }
            #else
            let sources = try decode(await runtime.mediaSources(address))
            guard let resolved = sources["url"]?.string, let url = URL(string: resolved) else {
                throw CaptureError.message("Couldn't load the image preview.")
            }
            sourceURL = url
            #endif

            let staged: NativeStagedMedia
            #if DEBUG && targetEnvironment(simulator)
            if sourceURL.isFileURL {
                guard ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] != nil,
                      sourceURL.standardizedFileURL.path.hasPrefix(container.standardizedFileURL.path + "/") else {
                    throw CaptureError.message("The image preview needs an HTTPS link.")
                }
                guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                    throw CaptureError.message("A selected preview image could not be read.")
                }
                staged = NativeStagedMedia(ref: ref, kind: "image", fileURL: sourceURL,
                                           width: Double(image.width), height: Double(image.height))
            } else {
                staged = try await NativeMediaRenderer.stage(ref: ref, kind: "image", source: sourceURL, directory: directory)
                stagedFiles.append(staged.fileURL)
            }
            #else
            staged = try await NativeMediaRenderer.stage(ref: ref, kind: "image", source: sourceURL, directory: directory)
            stagedFiles.append(staged.fileURL)
            #endif
            media.append(staged)
            probes[ref] = .object(["width": .number(staged.width), "height": .number(staged.height),
                                   "duration": .number(0), "fps": .number(0), "audio": .bool(false)])
        }
        let recipe = try decode(runtime.renderRecipe(planJSON: json(plan), probesJSON: json(.object(probes))))
        let layout = try NativeMediaRecipe(json: recipe)
        guard layout.kind != "video" else {
            throw CaptureError.message("Choose Frame to preview this video.")
        }
        let rendered = try await NativeMediaRenderer.render(recipe: layout, media: media, directory: directory)
        try Task.checkCancellation()
        completed = true
        return NativeMediaPreview(fileURL: rendered.fileURL, workspace: workspace)
    }

    private func decode(_ value: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) }
    private func json(_ value: JSONValue) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
}
