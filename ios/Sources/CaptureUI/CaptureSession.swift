#if os(iOS)
import CaptureCore
import CaptureRuntime
import CryptoKit
import LinkPresentation
import Observation
#if DEBUG
import OSLog
#endif
import SwiftUI
#if DEBUG && targetEnvironment(simulator)
import UIKit
#endif

@MainActor @Observable
public final class CaptureSession {
    public private(set) var account: Account?
    var draft: CaptureDraft?
    var retainedResult: CaptureDraft?
    var preview: CapturePreview? { didSet { generatedDescription = nil } }
    @ObservationIgnored private var generatedDescription: String?
    /// The last canonical replacement shown in the editable source field.
    var cleanedSourceURL: String?
    var defaultChannel: Channel?
    var defaultPolicy = DefaultChannelPolicy()
    var recent: [Channel] = []
    var cached: [Channel] = []
    var problem: String?
    var progress = ""
    var automaticPaste = false
    var autoFrameThresholdSeconds = 600
    var incomingLinks: [String] = []
    public private(set) var receivingShareInput = false
    var busy = false
    var deliveryRevision = 0
    var transferRevision = 0
    private var foregroundAdmission = CaptureForegroundAdmission()
    public var foregroundWorkTicket: CaptureForegroundAdmission.Ticket? { foregroundAdmission.ticket }
    public func allowsForegroundWork(_ ticket: CaptureForegroundAdmission.Ticket) -> Bool { foregroundAdmission.allows(ticket) }
    public func holdForegroundForStorageReport() { foregroundAdmission.hold() }

    public var scheduleRecovery: (() -> Void)?
    public var beginSubmission: (() -> Void)?
    public var startContinuedProcessing: ((UUID) -> Void)?
    public var cancelContinuedProcessing: ((UUID) -> Void)?
    public var deliveryDidChange: (() -> Void)?
    public var hasPendingDeliveries: Bool {
        (try? delivery.hasPendingWork()) ?? true
    }
    private var isPreviewFixture = false
    /// Recomposition fixtures need the observed source payload after the
    /// editable preview is invalidated by an option change.
    private var fixtureMultiPostSeed: CapturePreview?
    let store: CaptureStore

    public func releaseStoreForSuspension() {
        let released = store.releaseIdleConnection()
        #if DEBUG
        logLockState(released ? "storeReleasedForSuspension" : "storeReleaseDeferred")
        #endif
    }

    #if DEBUG
    private let lockLog = Logger(subsystem: "net.fjpaz.arena-capture", category: "sqlite-lifecycle")
    func logLockState(_ event: String) {
        guard ProcessInfo.processInfo.environment["CAPTURE_LOCK_PROBE"] == "1" else { return }
        let state = store.diagnosticLockSnapshot()
        lockLog.notice("\(event, privacy: .public) open=\(state.isOpen, privacy: .public) txn=\(state.transactionState, privacy: .public) autocommit=\(state.autocommit, privacy: .public) statements=\(state.preparedStatements, privacy: .public) mainLock=\(state.mainFileLockState ?? -1, privacy: .public)")
    }
    #endif
    let credentials: CredentialStore
    let defaults: UserDefaults
    let container: URL
    private let workspaceID: String
    private let freshShare: Bool
    private let shareInvocationID = UUID()
    private var shareAccounts = Set<Int>()
    private var sharePendingIDs = Set<UUID>()
    private var sharePresentationClosed = false
    private let isMainApplication: Bool
    private let allowsLegacyWorkspaceMigration: Bool
    private let initialDefaultMode: DefaultChannelMode
    private let initialDefaultChannelID: Int?
    private let initialDefaultAccountID: Int?
    private let initialReplacedDefaultChannelID: Int?
    private var runtime: CaptureRuntime?
    private var delivery: CaptureDelivery!
    let clientID: String
    let callbackScheme: String
    var api: ArenaAPI?
    private var resolution: Task<Void, Never>?
    private var generation = UUID()
    private let resolvedSources = ResolvedSourceCache()
    private let expandedSources = ResolvedSourceCache()
    private var renderedSources: [String: String] = [:]
    private var renderedIdentity: String?
    private var quoteSourceIdentity: String?
    private var expandedQuotes = false
    private var previousQuoteDepth: CaptureQuoteDepth?
    private var placementReturnDraft: CaptureDraft?
    private var placementBaseline: DestinationSelection?
    var isAddingPlacements: Bool { placementReturnDraft != nil }
    private var historyReturnDraft: CaptureDraft?
    var isResumingHistory: Bool { historyReturnDraft != nil }

    public init(bundle: Bundle = .main, freshShare: Bool = false) throws {
        #if DEBUG && targetEnvironment(simulator)
        let freshShare = freshShare || ProcessInfo.processInfo.environment["CAPTURE_UI_FRESH_SHARE"] == "1"
        #endif
        self.freshShare = freshShare
        receivingShareInput = freshShare
        #if DEBUG && targetEnvironment(simulator)
        let separateFixtureComposer = ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] != nil && ProcessInfo.processInfo.environment["CAPTURE_UI_COMPOSER"] == "share"
        #else
        let separateFixtureComposer = false
        #endif
        workspaceID = (bundle.bundleIdentifier ?? "capture") + (separateFixtureComposer ? ".fixture-share" : "")
        isMainApplication = bundle.object(forInfoDictionaryKey: "NSExtension") == nil
        allowsLegacyWorkspaceMigration = !separateFixtureComposer && isMainApplication
        initialDefaultMode = DefaultChannelMode(rawValue: bundle.object(forInfoDictionaryKey: "CaptureDefaultChannelMode") as? String ?? "fallback") ?? .fallback
        initialDefaultChannelID = (bundle.object(forInfoDictionaryKey: "CaptureInitialDefaultChannelID") as? String).flatMap(Int.init)
        initialDefaultAccountID = (bundle.object(forInfoDictionaryKey: "CaptureInitialDefaultAccountID") as? String).flatMap(Int.init)
        initialReplacedDefaultChannelID = (bundle.object(forInfoDictionaryKey: "CaptureReplaceDefaultChannelID") as? String).flatMap(Int.init)
        #if DEBUG && targetEnvironment(simulator)
        if let mode = ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] {
            if let clipboard = ProcessInfo.processInfo.environment["CAPTURE_UI_CLIPBOARD"] {
                UIPasteboard.general.string = clipboard
            }
            if let clipboard = ProcessInfo.processInfo.environment["CAPTURE_UI_CLIPBOARD_URL"], !clipboard.isEmpty,
               let url = URL(string: clipboard) {
                UIPasteboard.general.url = url
            }
            let directory: URL
            if let name = ProcessInfo.processInfo.environment["CAPTURE_UI_STORE_ID"], let id = UUID(uuidString: name) {
                directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    .appendingPathComponent("CaptureUIFixtures").appendingPathComponent(id.uuidString)
            } else { directory = FileManager.default.temporaryDirectory.appendingPathComponent("capture-ui-" + UUID().uuidString) }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let fixture = try PreviewFixtures(mode: mode, directory: directory)
            isPreviewFixture = true
            if mode == "multi-post-extra" { fixtureMultiPostSeed = fixture.preview }
            container = directory
            defaults = UserDefaults(suiteName: directory.lastPathComponent)!
            automaticPaste = defaults.bool(forKey: "automaticPaste.\(fixture.account.id)")
            autoFrameThresholdSeconds = defaults.object(forKey: "autoFrameThreshold.\(fixture.account.id)") as? Int ?? 600
            credentials = CredentialStore(accessGroup: nil)
            clientID = ""; callbackScheme = "capture-fixture"
            store = try CaptureStore(url: directory.appendingPathComponent("capture.sqlite"))
            account = fixture.account; api = fixture.api()
            if try store.value(Account.self, account: 0, kind: "account", id: "fixture") == nil {
                try store.transaction {
                    try store.save(fixture.account, account: 0, kind: "account", id: "fixture")
                    if mode != "no-default" { try store.save(fixture.channels[0], account: fixture.account.id, kind: "default", id: "default") }
                    if mode == "always-default" { try store.save(DefaultChannelPolicy(mode: .always), account: fixture.account.id, kind: "defaultPolicy", id: "default") }
                    for channel in fixture.channels {
                        try store.save(channel, account: fixture.account.id, kind: "channel", id: String(channel.id))
                    }
                }
            }
            defaultChannel = try store.values(Channel.self, account: fixture.account.id, kind: "default", limit: 1).first
            defaultPolicy = try store.value(DefaultChannelPolicy.self, account: fixture.account.id, kind: "defaultPolicy", id: "default") ?? .init()
            recent = fixture.channels; cached = fixture.channels
            let workspace = try store.value(CaptureWorkspace.self, account: fixture.account.id, kind: "workspace", id: workspaceID)
            // A workspace with no active draft is an intentional empty composer.
            // Reopening it must not seed the fixture capture again.
            if freshShare {
                let opened = try store.startShareWorkspace(account: fixture.account.id, id: workspaceID, defaultChannel: defaultChannel, invocationID: shareInvocationID)
                shareAccounts.insert(fixture.account.id)
                draft = opened.draft; preview = nil; retainedResult = nil
            } else if separateFixtureComposer || workspace != nil {
                let opened = try store.openWorkspace(account: fixture.account.id, id: workspaceID, defaultChannel: defaultChannel, migrateLegacy: false)
                draft = opened.draft; draft?.recoverAfterInterruption(); preview = draft?.previewSnapshot; retainedResult = opened.retainedResult
            } else {
                draft = fixture.draft; preview = ["empty", "bluesky-error", "reddit-denied"].contains(mode) ? nil : fixture.preview
                try store.save(fixture.history, account: fixture.account.id, kind: "draft", id: fixture.history.id.uuidString)
                try store.save(fixture.draft, account: fixture.account.id, kind: "draft", id: fixture.draft.id.uuidString)
                try store.save(CaptureWorkspace(activeDraftID: fixture.draft.id), account: fixture.account.id, kind: "workspace", id: workspaceID)
                if mode == "queued" {
                    let job = DeliveryJob(id: fixture.draft.id, draft: fixture.draft,
                                          prepared: .init(payload: [:], update: [:]), stage: .queued)
                    try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
                } else if mode == "reddit-denied" {
                    let job = DeliveryJob(id: fixture.draft.id, draft: fixture.draft,
                        prepared: .init(payload: [:], update: [:]), submission: try .init(draft: fixture.draft),
                        attemptedChannelIDs: [], resumeStage: .reading, stage: .attention, problem: fixture.draft.problem)
                    try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
                } else if mode == "connecting" {
                    let job = DeliveryJob(id: fixture.draft.id, draft: fixture.draft, prepared: .init(payload: [:], update: [:]),
                        attemptedChannelIDs: [101], contentVerified: true, stage: .connections, connected: [101], block: fixture.draft.savedBlock)
                    try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
                } else if mode == "partial" {
                    let job = DeliveryJob(id: fixture.draft.id, draft: fixture.draft, prepared: .init(payload: [:], update: [:]), resumeStage: .connections, contentVerified: true, stage: .attention, connected: [102], block: fixture.draft.savedBlock, problem: fixture.draft.problem)
                    try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
                } else if mode == "unknown" {
                    let job = DeliveryJob(id: fixture.draft.id, draft: fixture.draft, prepared: .init(payload: [:], update: [:]), stage: .attention, problem: fixture.draft.problem)
                    try store.save(job, account: 0, kind: "delivery", id: job.id.uuidString)
                    try store.save(fixture.draft.id, account: fixture.account.id, kind: "publicationLock", id: "offline-unknown-save")
                }
            }
            if !freshShare, let id = workspace?.retainedResultID {
                retainedResult = try store.value(CaptureDraft.self, account: fixture.account.id, kind: "draft", id: id.uuidString)
            }
            delivery = try CaptureDelivery(store: store, credentials: credentials, directory: directory.appendingPathComponent("delivery"), group: "capture-fixture", identifier: "capture-fixture", ingestBase: nil)
            try delivery.refreshPreparationFailures()
            refreshDelivery()
            if !freshShare { try restorePlacementEdit() }
            restoreInvalidSourceFailure()
            if let capture = ProcessInfo.processInfo.environment["CAPTURE_UI_REDDIT_CAPTURE"], !capture.isEmpty,
               draft?.redditCapturesJSON == nil { try receiveBrowserCapture(capture) }
            if freshShare, let outcome = ProcessInfo.processInfo.environment["CAPTURE_UI_SHARE_INTAKE"] {
                Task {
                    let delay = min(30_000, max(0, Int(ProcessInfo.processInfo.environment["CAPTURE_UI_SHARE_DELAY_MS"] ?? "1500") ?? 1500))
                    try? await Task.sleep(for: .milliseconds(delay))
                    guard !sharePresentationClosed else { return }
                    if outcome == "error" { reportInputFailure("Couldn’t read the shared link. Share the page again.") }
                    else if let value = ProcessInfo.processInfo.environment["CAPTURE_UI_SHARE_URL"], let url = URL(string: value) { receive(urls: [url]) }
                    finishReceivingShareInput()
                }
            }
            return
        }
        #endif
        guard let group = bundle.object(forInfoDictionaryKey: "CaptureAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let defaults = UserDefaults(suiteName: group) else {
            throw CaptureError.message("The shared app container is not configured. Check the signing entitlements for both targets.")
        }
        self.defaults = defaults
        self.container = container
        // Only explicitly owned temporary working copies are eligible. Legacy
        // renders, previews and every durable capture remain outside this sweep.
        NativeMediaWorkspace.prune(container: container)
        credentials = CredentialStore(accessGroup: bundle.object(forInfoDictionaryKey: "CaptureKeychainGroup") as? String)
        clientID = bundle.object(forInfoDictionaryKey: "ArenaOAuthClientID") as? String ?? ""
        callbackScheme = bundle.object(forInfoDictionaryKey: "CaptureCallbackScheme") as? String ?? "arena-capture"
        store = try CaptureStore(url: container.appendingPathComponent("capture.sqlite"))
        try reloadAccount()
        try refreshIncoming()
        delivery = try CaptureDelivery(store: store, credentials: credentials, directory: container.appendingPathComponent("delivery"), group: group, identifier: (bundle.bundleIdentifier ?? "capture") + ".delivery", ingestBase: bundle.object(forInfoDictionaryKey: "CaptureIngestBaseURL") as? String)
        delivery.changed = { [weak self] in self?.refreshDelivery() }
        delivery.progressChanged = { [weak self] in self?.refreshTransferProgress() }
        try delivery.refreshPreparationFailures()
        let initialForegroundTicket = foregroundWorkTicket
        Task {
            guard let ticket = initialForegroundTicket else { return }
            await configureInitialDefault(ifAdmitted: ticket)
            await resumeForegroundDelivery(ifAdmitted: ticket)
        }
    }

    func reloadAccount() throws {
        guard !sharePresentationClosed else { return }
        guard !isPreviewFixture else { return }
        let saved = try store.values(Account.self, account: 0, kind: "account", limit: 1).first
        if saved?.id != account?.id {
            placementReturnDraft = nil
            historyReturnDraft = nil
            resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
            resolution?.cancel(); generation = UUID()
        }
        if let saved, let token = try credentials.read("arena.\(saved.id)") {
            if freshShare && shareAccounts.contains(saved.id) {
                try store.requireShareInvocation(shareInvocationID, account: saved.id, workspaceID: workspaceID)
            }
            account = saved; api = ArenaAPI(token: token)
            defaultChannel = try store.values(Channel.self, account: saved.id, kind: "default", limit: 1).first
            let storedPolicy = try store.value(DefaultChannelPolicy.self, account: saved.id, kind: "defaultPolicy", id: "default")
            defaultPolicy = CaptureDefaultRoute.initialPolicy(stored: storedPolicy, initialMode: initialDefaultMode, configuredAccountID: initialDefaultAccountID)
            if storedPolicy == nil {
                if let defaultChannel, defaultChannel.visibility != "private" || defaultChannel.owner.id != saved.id || defaultChannel.owner.type != "User" { defaultPolicy.provenance = false }
            }
            recent = try store.values(Channel.self, account: saved.id, kind: "recent")
            cached = try store.values(Channel.self, account: saved.id, kind: "channel", limit: 500)
            automaticPaste = defaults.bool(forKey: "automaticPaste.\(saved.id)")
            autoFrameThresholdSeconds = defaults.object(forKey: "autoFrameThreshold.\(saved.id)") as? Int ?? 600
            if draft?.accountID != saved.id { draft = nil; preview = nil; retainedResult = nil }
            if let current = draft, !isAddingPlacements,
               try store.value(DeletedCapture.self, account: saved.id, kind: "deletedDraft", id: current.id.uuidString) != nil {
                resolution?.cancel(); generation = UUID(); draft = nil; preview = nil
            }
            if draft == nil {
                let workspace: CaptureWorkspaceContents
                if freshShare && !shareAccounts.contains(saved.id) {
                    workspace = try store.startShareWorkspace(account: saved.id, id: workspaceID, defaultChannel: defaultChannel, invocationID: shareInvocationID)
                    shareAccounts.insert(saved.id)
                } else {
                    workspace = try store.openWorkspace(account: saved.id, id: workspaceID, defaultChannel: defaultChannel, migrateLegacy: allowsLegacyWorkspaceMigration, shareInvocationID: freshShare ? shareInvocationID : nil)
                }
                draft = workspace.draft; retainedResult = workspace.retainedResult
                draft?.recoverAfterInterruption()
                preview = draft?.previewSnapshot
            }
            if !freshShare { try restorePlacementEdit() }
            restoreInvalidSourceFailure()
        } else { account = nil; api = nil; draft = nil; preview = nil; retainedResult = nil; recent = []; cached = []; defaultChannel = nil; defaultPolicy = DefaultChannelPolicy(); autoFrameThresholdSeconds = 600 }
    }

    func connect(token: String) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        let foregroundTicket = foregroundWorkTicket
        do {
            let cleaned = token.trimmingCharacters(in: .whitespacesAndNewlines)
            let identity = try await ArenaAPI(token: cleaned).me()
            try credentials.write(cleaned, key: "arena.\(identity.id)")
            try store.save(identity, account: 0, kind: "account", id: "current")
            try reloadAccount()
            problem = nil
            guard let ticket = foregroundTicket, allowsForegroundWork(ticket) else { return }
            await configureInitialDefault(ifAdmitted: ticket)
            guard allowsForegroundWork(ticket) else { return }
            try refreshIncoming()
            for id in try store.recordIDs(account: 0, kind: "delivery") {
                guard let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id), job.draft.accountID == identity.id, job.stage == .attention, job.problem?.hasPrefix("Reconnect") == true else { continue }
                guard allowsForegroundWork(ticket) else { return }
                await delivery.retry(job.id)
            }
            await resumeForegroundDelivery(ifAdmitted: ticket)
            guard allowsForegroundWork(ticket) else { return }
            if incomingLinks.count == 1 {
                busy = false
                useIncoming(incomingLinks[0])
            }
        } catch { problem = error.localizedDescription }
    }

    func disconnect() {
        do {
            guard let account else { return }
            resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
            resolution?.cancel(); generation = UUID()
            try credentials.remove("arena.\(account.id)")
            try store.remove(account: 0, kind: "account", id: "current")
            try reloadAccount()
        } catch { problem = error.localizedDescription }
    }

    func setDefault(_ channel: Channel, seededPolicy: DefaultChannelPolicy? = nil) throws {
        guard !sharePresentationClosed else { throw CancellationError() }
        guard let account, channel.can?.addTo == true else { throw CaptureError.message("Choose a channel you can add to.") }
        var policy = seededPolicy ?? defaultPolicy
        if channel.visibility != "private" || channel.owner.id != account.id || channel.owner.type != "User" { policy.provenance = false }
        if let draft, [.editing, .preparing, .ready, .failed].contains(draft.phase), !draft.selection.implicitDefault {
            _ = try CaptureDefaultRoute.destinations(draft.selection, defaultChannel: channel, mode: policy.mode)
        }
        try store.transaction {
            try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: account.id, workspaceID: workspaceID)
            try store.save(channel, account: account.id, kind: "default", id: "default")
            try store.save(policy, account: account.id, kind: "defaultPolicy", id: "default")
            try store.save(true, account: account.id, kind: "defaultSeedApplied", id: "default")
        }
        defaultPolicy = policy
        let firstDefault = defaultChannel == nil
        defaultChannel = channel
        if [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved), draft?.selection.implicitDefault == true || (draft?.selection.channels.isEmpty == true && firstDefault) {
            draft?.selection = DestinationSelection(defaultChannel: channel)
            try persist()
        }
    }

    private func configureInitialDefault(ifAdmitted ticket: CaptureForegroundAdmission.Ticket) async {
        guard allowsForegroundWork(ticket), !sharePresentationClosed, !isPreviewFixture, let account, account.id == initialDefaultAccountID,
              let identifier = initialDefaultChannelID, identifier > 0, let api else { return }
        do {
            let configured = try store.value(Bool.self, account: account.id, kind: "defaultSeedApplied", id: "default") == true
            guard CaptureDefaultRoute.shouldApplyInitialDefault(accountID: account.id, configuredAccountID: initialDefaultAccountID,
                                                               targetChannelID: identifier, replacingChannelID: initialReplacedDefaultChannelID,
                                                               currentDefaultID: defaultChannel?.id, alreadyConfigured: configured) else { return }
            let current = try await api.me()
            guard allowsForegroundWork(ticket) else { return }
            guard current.id == account.id else { throw CaptureError.message("The configured default belongs to a different account.") }
            let channel = try CaptureDefaultRoute.verifiedProvenanceChannel(try await api.channel(String(identifier)), accountID: account.id, expectedChannelID: identifier)
            guard allowsForegroundWork(ticket) else { return }
            let nowConfigured = try store.value(Bool.self, account: account.id, kind: "defaultSeedApplied", id: "default") == true
            guard !sharePresentationClosed, self.account?.id == account.id,
                  CaptureDefaultRoute.shouldApplyInitialDefault(accountID: account.id, configuredAccountID: initialDefaultAccountID,
                                                               targetChannelID: identifier, replacingChannelID: initialReplacedDefaultChannelID,
                                                               currentDefaultID: defaultChannel?.id, alreadyConfigured: nowConfigured) else { return }
            let storedPolicy = try store.value(DefaultChannelPolicy.self, account: account.id, kind: "defaultPolicy", id: "default")
            try setDefault(channel, seededPolicy: storedPolicy == nil ? DefaultChannelPolicy(mode: initialDefaultMode) : nil)
        } catch {
            guard allowsForegroundWork(ticket) else { return }
            problem = "Couldn't load the default channel. Choose one in Settings. " + error.localizedDescription
        }
    }

    func remember(_ channels: [Channel]) throws {
        guard let account else { return }
        try store.transaction {
            for channel in channels { try store.save(channel, account: account.id, kind: "channel", id: String(channel.id)) }
            try store.prune(account: account.id, kind: "channel", keeping: 500)
        }
        cached = try store.values(Channel.self, account: account.id, kind: "channel", limit: 500)
    }

    var actualDestinations: [Channel] {
        guard let draft else { return [] }
        if isAddingPlacements || [.queued, .creating, .checking, .uncertain, .saved].contains(draft.phase) { return draft.selection.channels }
        return (try? CaptureDefaultRoute.destinations(draft.selection, defaultChannel: defaultChannel, mode: defaultPolicy.mode)) ?? []
    }

    var soundCloudMediaServiceAddress: String { defaults.string(forKey: "soundCloudMediaService") ?? "" }

    func setSoundCloudMediaService(address: String, token: String) throws {
        let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if address.isEmpty {
            try credentials.remove("soundcloud-media-service")
            defaults.removeObject(forKey: "soundCloudMediaService")
        } else {
            guard let endpoint = URL(string: address) else { throw CaptureError.message("Enter an HTTPS media service address.") }
            if address != soundCloudMediaServiceAddress && token.isEmpty {
                throw CaptureError.message("Enter the access token for this media service.")
            }
            let storedToken = try credentials.read("soundcloud-media-service")
            let accessToken = token.isEmpty ? storedToken ?? "" : token
            _ = try SoundCloudAudioService(endpoint: endpoint, token: accessToken)
            try credentials.write(accessToken, key: "soundcloud-media-service")
            defaults.set(address, forKey: "soundCloudMediaService")
        }
        defaults.synchronize()
    }

    func setDefaultMode(_ mode: DefaultChannelMode) throws {
        guard let account else { return }
        if mode == .always, let draft, let defaultChannel { _ = try CaptureDefaultRoute.destinations(draft.selection, defaultChannel: defaultChannel, mode: mode) }
        var policy = defaultPolicy; policy.mode = mode
        try store.save(policy, account: account.id, kind: "defaultPolicy", id: "default")
        defaultPolicy = policy
    }

    func setDefaultProvenance(_ enabled: Bool) throws {
        guard let account else { return }
        if enabled {
            guard let defaultChannel else { throw CaptureError.message("Choose a default channel first.") }
            _ = try CaptureDefaultRoute.verifiedProvenanceChannel(defaultChannel, accountID: account.id, expectedChannelID: defaultChannel.id)
        }
        var policy = defaultPolicy; policy.provenance = enabled
        try store.save(policy, account: account.id, kind: "defaultPolicy", id: "default")
        defaultPolicy = policy
    }

    func toggle(_ channel: Channel) {
        guard !busy, [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        guard !isAddingPlacements || !draft!.selection.contains(channel) || canRemovePlacement(channel) else { return }
        let reservesDefault = !isAddingPlacements && defaultPolicy.mode == .always && defaultChannel != nil
            && draft?.selection.channels.contains(where: { $0.id == defaultChannel?.id }) != true && channel.id != defaultChannel?.id
        if isAddingPlacements {
            guard draft?.selection.contains(channel) == true || canAddDestination(channel) else { return }
            draft?.selection.toggle(channel, maxCount: Int.max)
        } else { draft?.selection.toggle(channel, maxCount: reservesDefault ? 19 : 20) }
        persistOrReport()
    }

    func resetDestinations() {
        guard !busy, [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        if isAddingPlacements { resetPendingPlacements(); return }
        draft?.selection = DestinationSelection(defaultChannel: defaultChannel)
        persistOrReport()
    }

    func clearDestinations() {
        guard !busy, [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        if isAddingPlacements { resetPendingPlacements(); return }
        draft?.selection = DestinationSelection(defaultChannel: nil)
        persistOrReport()
    }

    func hasDurableSubmission(_ id: UUID) -> Bool {
        if (try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: id.uuidString)) != nil { return true }
        guard let account else { return false }
        return (try? store.value(CaptureDraft.self, account: account.id, kind: "draft", id: id.uuidString))?.phase == .saved
    }

    var canSaveToDestinations: Bool { !actualDestinations.isEmpty }

    func canAddDestination(_ channel: Channel) -> Bool {
        guard let draft else { return false }
        if draft.selection.contains(channel) { return true }
        if isAddingPlacements {
            let baseline = Set(placementBaseline?.channels.map(\.id) ?? [])
            return Set(draft.selection.channels.map(\.id)).subtracting(baseline).count < 20
        }
        if draft.selection.implicitDefault { return true }
        let reservesDefault = !isAddingPlacements && defaultPolicy.mode == .always && defaultChannel != nil
            && !draft.selection.channels.contains(where: { $0.id == defaultChannel?.id }) && channel.id != defaultChannel?.id
        return draft.selection.channels.count < (reservesDefault ? 19 : 20)
    }

    func canRemovePlacement(_ channel: Channel) -> Bool {
        guard isAddingPlacements, let draft else { return true }
        return (try? delivery.protectedPlacementIDs(draft.id, account: draft.accountID).contains(channel.id)) == false
    }

    private func resetPendingPlacements() {
        guard let current = draft else { return }
        let protected = (try? delivery.protectedPlacementIDs(current.id, account: current.accountID)) ?? Set(current.selection.channels.map(\.id))
        var selection = DestinationSelection(defaultChannel: nil)
        for channel in current.selection.channels where protected.contains(channel.id) { selection.toggle(channel, maxCount: Int.max) }
        draft?.selection = selection
        persistOrReport()
    }

    func persist(allowReopenUnknown: Bool = false) throws {
        guard !sharePresentationClosed else { return }
        if isAddingPlacements, let draft {
            try store.transaction {
                try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: draft.accountID, workspaceID: workspaceID)
                try store.save(CapturePlacementEdit(captureID: draft.id, selection: draft.selection, baseline: placementBaseline), account: draft.accountID, kind: "placementEdit", id: workspaceID)
            }
            return
        }
        guard var value = draft else { return }
        try store.transaction {
            try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: value.accountID, workspaceID: workspaceID)
            guard try store.value(DeletedCapture.self, account: value.accountID, kind: "deletedDraft", id: value.id.uuidString) == nil else {
                throw CaptureError.message("This draft was deleted. Start a new capture.")
            }
            if let existing = try store.value(CaptureDraft.self, account: value.accountID, kind: "draft", id: value.id.uuidString),
               existing.isCanceled || ([.queued, .creating, .checking, .uncertain, .saved].contains(existing.phase) && !allowReopenUnknown) {
                value = existing
                if value.phase == .creating { value.recoverAfterInterruption() }
            } else if value.hasDraftContent {
                value.updatedAt = Date()
                try store.save(value, account: value.accountID, kind: "draft", id: value.id.uuidString)
            } else {
                try store.remove(account: value.accountID, kind: "draft", id: value.id.uuidString)
            }
            var workspace = try store.value(CaptureWorkspace.self, account: value.accountID, kind: "workspace", id: workspaceID) ?? CaptureWorkspace()
            workspace.activeDraftID = value.hasDraftContent ? value.id : nil
            workspace.emptySelection = value.hasDraftContent ? nil : value.selection
            try store.save(workspace, account: value.accountID, kind: "workspace", id: workspaceID)
        }
        draft = value
        if [.queued, .creating, .checking, .uncertain, .saved].contains(value.phase) { preview = value.previewSnapshot }
    }
    func persistOrReport(allowReopenUnknown: Bool = false) {
        do { try persist(allowReopenUnknown: allowReopenUnknown) }
        catch { problem = error.localizedDescription }
    }

    func setInput(_ text: String, keepingExpansion: Bool = false, keepingRoles: Bool = false,
                  preservingChoices: Bool = false) {
        guard !busy, draft?.blockID == nil, [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        // Paste/share intake can be cleaned as a whole. Keep in-progress row
        // edits intact so typing a query does not move its text into the path.
        let text = preservingChoices ? text : CaptureInput.canonicalSourceText(text)
        let startingEmpty = draft?.hasDraftContent == false
        cleanedSourceURL = nil
        draft?.renderPath = nil; draft?.previewSnapshot = nil
        if !preservingChoices {
            draft?.titleOverride = nil; draft?.descriptionOverride = nil
            draft?.selectedMedia = nil; draft?.videoFrames = nil; draft?.audio = nil; draft?.quoteDepth = nil
            draft?.pendingMediaChoices = nil
        }
        if !keepingExpansion {
            let oldIdentity = draft.flatMap { Self.singleThreadSourceIdentity($0.input, roles: $0.sourceRoles) }
            let newIdentity = Self.singleThreadSourceIdentity(text, roles: keepingRoles ? draft?.sourceRoles : nil)
            // Keep the reviewed scope while editing the same source. Forum
            // comments start with ancestors only; broader replies are opt-in.
            let currentExpansion = draft?.threadExpansion
            if let newIdentity {
                let initial = Self.defaultThreadExpansion(for: newIdentity)
                draft?.threadExpansion = newIdentity == oldIdentity ? (currentExpansion ?? initial) : initial
            } else { draft?.threadExpansion = nil }
        }
        if !keepingRoles { draft?.sourceRoles = nil }
        if startingEmpty { draft?.videoFrameThresholdSeconds = autoFrameThresholdSeconds }
        if !preservingChoices, draft?.media == .selected { draft?.media = .auto }
        resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
        quoteSourceIdentity = nil; expandedQuotes = false
        if let captured = draft?.redditCapturesJSON,
           let values = try? JSONSerialization.jsonObject(with: Data(captured.utf8)) as? [[String: Any]] {
            let identities = Set(CaptureInput.urls(in: text).map(CaptureInput.canonicalSourceIdentity))
            let kept = values.filter { value in
                guard let source = value["sourceUrl"] as? String, let url = URL(string: source) else { return false }
                return identities.contains(CaptureInput.canonicalSourceIdentity(url))
            }
            draft?.redditCapturesJSON = kept.isEmpty ? nil : (try? JSONSerialization.data(withJSONObject: kept)).map { String(decoding: $0, as: UTF8.self) }
        }
        if let captured = draft?.substackCapturesJSON,
           let values = try? JSONSerialization.jsonObject(with: Data(captured.utf8)) as? [[String: Any]] {
            let identities = Set(CaptureInput.urls(in: text).map(CaptureInput.canonicalSourceIdentity))
            let kept = values.filter { value in
                guard let source = value["sourceUrl"] as? String, let url = URL(string: source) else { return false }
                return identities.contains(CaptureInput.canonicalSourceIdentity(url))
            }
            draft?.substackCapturesJSON = kept.isEmpty ? nil : (try? JSONSerialization.data(withJSONObject: kept)).map { String(decoding: $0, as: UTF8.self) }
        }
        draft?.input = text; draft?.originalLinkOnly = nil; preview = nil; draft?.phase = .editing; draft?.problem = nil
        persistOrReport(); resolve()
    }

    /// Configuration changes keep authored writing and media choices. Capture
    /// asset identities before positional refs can move during expansion.
    private func retainMediaChoicesForSourceOptions() -> Bool {
        guard let current = draft, current.pendingMediaChoices == nil else { return true }
        guard current.media == .selected || current.videoFrames?.isEmpty == false || current.audio.map({ !["auto", "mix"].contains($0) }) == true else { return true }
        guard let oldPreview = preview ?? current.previewSnapshot else {
            problem = "Load the source before changing media options."
            return false
        }
        do {
            draft?.pendingMediaChoices = try CaptureMediaChoiceAnchors.capture(
                preview: oldPreview,
                selected: current.media == .selected ? current.selectedMedia ?? [] : nil,
                frames: current.videoFrames, audio: current.audio)
            return true
        } catch { problem = error.localizedDescription; return false }
    }

    private func policyForResolvedSources(_ sources: JSONValue) throws -> JSONValue {
        guard let draft else { throw CaptureError.message("The capture is no longer available.") }
        return try draft.pendingMediaChoices?.applying(to: draft.compositionPolicy, sources: sources) ?? draft.compositionPolicy
    }

    private func acceptRemappedMediaChoices(_ policy: JSONValue) {
        guard draft?.pendingMediaChoices != nil else { return }
        if draft?.media == .selected { draft?.selectedMedia = policy["selectedMedia"]?.array.compactMap(\.string) ?? [] }
        draft?.videoFrames = policy["videoFrames"]?.array.compactMap(\.string)
        draft?.audio = policy["audio"]?.string
        draft?.pendingMediaChoices = nil
    }

    /// Older builds stored text-only clipboard intake as a failed source read.
    /// Keep the person's draft text, but remove the retry state: no URL was read.
    private func restoreInvalidSourceFailure() {
        guard let current = draft, current.phase == .failed, current.blockID == nil,
              current.deliveryState == nil,
              (try? CaptureInput.selectedPosts(current.input, roles: current.sourceRoles)) == nil else { return }
        draft?.phase = .editing; draft?.problem = nil; draft?.previewSnapshot = nil; draft?.renderPath = nil
        preview = nil
        persistOrReport()
    }

    var sourceRows: [String] { draft?.input.components(separatedBy: "\n") ?? [""] }

    func sourceRole(at index: Int) -> CaptureSourceRole {
        guard let roles = draft?.sourceRoles, roles.indices.contains(index) else { return .primary }
        return roles[index]
    }

    func setSourceRole(at index: Int, to role: CaptureSourceRole) {
        guard let current = draft, sourceRows.indices.contains(index), !busy, current.blockID == nil,
              [.editing, .preparing, .ready, .failed].contains(current.phase) else { return }
        var roles = sourceRows.indices.map(sourceRole(at:))
        guard roles[index] != role else { return }
        guard retainMediaChoicesForSourceOptions() else { return }
        roles[index] = role
        draft?.sourceRoles = roles
        setInput(current.input, keepingExpansion: true, keepingRoles: true, preservingChoices: true)
    }

    var canExpandAtprotoThread: Bool {
        guard let draft, let posts = try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles),
              posts.primary.count == 1 else { return false }
        return CaptureInput.isAtprotoPost(posts.primary[0])
    }

    var canImportLinearThread: Bool {
        guard let draft, let posts = try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles),
              posts.primary.count == 1 else { return false }
        let identity = CaptureInput.canonicalSourceIdentity(posts.primary[0])
        return identity.hasPrefix("x:") || identity.hasPrefix("substack:")
    }

    var canExpandForumMagnumComment: Bool {
        guard let draft, let posts = try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles),
              posts.primary.count == 1 else { return false }
        return CaptureInput.isForumMagnumComment(posts.primary[0])
    }

    private static func defaultThreadExpansion(for identity: String) -> CaptureThreadExpansion {
        identity.hasPrefix("forum-magnum:") ? .auto : identity.hasPrefix("substack:") ? .off : .on
    }

    private static func singleThreadSourceIdentity(_ input: String, roles: [CaptureSourceRole]?) -> String? {
        guard let posts = try? CaptureInput.selectedPosts(input, roles: roles), posts.primary.count == 1 else { return nil }
        let identity = CaptureInput.canonicalSourceIdentity(posts.primary[0])
        return ["x:", "bluesky:", "delve:", "forum-magnum:", "substack:"].contains(where: identity.hasPrefix) ? identity : nil
    }

    var importsLinearThread: Bool { draft?.threadExpansion == .on }

    func setLinearThreadImport(_ enabled: Bool) {
        guard canImportLinearThread, let current = draft, !busy, current.blockID == nil,
              [.editing, .preparing, .ready, .failed].contains(current.phase) else { return }
        let mode: CaptureThreadExpansion = enabled ? .on : .off
        guard current.threadExpansion != mode else { return }
        guard retainMediaChoicesForSourceOptions() else { return }
        draft?.threadExpansion = mode
        setInput(current.input, keepingExpansion: true, keepingRoles: true, preservingChoices: true)
    }

    var expandsAtprotoThread: Bool { draft?.threadExpansion != .off }

    func setAtprotoThreadExpansion(_ enabled: Bool) {
        guard canExpandAtprotoThread, let current = draft, !busy, current.blockID == nil,
              [.editing, .preparing, .ready, .failed].contains(current.phase) else { return }
        let mode: CaptureThreadExpansion = enabled ? .on : .off
        guard current.threadExpansion != mode else { return }
        guard retainMediaChoicesForSourceOptions() else { return }
        draft?.threadExpansion = mode
        setInput(current.input, keepingExpansion: true, keepingRoles: true, preservingChoices: true)
    }

    var forumMagnumExpansion: CaptureThreadExpansion { draft?.threadExpansion ?? .auto }

    func setForumMagnumExpansion(_ mode: CaptureThreadExpansion) {
        guard canExpandForumMagnumComment, let current = draft, !busy, current.blockID == nil,
              [.editing, .preparing, .ready, .failed].contains(current.phase) else { return }
        guard forumMagnumExpansion != mode else { return }
        guard retainMediaChoicesForSourceOptions() else { return }
        draft?.threadExpansion = mode
        setInput(current.input, keepingExpansion: true, keepingRoles: true, preservingChoices: true)
    }

    func replaceSource(at index: Int, with text: String) {
        var rows = sourceRows
        guard rows.indices.contains(index), !busy, draft?.blockID == nil,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved),
              retainMediaChoicesForSourceOptions() else { return }
        rows[index] = text.replacingOccurrences(of: "\n", with: " ")
        setInput(rows.joined(separator: "\n"), keepingRoles: true, preservingChoices: true)
    }

    func addSource() {
        let rows = sourceRows
        guard rows.count < 20, rows.last?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
              !busy, draft?.blockID == nil,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved),
              retainMediaChoicesForSourceOptions() else { return }
        let roles = rows.indices.map(sourceRole(at:)) + [.primary]
        draft?.sourceRoles = roles
        setInput(rows.joined(separator: "\n") + "\n", keepingRoles: true, preservingChoices: true)
    }

    func removeSource(at index: Int) {
        var rows = sourceRows
        guard rows.indices.contains(index), !busy, draft?.blockID == nil,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved),
              retainMediaChoicesForSourceOptions() else { return }
        rows.remove(at: index)
        var roles = sourceRows.indices.map(sourceRole(at:))
        roles.remove(at: index)
        draft?.sourceRoles = roles
        setInput(rows.joined(separator: "\n"), keepingRoles: true, preservingChoices: true)
    }

    func setMedia(_ media: MediaPolicy) {
        guard !busy, draft?.blockID == nil, [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        draft?.media = media; draft?.selectedMedia = nil; draft?.videoFrames = nil; draft?.audio = nil; draft?.phase = .editing
        persistOrReport(); resolve()
    }

    var includedMediaRefs: [String] {
        guard let draft, let preview else { return [] }
        return draft.includedMedia(in: preview)
    }

    func setAudio(_ value: String) {
        guard !busy, draft?.blockID == nil, let plan = preview?.plan,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        let videos = CaptureMediaTree.videoSoundtrackSources(in: plan).flatMap(\.media).compactMap { $0["ref"]?.string }
        guard ["auto", "mix"].contains(value) || videos.contains(value) else { return }
        draft?.audio = value; draft?.phase = .editing
        persistOrReport(); resolve()
    }

    func toggleMedia(_ ref: String) {
        guard !busy, draft?.blockID == nil, let preview,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        draft?.toggleMedia(ref, in: preview); draft?.phase = .editing
        persistOrReport(); resolve()
    }

    func setVideoFrame(_ ref: String, enabled: Bool) {
        guard !busy, draft?.blockID == nil, let preview,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved),
              let asset = preview.media.first(where: { $0["ref"]?.string == ref }), asset["kind"]?.string == "video",
              asset["posterUrl"]?.string != nil else { return }
        var refs = draft?.videoFrames ?? []
        refs.removeAll { $0 == ref }
        if enabled { refs.append(ref) }
        draft?.videoFrames = refs
        if enabled, draft?.audio == ref { draft?.audio = nil }
        let selectedRefs = includedMediaRefs
        if !selectedRefs.contains(ref) { draft?.selectMedia(selectedRefs + [ref], in: preview) }
        draft?.phase = .editing
        persistOrReport(); resolve()
    }

    /// One edit for the three choices on an individual post video. Resolution
    /// recomposes the preview, while full media is staged only after Save.
    func chooseVideo(_ ref: String, as choice: CaptureVideoChoice) {
        guard !busy, draft?.blockID == nil, let preview,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved),
              let asset = preview.media.first(where: { $0["ref"]?.string == ref }),
              asset["kind"]?.string == "video",
              choice != .frame || asset["posterUrl"]?.string != nil else { return }
        var selected = includedMediaRefs
        selected.removeAll { $0 == ref }
        if choice != .none { selected.append(ref) }
        var frames = draft?.videoFrames ?? []
        frames.removeAll { $0 == ref }
        if choice == .frame { frames.append(ref) }
        if choice != .video, draft?.audio == ref { draft?.audio = nil }
        draft?.selectMedia(selected, in: preview)
        draft?.videoFrames = frames
        draft?.phase = .editing
        persistOrReport(); resolve()
    }

    func setAutoFrameThreshold(_ seconds: Int) {
        guard [60, 120, 300, 600].contains(seconds), let account else { return }
        autoFrameThresholdSeconds = seconds
        defaults.set(seconds, forKey: "autoFrameThreshold.\(account.id)")
        // Apply the preference when creating a draft; retain existing draft choices.
    }

    func setQuoteAuthorLink(_ style: CaptureQuoteAuthorLink?) {
        guard !busy, draft?.blockID == nil, preview?.hasQuotes == true,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        draft?.quoteAuthorLink = style; draft?.phase = .editing
        // Presentation uses the retained source tree; it does not reacquire quotes
        // or alter edited writing, source identity, media choices or save history.
        persistOrReport(); resolve(retainedSources: preview?.plan?["sources"])
    }

    func setQuoteDepth(_ depth: CaptureQuoteDepth) {
        guard !busy, draft?.blockID == nil, preview?.hasQuotes == true,
              [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved) else { return }
        if depth == .full, preview?.canExpandQuotes == true {
            previousQuoteDepth = draft?.quoteDepth
            expandedQuotes = true
        } else if depth != .full, expandedQuotes, preview?.canExpandQuotes == true {
            expandedSources.invalidate(); expandedQuotes = false
        }
        draft?.quoteDepth = depth; draft?.phase = .editing
        persistOrReport(); resolve()
    }

    func resolve(retainedSources: JSONValue? = nil) {
        guard !sharePresentationClosed else { return }
        resolution?.cancel()
        let ticket = UUID(); generation = ticket
        guard let draft, !draft.input.isEmpty, draft.blockID == nil,
              ![.queued, .creating, .checking, .uncertain, .saved].contains(draft.phase) else { return }
        if draft.originalLinkOnly == true {
            guard let selected = try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles),
                  selected.primary.count == 1, selected.extra.isEmpty else { return }
            let result = CapturePreview.originalLink(selected.primary[0])
            preview = result; self.draft?.previewSnapshot = result
            self.draft?.phase = .ready; self.draft?.problem = nil
            persistOrReport(); return
        }
        guard !CaptureSourceAccess.redditDenied(draft.problem) else { return }
        guard (try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles)) != nil else {
            restoreInvalidSourceFailure()
            return
        }
        let retryStarted = Date()
        let retrying = draft.phase == .failed
        if retrying { self.draft?.phase = .preparing }
        #if DEBUG && targetEnvironment(simulator)
        if isPreviewFixture && ProcessInfo.processInfo.environment["CAPTURE_UI_LIVE_SOURCE"] != "1" {
            guard let snapshot = fixtureMultiPostSeed ?? draft.previewSnapshot ?? (try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles).primary.first).map(CapturePreview.originalLink) else { return }
            self.draft?.phase = .preparing
            resolution = Task {
                do {
                    try await Task.sleep(for: .milliseconds(ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] == "slow-resolution" ? 3_000 : 300)); try Task.checkCancellation()
                    if ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] == "bluesky-error" {
                        let delay = Int(ProcessInfo.processInfo.environment["CAPTURE_UI_SOURCE_DELAY"] ?? "1000") ?? 1000
                        try await Task.sleep(for: .milliseconds(delay))
                        throw CaptureError.message("The source could not be loaded. Check your connection and try again.")
                    }
                    var result = snapshot
                    if var sources = snapshot.plan?["sources"] {
                        if ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] == "multi-post-extra" {
                            sources = .array(sources.array.enumerated().map { index, source in
                                var object = source.object
                                var selection = object["selection"]?.object ?? [:]
                                selection["role"] = .string(self.sourceRole(at: index).rawValue)
                                object["selection"] = .object(selection)
                                return .object(object)
                            })
                        }
                        let policy = try policyForResolvedSources(sources)
                        let effectivePolicy = try CaptureSourcePolicy.composing(policy, sources: sources)
                        let response = try JSONDecoder().decode(JSONValue.self, from: Data(try core().compose(postsJSON: json(sources), policyJSON: json(effectivePolicy)).utf8))
                        result.plan = response["plan"]
                        // Multi-item composition is optional, as in the live path.
                        let path = result.media.count == 1 ? try await fixtureRender(result) : nil
                        try Task.checkCancellation()
                        guard ticket == generation else { return }
                        self.draft?.renderPath = path
                        acceptRemappedMediaChoices(policy)
                    }
                    guard ticket == generation else { return }
                    if retrying { try await Task.sleep(for: .seconds(max(0, 0.5 - Date().timeIntervalSince(retryStarted)))) }
                    guard ticket == generation else { return }
                    preview = result; self.draft?.previewSnapshot = result; self.draft?.phase = .ready; self.draft?.problem = nil; persistOrReport()
                } catch is CancellationError { }
                catch {
                    guard ticket == generation else { return }
                    if retrying { try? await Task.sleep(for: .seconds(max(0, 0.5 - Date().timeIntervalSince(retryStarted)))) }
                    guard !Task.isCancelled, ticket == generation else { return }
                    self.draft?.phase = .failed; self.draft?.problem = error.localizedDescription; persistOrReport()
                }
            }
            return
        }
        #endif
        resolution = Task {
            do {
                if draft.phase == .editing && preview == nil { try await Task.sleep(for: .milliseconds(300)) }
                try Task.checkCancellation()
                let selected = try CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles)
                let urls = selected.primary
                let extraURLs = selected.extra
                let url = urls[0]
                guard ticket == generation else { return }
                self.draft?.phase = .preparing
                let result: CapturePreview
                let source = try JSONDecoder().decode(JSONValue.self, from: Data(try core().source(url.absoluteString).utf8))
                if urls.count + extraURLs.count > 1 {
                    for item in urls + extraURLs {
                        let candidate = try JSONDecoder().decode(JSONValue.self, from: Data(try core().source(item.absoluteString).utf8))
                        guard candidate["kind"]?.string == "social" else {
                            throw CaptureError.message("Add supported posts here. Save other links separately.")
                        }
                    }
                }
                if source["kind"]?.string == "social" {
                    let identity = draft.sourceReadIdentity(primary: urls.map(\.absoluteString), extra: extraURLs.map(\.absoluteString))
                    if renderedIdentity != identity { renderedSources.removeAll(); renderedIdentity = identity }
                    if quoteSourceIdentity != identity {
                        quoteSourceIdentity = identity
                        expandedQuotes = draft.quoteDepth == .full || (draft.previewSnapshot?.availableQuoteDepth ?? 0) > 2
                    }
                    var acquisition = draft.compositionPolicy.object
                    acquisition["quoteDepth"] = expandedQuotes ? .string("full") : .number(2)
                    let sourceCache = expandedQuotes ? expandedSources : resolvedSources
                    let posts: String
                    if let retainedSources {
                        posts = try json(retainedSources)
                    } else {
                        posts = try await sourceCache.value(identity: identity) { [self] in
                            let response = try JSONDecoder().decode(JSONValue.self, from: Data(try await core().resolve(draft: draft,
                                refs: urls.map(\.absoluteString), extraRefs: extraURLs.map(\.absoluteString),
                                policyJSON: json(.object(acquisition))).utf8))
                            guard let sources = response["plan"]?["sources"] else { throw CaptureError.message("The source could not be read.") }
                            return try json(sources)
                        }
                    }
                    try Task.checkCancellation()
                    guard ticket == generation else { return }
                    let sources = try JSONDecoder().decode(JSONValue.self, from: Data(posts.utf8))
                    let policy = try policyForResolvedSources(sources)
                    let effectivePolicy = try CaptureSourcePolicy.composing(policy, sources: sources)
                    let response = try JSONDecoder().decode(JSONValue.self, from: Data(try core().compose(postsJSON: posts, policyJSON: json(effectivePolicy)).utf8))
                    guard let plan = response["plan"] else { throw CaptureError.message("Couldn't prepare this capture.") }
                    // The provider has already supplied the writing and media
                    // choices. Publishing stages full-resolution media after
                    // durable Save; a preview must not download a long video.
                    var displayedURL = url.absoluteString
                    var displayedPrimary = urls.map(\.absoluteString)
                    if urls.count == 1, extraURLs.isEmpty,
                       let canonical = plan["sources"]?.array.first(where: {
                           $0["selection"]?["origin"]?.string == "explicit" && $0["selection"]?["declaredIndex"]?.int == 1
                       })?["canonicalUrl"]?.string,
                       let checked = URL(string: canonical), checked.scheme == "https",
                       self.draft?.input.trimmingCharacters(in: .whitespacesAndNewlines) == url.absoluteString {
                        displayedURL = canonical; displayedPrimary = [canonical]
                        if canonical != url.absoluteString {
                            self.draft?.input = canonical
                            cleanedSourceURL = canonical
                            let newIdentity = draft.sourceReadIdentity(primary: [canonical], extra: [])
                            sourceCache.rekey(from: identity, to: newIdentity)
                            quoteSourceIdentity = newIdentity
                        }
                    }
                    result = CapturePreview(kind: "social", url: displayedURL, plan: plan,
                                            inputRefs: displayedPrimary, extraInputRefs: extraURLs.map(\.absoluteString))
                    acceptRemappedMediaChoices(policy)
                    self.draft?.renderPath = nil
                } else {
                    let identity = "link:\(draft.accountID):\(draft.id):\(url.absoluteString)"
                    let snapshot = try await resolvedSources.value(identity: identity) { [self] in
                        let metadata = await linkPreview(url, draftID: draft.id)
                        return String(decoding: try JSONEncoder().encode(metadata), as: UTF8.self)
                    }
                    result = try JSONDecoder().decode(CapturePreview.self, from: Data(snapshot.utf8))
                }
                try Task.checkCancellation()
                guard ticket == generation else { return }
                if retrying { try await Task.sleep(for: .seconds(max(0, 0.5 - Date().timeIntervalSince(retryStarted)))) }
                guard ticket == generation else { return }
                preview = result; self.draft?.previewSnapshot = result; self.draft?.phase = .ready; self.draft?.problem = nil
                persistOrReport()
            } catch is CancellationError { }
            catch {
                guard !Task.isCancelled, ticket == generation, self.draft?.id == draft.id else { return }
                if expandedQuotes, preview?.canExpandQuotes == true {
                    expandedQuotes = false; self.draft?.quoteDepth = previousQuoteDepth
                }
                if retrying { try? await Task.sleep(for: .seconds(max(0, 0.5 - Date().timeIntervalSince(retryStarted)))) }
                guard !Task.isCancelled, ticket == generation else { return }
                self.draft?.phase = .failed; self.draft?.problem = error.localizedDescription
                persistOrReport()
            }
        }
    }

    /// Stop only an unsubmitted source read. Durable saves have their own
    /// delivery identity and must not be reported cancelled by this action.
    func cancelSourceRead() {
        guard draft?.phase == .preparing, draft?.blockID == nil else { return }
        resolution?.cancel(); generation = UUID(); resolution = nil
        draft?.phase = .editing; draft?.problem = nil
        persistOrReport()
    }

    #if DEBUG && targetEnvironment(simulator)
    private func fixtureRender(_ preview: CapturePreview) async throws -> String? {
        guard let plan = preview.plan, !preview.selectedMedia.isEmpty else { return nil }
        let chosen = Set(preview.selectedMedia)
        let assets = preview.media.filter { chosen.contains($0["ref"]?.string ?? "") }
        let media = assets.compactMap { asset -> NativeStagedMedia? in
            guard let ref = asset["ref"]?.string, asset["kind"]?.string == "image",
                  let url = asset["url"]?.string.flatMap(URL.init(string:)), url.isFileURL else { return nil }
            return NativeStagedMedia(ref: ref, kind: "image", fileURL: url,
                                    width: Double(asset["width"]?.int ?? 800), height: Double(asset["height"]?.int ?? 500))
        }
        guard media.count == assets.count else { return draft?.renderPath }
        if media.count == 1 { return media[0].fileURL.path }
        let recipe = try JSONDecoder().decode(JSONValue.self, from: Data(try core().renderRecipe(planJSON: json(plan)).utf8))
        let rendered = try await NativeMediaRenderer.render(recipe: NativeMediaRecipe(json: recipe), media: media, directory: container.appendingPathComponent("fixture-renders"))
        return rendered.fileURL.path
    }
    #endif

    var canSubmitCapture: Bool {
        guard !busy, account != nil, let draft, !draft.isCanceled, canSaveToDestinations,
              [.editing, .preparing, .ready, .failed].contains(draft.phase) else { return false }
        if isAddingPlacements { return draft.selection.channels.map(\.id) != placementBaseline?.channels.map(\.id) }
        if CaptureSourceAccess.redditDenied(draft.problem) { return false }
        return draft.isPlacementOnly ? draft.blockID != nil :
            (try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles)) != nil
    }

    private func commitSubmission(_ source: CaptureDraft) throws -> UUID {
        guard !sharePresentationClosed else { throw CancellationError() }
        var approved = source
        approved.requestedChannelIDs = approved.selection.implicitDefault ? [] : approved.selection.channels.map(\.id)
        approved.defaultChannelMode = defaultPolicy.mode
        let routed = try CaptureDefaultRoute.destinations(approved.selection, defaultChannel: defaultChannel, mode: defaultPolicy.mode)
        if let defaultChannel, routed.contains(where: { $0.id == defaultChannel.id }) {
            try approved.selection.includeAutomatic(defaultChannel)
            approved.provenanceChannelID = defaultPolicy.provenance ? defaultChannel.id : nil
            approved.submittedDefaultChannelID = defaultChannel.id
        } else { approved.provenanceChannelID = nil; approved.submittedDefaultChannelID = nil }
        var submittedID = source.id
        try store.transaction {
            try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: source.accountID, workspaceID: workspaceID)
            submittedID = try delivery.persistQueuedSubmission(draft: approved)
        }
        return submittedID
    }

    private func continueSubmittedWork(_ id: UUID) {
        // Acquire finite iOS execution time before yielding to the delivery task.
        // The task only starts the next transfer; completion may require more stages.
        beginSubmission?()
        scheduleRecovery?()
        guard !isPreviewFixture else { return }
        startContinuedProcessing?(id)
        // Navigation/preview cancellation does not own this task. The job is already durable.
        Task { [self] in
            await delivery.resume()
            refreshDelivery()
        }
    }

    @discardableResult func save() async -> Bool {
        guard !sharePresentationClosed, let source = draft, !source.isCanceled else { return false }
        if isAddingPlacements {
            guard !busy else { return false }
            busy = true; defer { busy = false }
            do {
                var id = source.id
                try store.transaction {
                    try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: source.accountID, workspaceID: workspaceID)
                    id = try delivery.amendPlacements(source.id, account: source.accountID, selection: source.selection, baseline: placementBaseline)
                    try store.remove(account: source.accountID, kind: "placementEdit", id: workspaceID)
                }
                placementReturnDraft = nil; placementBaseline = nil
                refreshDelivery(); persistOrReport()
                // A paused/interrupted operation retains its explicit retry or
                // Continue action; editing channels does not consent to retry.
                if draft?.deliveryState?.stage != .attention && draft?.deliveryState?.stopRequested != true { continueSubmittedWork(id) }
                return true
            } catch { problem = error.localizedDescription; return false }
        }
        if hasDurableSubmission(source.id) { return true }
        guard canSubmitCapture else { return false }
        busy = true; defer { busy = false }
        do {
            // Deliberately no await before the transaction; the editor UUID is stable here.
            let id = try commitSubmission(source)
            resolution?.cancel(); generation = UUID()
            adoptPlacementSubmission()
            refreshDelivery()
            continueSubmittedWork(id)
            return true
        } catch { problem = error.localizedDescription; return false }
    }

    /// Shortcuts uses exactly the same durable command without replacing the user's composer.
    @discardableResult public func submitLink(_ url: URL, title: String? = nil, description: String? = nil, media: MediaPolicy = .auto, channelIDs: [Int] = []) throws -> UUID {
        guard let account else { throw CaptureError.message("Connect Are.na to save.") }
        var capture = CaptureDraft(accountID: account.id, defaultChannel: defaultChannel, input: url.absoluteString)
        capture.videoFrameThresholdSeconds = autoFrameThresholdSeconds
        if let identity = Self.singleThreadSourceIdentity(capture.input, roles: nil) {
            capture.threadExpansion = Self.defaultThreadExpansion(for: identity)
        }
        capture.titleOverride = title; capture.descriptionOverride = description; capture.media = media
        if !channelIDs.isEmpty {
            capture.selection = DestinationSelection(defaultChannel: nil)
            var seen = Set<Int>()
            for id in channelIDs where seen.insert(id).inserted {
                guard let channel = (cached + recent + (defaultChannel.map { [$0] } ?? [])).first(where: { $0.id == id }) else { throw CaptureError.message("Open the app and select this channel before using it in Shortcuts.") }
                capture.selection.toggle(channel)
            }
            guard seen.count <= 20 else { throw CaptureError.message("Choose up to 20 channels.") }
        }
        let id = try commitSubmission(capture)
        continueSubmittedWork(id)
        return id
    }

    private func adoptPlacementSubmission() {
        guard isAddingPlacements, let draft,
              (try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: draft.id.uuidString)) != nil else { return }
        placementReturnDraft = nil
        persistOrReport()
        refreshDelivery()
    }

    func checkAgain(_ operationID: UUID) async {
        guard !isPreviewFixture, let account,
              let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: operationID.uuidString),
              job.draft.accountID == account.id, !job.draft.isCanceled else { return }
        await delivery.check(operationID)
        refreshDelivery()
    }

    func stopSave(_ operationID: UUID) {
        guard let account,
              let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: operationID.uuidString),
              job.draft.accountID == account.id, !job.draft.isCanceled else { return }
        do { try delivery.requestStop(operationID); cancelContinuedProcessing?(operationID); refreshDelivery() }
        catch { problem = error.localizedDescription }
    }

    func canCancelCapture(_ value: CaptureHistorySummary) -> Bool {
        value.accountID == account?.id && !value.isCanceled &&
            (value.isActiveCapture || (value.deliveryState?.operationID == value.id && value.phase != .saved))
    }

    /// Commit terminal intent before cancelling any execution owner. In-flight
    /// acknowledgements may still add receipt evidence to this same capture.
    @discardableResult func cancelCapture(_ operationID: UUID) -> Bool {
        guard let current = historyDraft(operationID), current.accountID == account?.id else { return false }
        if current.isCanceled { return true }
        guard canCancelCapture(CaptureHistorySummary(draft: current)) else { return false }
        do {
            try delivery.cancel(operationID, accountID: current.accountID)
            guard let canceled = historyDraft(operationID), canceled.isCanceled else { refreshDelivery(); return false }
            cancelContinuedProcessing?(operationID)
            if draft?.id == operationID {
                if isAddingPlacements {
                    do { try store.remove(account: current.accountID, kind: "placementEdit", id: workspaceID) }
                    catch { problem = error.localizedDescription }
                    placementReturnDraft = nil; placementBaseline = nil
                }
                resolution?.cancel(); generation = UUID()
                draft = canceled; preview = canceled.previewSnapshot
            }
            if historyReturnDraft?.id == operationID { historyReturnDraft = historyDraft(operationID) }
            refreshDelivery()
            return true
        } catch {
            problem = error.localizedDescription
            refreshDelivery()
            return false
        }
    }

    func continuationTargets(_ operationID: UUID) -> Set<Int>? {
        guard let account, let current = historyDraft(operationID), current.accountID == account.id, !current.isCanceled else { return nil }
        return try? delivery.continuationTargets(operationID)
    }

    func continueSave(_ operationID: UUID, reaffirmingChannelIDs: Set<Int> = []) async {
        guard !isPreviewFixture, let account,
              let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: operationID.uuidString),
              job.draft.accountID == account.id, !job.draft.isCanceled else { return }
        guard let targets = continuationTargets(operationID), targets == reaffirmingChannelIDs else {
            problem = "The save status changed. Review the remaining channels before continuing."
            refreshDelivery()
            return
        }
        beginSubmission?()
        await delivery.continueStopped(operationID, reaffirmingChannelIDs: reaffirmingChannelIDs)
        startContinuedProcessing?(operationID)
        refreshDelivery()
    }

    public var continuedOperationIDs: [UUID] { (try? delivery.continuedOperationIDs()) ?? [] }

    public func continuedSaveReceiptID(_ id: UUID) -> UUID? {
        guard let job = try? store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString) else { return nil }
        return job.receiptID ?? job.id
    }

    public func beginContinuedSave(_ id: UUID, receiptID: UUID? = nil) throws -> Bool { try delivery.beginContinued(id, receiptID: receiptID) }

    public func activateContinuedSave(_ id: UUID, receiptID: UUID? = nil) { delivery.activateContinued(id, receiptID: receiptID) }

    public func deactivateContinuedSave(_ id: UUID, receiptID: UUID? = nil) { delivery.deactivateContinued(id, receiptID: receiptID) }

    public func endContinuedSave(_ id: UUID, receiptID: UUID? = nil) throws { try delivery.endContinued(id, receiptID: receiptID) }

    public func pauseUnclaimedContinuedSaves() throws -> [UUID] { try delivery.prepareForeground(isMainApplication: isMainApplication) }

    /// SwiftUI scenes deliver foreground activation even when the application
    /// delegate does not receive applicationDidBecomeActive.
    public func prepareForegroundDelivery() throws {
        guard foregroundWorkTicket != nil, !isPreviewFixture else { return }
        for id in try pauseUnclaimedContinuedSaves() { cancelContinuedProcessing?(id) }
    }

    public func pauseContinuedSave(_ id: UUID, receiptID: UUID? = nil) throws {
        try delivery.requestStop(id, receiptID: receiptID, reason: .continuedTaskEnded)
        refreshDelivery()
    }

    public func continuedProgress(_ id: UUID) -> CaptureContinuedProgress? {
        if let job = try? store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString) {
            let observation = job.transferID.flatMap { try? store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: $0) }
            return job.progress(observation: observation)
        }
        guard let accounts = try? store.values(Account.self, account: 0, kind: "account") else { return nil }
        for owner in accounts {
            if let saved = try? store.projectedValue(CaptureHistorySummary.self, account: owner.id, kind: "draft", id: id.uuidString),
               let state = saved.deliveryState, state.operationID == id {
                return CaptureContinuedProgress(state: state, selectedChannelIDs: Set(saved.selection.channels.map(\.id)))
            }
        }
        return nil
    }

    func canCheck(_ operationID: UUID) -> Bool {
        guard let account, let job = try? store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: operationID.uuidString) else { return false }
        return job.draft.accountID == account.id && job.canceledAt == nil && job.draft.deliveryState?.canceledAt == nil
    }

    public func finishReceivingShareInput() { receivingShareInput = false }

    public func finishSharing() {
        sharePresentationClosed = true
        resolution?.cancel(); generation = UUID()
        receivingShareInput = false
        delivery?.finishSharing()
    }

    public func handleBackgroundEvents(identifier: String, completion: @escaping @Sendable () -> Void) {
        #if DEBUG && targetEnvironment(simulator)
        if isPreviewFixture {
            if let probe = PreviewFixtures.backgroundProbe { probe.handle(completion: completion) }
            else { completion() }
            return
        }
        #endif
        do { try delivery.attach(identifier, completion: completion) }
        catch { completion() }
    }

    public func resumeForegroundDelivery(ifAdmitted ticket: CaptureForegroundAdmission.Ticket) async {
        guard allowsForegroundWork(ticket), !isPreviewFixture, !sharePresentationClosed else { return }
        await delivery.resume()
        guard allowsForegroundWork(ticket) else { return }
        refreshDelivery()
    }

    public func releaseForegroundAfterStorageReport() -> CaptureForegroundAdmission.Ticket? {
        foregroundAdmission.release() ? foregroundWorkTicket : nil
    }

    public func resumeForegroundAfterStorageReport(ifAdmitted ticket: CaptureForegroundAdmission.Ticket) async {
        await configureInitialDefault(ifAdmitted: ticket)
        guard allowsForegroundWork(ticket) else { return }
        do { try prepareForegroundDelivery() } catch { problem = error.localizedDescription }
        refreshSharedIntake()
        if !busy { do { try reloadAccount() } catch { problem = error.localizedDescription } }
        await resumeForegroundDelivery(ifAdmitted: ticket)
        guard allowsForegroundWork(ticket) else { return }
        if draft?.phase == .editing && draft?.input.isEmpty == false { resolve() }
    }

    public func resumeDelivery() async { guard !isPreviewFixture, !sharePresentationClosed else { return }; await delivery.resume(); refreshDelivery() }

    private func refreshDelivery() {
        defer { deliveryDidChange?() }
        deliveryRevision += 1
        scheduleRecovery?()
        guard let current = draft, !isAddingPlacements else { return }
        if let stored = try? store.value(CaptureDraft.self, account: current.accountID, kind: "draft", id: current.id.uuidString),
           [.queued, .creating, .checking, .uncertain, .saved].contains(stored.phase) || stored.problem != nil {
            draft = stored; preview = stored.previewSnapshot
            if let transfer = try? store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: stored.id.uuidString),
               let transferID = transfer.transferID,
               let observed = try? store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: transferID) {
                draft?.deliveryState?.transferProgress = observed
            }
        }
        progress = draft?.deliveryState?.operationID == draft?.id ? (draft?.deliveryState?.title ?? "") : ""
        if let id = retainedResult?.id, let stored = try? store.value(CaptureDraft.self, account: current.accountID, kind: "draft", id: id.uuidString) { retainedResult = stored }
        if let account { recent = (try? store.values(Channel.self, account: account.id, kind: "recent")) ?? recent }
    }

    /// Byte updates do not reschedule BGProcessing, reload recents, or rescan
    /// History. Only the current detail and system activity observe this signal.
    private func refreshTransferProgress() {
        transferRevision += 1
        if let id = draft?.id, !isAddingPlacements,
           let transfer = try? store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString),
           let transferID = transfer.transferID,
           let observed = try? store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: transferID) {
            draft?.deliveryState?.transferProgress = observed
        }
        deliveryDidChange?()
    }

    var editorTitle: String { draft?.titleOverride ?? preview?.title ?? "" }
    var editorDescription: String {
        if let value = draft?.descriptionOverride { return value }
        guard let plan = preview?.plan else { return "" }
        if let generatedDescription { return generatedDescription }
        let value = (try? coreFields(plan)["description"]?.string) ?? ""
        generatedDescription = value
        return value
    }
    var savedBlock: JSONValue? { draft?.savedBlock }
    var renderURL: URL? { (draft?.renderPath ?? preview?.previewPath).map { URL(fileURLWithPath: $0) } }
    var renderIsVideo: Bool { renderURL?.pathExtension.lowercased() == "mp4" }
    func setTitle(_ value: String) { guard draft?.isPlacementOnly != true, [.ready, .editing, .preparing, .failed].contains(draft?.phase ?? .saved) else { return }; draft?.titleOverride = value; persistOrReport() }
    func setDescription(_ value: String) { guard draft?.isPlacementOnly != true, [.ready, .editing, .preparing, .failed].contains(draft?.phase ?? .saved) else { return }; draft?.descriptionOverride = value; persistOrReport() }
    func clearDefault() throws {
        guard let account else { return }
        try store.transaction {
            try store.remove(account: account.id, kind: "default", id: "default")
            try store.save(true, account: account.id, kind: "defaultSeedApplied", id: "default")
        }
        defaultChannel = nil
        if [.editing, .preparing, .ready, .failed].contains(draft?.phase ?? .saved), draft?.selection.implicitDefault == true {
            draft?.selection = DestinationSelection(defaultChannel: nil); try persist()
        }
    }

    private func linkPreview(_ url: URL, draftID: UUID) async -> CapturePreview {
        let provider = LPMetadataProvider()
        provider.timeout = 15
        do {
            let metadata = try await provider.startFetchingMetadata(for: url)
            try Task.checkCancellation()
            var path: String?
            if let imageProvider = metadata.imageProvider, imageProvider.canLoadObject(ofClass: UIImage.self) {
                let image: UIImage? = await withCheckedContinuation { continuation in
                    imageProvider.loadObject(ofClass: UIImage.self) { object, _ in continuation.resume(returning: object as? UIImage) }
                }
                try Task.checkCancellation()
                if let image, image.size.width > 0, image.size.height > 0 {
                    let scale = min(1, 1600 / max(image.size.width, image.size.height))
                    let format = UIGraphicsImageRendererFormat(); format.scale = 1
                    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                    let thumbnail = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
                    if let data = thumbnail.jpegData(compressionQuality: 0.85) {
                        let directory = container.appendingPathComponent("previews")
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                        let file = directory.appendingPathComponent(draftID.uuidString + ".jpg")
                        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                        path = file.path
                    }
                }
            }
            return CapturePreview(kind: "url", url: url.absoluteString, metadataTitle: metadata.title, previewPath: path)
        } catch { return .originalLink(url) }
    }

    private func core() throws -> CaptureRuntime {
        if let runtime { return runtime }
        let created = try CaptureRuntime(); runtime = created; return created
    }
    private func json(_ value: JSONValue) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
    private func coreFields(_ plan: JSONValue) throws -> [String: JSONValue] {
        try JSONDecoder().decode(JSONValue.self, from: Data(try core().fields(planJSON: json(plan)).utf8)).object
    }
    private func render(plan: JSONValue, draftID: UUID) async throws -> NativeRenderedMedia? {
        try await CapturePreparation(runtime: core(), container: container).render(plan: plan, draftID: draftID)
    }

    func previewComposition(plan: JSONValue, draftID: UUID) async throws -> NativeMediaPreview {
        try await CapturePreparation(runtime: core(), container: container).previewComposition(plan: plan, draftID: draftID)
    }

    private func connectedDestinations(_ blockID: Int, expected: Set<Int>) async throws -> Set<Int> {
        guard let api else { throw CaptureError.message("Connect Are.na again.") }
        var page: Int? = 1
        var visited = Set<Int>(), found = Set<Int>()
        while let current = page, visited.insert(current).inserted {
            let result = try await api.connections(blockID, page: current)
            found.formUnion(result.data.map(\.id))
            if expected.isSubset(of: found) { return found }
            page = result.meta.hasMorePages ? result.meta.nextPage : nil
            if page != nil { try await Task.sleep(for: .milliseconds(250)) }
        }
        return found
    }

    @discardableResult func newCapture(input: String = "", consumingIncoming: Bool = false) -> Bool {
        guard !sharePresentationClosed, let account, !busy else { return false }
        if isAddingPlacements { cancelPlacements() }
        do {
            try persist()
            let previous = draft
            var next: CaptureDraft
            if input.isEmpty, let previous, !previous.hasDraftContent {
                next = previous
                next.input = ""; next.originalLinkOnly = nil; next.redditCapturesJSON = nil; next.substackCapturesJSON = nil; next.media = .auto; next.selectedMedia = nil; next.videoFrames = nil; next.audio = nil; next.quoteDepth = nil; next.quoteAuthorLink = nil; next.phase = .editing; next.problem = nil
                next.selection = DestinationSelection(defaultChannel: defaultChannel)
            } else { next = CaptureDraft(accountID: account.id, defaultChannel: defaultChannel, input: input) }
            next.videoFrameThresholdSeconds = autoFrameThresholdSeconds
            if let identity = Self.singleThreadSourceIdentity(input, roles: nil) {
                next.threadExpansion = Self.defaultThreadExpansion(for: identity)
            }
            var workspace = try store.value(CaptureWorkspace.self, account: account.id, kind: "workspace", id: workspaceID) ?? CaptureWorkspace()
            workspace.activeDraftID = next.hasDraftContent ? next.id : nil
            workspace.emptySelection = next.hasDraftContent ? nil : next.selection
            if let previous, [.queued, .creating, .checking, .uncertain, .saved].contains(previous.phase) { workspace.retainedResultID = previous.id }
            let nextRetained = try workspace.retainedResultID.flatMap {
                try store.value(CaptureDraft.self, account: account.id, kind: "draft", id: $0.uuidString)
            }
            let committed = try store.commitNewCapture(next, workspace: workspace, workspaceID: workspaceID,
                                                        consumingIncoming: consumingIncoming, incomingIDs: freshShare ? sharePendingIDs : nil,
                                                        shareInvocationID: freshShare ? shareInvocationID : nil)
            next = committed.draft
            retainedResult = nextRetained; incomingLinks = committed.incoming ?? incomingLinks
            historyReturnDraft = nil
            resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
            resolution?.cancel(); generation = UUID(); preview = nil; draft = next; progress = ""; problem = nil
            return true
        } catch { problem = error.localizedDescription; return false }
    }

    func addPlacements(to result: CaptureDraft) {
        guard !busy, !isAddingPlacements, !result.isCanceled, result.accountID == account?.id, draft != nil else { return }
        do {
            guard let stored = try store.value(CaptureDraft.self, account: result.accountID, kind: "draft", id: result.id.uuidString),
                  let next = stored.addingPlacements() else { return }
            try persist()
            placementReturnDraft = draft
            placementBaseline = stored.selection
            resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
            resolution?.cancel(); generation = UUID(); draft = next; preview = next.previewSnapshot; progress = ""; problem = nil
            try persist()
        } catch { problem = error.localizedDescription }
    }

    func cancelPlacements() {
        guard !sharePresentationClosed, !busy, let previous = placementReturnDraft else { return }
        do { try store.transaction {
            try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: previous.accountID, workspaceID: workspaceID)
            try store.remove(account: previous.accountID, kind: "placementEdit", id: workspaceID)
        } }
        catch { problem = error.localizedDescription; return }
        placementReturnDraft = nil; placementBaseline = nil
        resolution?.cancel(); generation = UUID()
        draft = (try? store.value(CaptureDraft.self, account: previous.accountID, kind: "draft", id: previous.id.uuidString)) ?? previous; preview = previous.previewSnapshot; progress = ""; problem = nil
        if [.editing, .preparing].contains(previous.phase), !previous.input.isEmpty { resolve() }
    }

    func resumeFromHistory(_ value: CaptureDraft) {
        guard !busy, !value.isCanceled, historyDraft(value.id)?.isCanceled != true, value.accountID == account?.id else { return }
        if isAddingPlacements { cancelPlacements() }
        guard let current = draft else { return }
        do {
            try persist()
            if current.id != value.id { historyReturnDraft = current }
            restore(value)
        } catch { problem = error.localizedDescription }
    }

    func cancelHistoryResume() {
        guard !busy, let previous = historyReturnDraft else { return }
        do {
            try persist()
            historyReturnDraft = nil
            resolution?.cancel(); generation = UUID(); draft = previous; preview = previous.previewSnapshot
            try persist()
            if [.editing, .preparing].contains(previous.phase), !previous.input.isEmpty { resolve() }
        } catch { problem = error.localizedDescription }
    }

    var canEditSubmission: Bool {
        guard let draft, let job = try? store.value(DeliveryJob.self, account: 0, kind: "delivery", id: draft.id.uuidString) else { return false }
        return job.permitsEditing
    }

    var canUseOriginalLink: Bool {
        guard !busy, let draft, CaptureSourceAccess.redditDenied(draft.problem),
              let sources = try? CaptureInput.selectedPosts(draft.input, roles: draft.sourceRoles),
              sources.primary.count == 1, sources.extra.isEmpty else { return false }
        return canEditSubmission || !hasDurableSubmission(draft.id)
    }

    func useOriginalLink() {
        guard canUseOriginalLink else { return }
        if canEditSubmission { editSubmission() }
        guard let current = draft, !hasDurableSubmission(current.id),
              let sources = try? CaptureInput.selectedPosts(current.input, roles: current.sourceRoles),
              sources.primary.count == 1, sources.extra.isEmpty else { return }
        resolution?.cancel(); generation = UUID()
        let result = CapturePreview.originalLink(sources.primary[0])
        draft?.originalLinkOnly = true; draft?.redditCapturesJSON = nil; draft?.substackCapturesJSON = nil; draft?.phase = .ready; draft?.problem = nil
        draft?.previewSnapshot = result; draft?.renderPath = nil
        preview = result; problem = nil
        persistOrReport()
    }

    func editSubmission() {
        guard !sharePresentationClosed, !busy, let previous = draft else { return }
        do {
            var replacement: CaptureDraft?
            try store.transaction {
                try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: previous.accountID, workspaceID: workspaceID)
                guard let job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: previous.id.uuidString),
                      job.permitsEditing else { return }
                var next = job.draft
                next.id = UUID(); next.publicationKey = nil; next.deliveryState = nil; next.updatedAt = Date()
                if job.preparationFailureStage == .reading || job.preparationFailureStage == .queued {
                    // Keep the failure and writing. Returning to the editor must not re-read a denied URL.
                    next.phase = .failed
                } else {
                    next.problem = nil
                    next.phase = next.previewSnapshot == nil ? .editing : .ready
                }
                try store.save(next, account: next.accountID, kind: "draft", id: next.id.uuidString)
                var workspace = try store.value(CaptureWorkspace.self, account: next.accountID, kind: "workspace", id: workspaceID) ?? CaptureWorkspace()
                workspace.activeDraftID = next.id
                if workspace.retainedResultID == previous.id { workspace.retainedResultID = nil }
                try store.save(workspace, account: next.accountID, kind: "workspace", id: workspaceID)
                if let key = job.draft.publicationKey,
                   try store.value(UUID.self, account: previous.accountID, kind: "publicationLock", id: key) == previous.id {
                    try store.remove(account: previous.accountID, kind: "publicationLock", id: key)
                }
                try store.remove(account: 0, kind: "delivery", id: previous.id.uuidString)
                try store.remove(account: previous.accountID, kind: "draft", id: previous.id.uuidString)
                replacement = next
            }
            if let replacement {
                if retainedResult?.id == previous.id { retainedResult = nil }
                restore(replacement); problem = nil; deliveryRevision += 1
            }
        } catch { problem = error.localizedDescription }
    }

    func retryAfterInspection() {
        guard !sharePresentationClosed, !busy, let previous = draft, previous.phase == .uncertain, previous.blockID == nil else { return }
        do {
            var replacement = previous
            replacement.id = UUID()
            replacement.publicationKey = nil
            replacement.blockID = nil
            replacement.savedBlock = nil
            replacement.deliveryState = nil
            replacement.problem = nil
            replacement.updatedAt = Date()
            replacement.phase = replacement.previewSnapshot == nil ? .editing : .ready
            try store.transaction {
                try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: previous.accountID, workspaceID: workspaceID)
                if var job = try store.value(DeliveryJob.self, account: 0, kind: "delivery", id: previous.id.uuidString) {
                    guard job.stage == .attention, job.transferID == nil, job.draft.blockID == nil else {
                        throw CaptureError.message("Wait until the earlier save has been checked.")
                    }
                    job.problem = "This earlier save remains unconfirmed."
                    job.draft.problem = job.problem
                    try store.save(job, account: 0, kind: "delivery", id: previous.id.uuidString)
                    try store.save(job.draft, account: previous.accountID, kind: "draft", id: previous.id.uuidString)
                }
                if let key = previous.publicationKey,
                   try store.value(UUID.self, account: previous.accountID, kind: "publicationLock", id: key) == previous.id {
                    try store.remove(account: previous.accountID, kind: "publicationLock", id: key)
                }
                try store.save(replacement, account: replacement.accountID, kind: "draft", id: replacement.id.uuidString)
                try store.save(CaptureWorkspace(activeDraftID: replacement.id, retainedResultID: previous.id, shareInvocationID: freshShare ? shareInvocationID : nil), account: replacement.accountID, kind: "workspace", id: workspaceID)
            }
            resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
            resolution?.cancel()
            generation = UUID()
            draft = replacement
            retainedResult = try store.value(CaptureDraft.self, account: previous.accountID, kind: "draft", id: previous.id.uuidString)
            preview = replacement.previewSnapshot
            problem = nil
            if replacement.phase == .editing { resolve() }
        } catch { problem = error.localizedDescription }
    }

    func restore(_ value: CaptureDraft) {
        guard !sharePresentationClosed, value.accountID == account?.id, !value.isCanceled, !busy else { return }
        if isAddingPlacements { cancelPlacements() }
        resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
        resolution?.cancel(); generation = UUID(); preview = nil
        do {
            var restored = value
            try store.transaction {
                try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: value.accountID, workspaceID: workspaceID)
                guard try store.value(DeletedCapture.self, account: value.accountID, kind: "deletedDraft", id: value.id.uuidString) == nil else {
                    throw CaptureError.message("Restore this draft from Deleted captures.")
                }
                restored = try store.value(CaptureDraft.self, account: value.accountID, kind: "draft", id: value.id.uuidString) ?? value
                guard !restored.isCanceled else { return }
                restored.recoverAfterInterruption()
                var workspace = try store.value(CaptureWorkspace.self, account: value.accountID, kind: "workspace", id: workspaceID) ?? CaptureWorkspace()
                workspace.activeDraftID = restored.id
                try store.save(workspace, account: value.accountID, kind: "workspace", id: workspaceID)
            }
            guard !restored.isCanceled else { return }
            draft = restored; preview = restored.previewSnapshot
            restoreInvalidSourceFailure()
            if draft?.phase == .editing { resolve() }
        } catch { problem = error.localizedDescription }
    }

    private func restorePlacementEdit() throws {
        guard !isAddingPlacements, let account, let current = draft,
              let edit = try store.value(CapturePlacementEdit.self, account: account.id, kind: "placementEdit", id: workspaceID),
              let stored = try store.value(CaptureDraft.self, account: account.id, kind: "draft", id: edit.captureID.uuidString),
              var next = stored.addingPlacements() else { return }
        placementReturnDraft = current; placementBaseline = edit.baseline ?? stored.selection
        next.selection = edit.selection; draft = next; preview = next.previewSnapshot
    }

    var activeCaptureCount: Int {
        _ = deliveryRevision
        guard let account else { return 0 }
        return (try? store.activeCaptureCount(account: account.id)) ?? 0
    }

    func savedDrafts(activeOnly: Bool? = nil, limit: Int = 100) throws -> [CaptureDraft] {
        guard let account else { return [] }
        try store.archiveExpiredAutomaticDrafts(account: account.id, excluding: Set([draft?.id, placementReturnDraft?.id].compactMap { $0 }))
        return try store.captureHistory(account: account.id, activeOnly: activeOnly, limit: limit)
    }

    func historySummaries(activeOnly: Bool? = nil, limit: Int = 100) throws -> [CaptureHistorySummary] {
        guard let account else { return [] }
        try store.archiveExpiredAutomaticDrafts(account: account.id, excluding: Set([draft?.id, placementReturnDraft?.id].compactMap { $0 }))
        return try store.captureHistorySummaries(account: account.id, activeOnly: activeOnly, limit: limit)
    }

    func historyDraft(_ id: UUID) -> CaptureDraft? {
        guard let account else { return nil }
        guard var value = try? store.value(CaptureDraft.self, account: account.id, kind: "draft", id: id.uuidString) else { return nil }
        if let transfer = try? store.projectedValue(CaptureDeliveryProjection.self, account: 0, kind: "delivery", id: id.uuidString),
           let transferID = transfer.transferID,
           let observed = try? store.projectedValue(CaptureTransferProgress.self, account: 0, kind: "deliveryProgress", id: transferID) {
            value.deliveryState?.transferProgress = observed
        }
        return value
    }

    func canDeleteDraft(_ value: CaptureDraft) -> Bool {
        value.accountID == account?.id && (try? store.canDeleteDraft(value)) == true
    }

    func canDeleteDraft(_ value: CaptureHistorySummary) -> Bool {
        value.accountID == account?.id && (try? store.canDeleteDraft(value)) == true
    }

    @discardableResult func deleteDrafts(_ ids: [UUID]) throws -> [UUID] {
        guard !sharePresentationClosed, let account, !busy else { return [] }
        if let previous = placementReturnDraft, ids.contains(previous.id) { cancelPlacements() }
        var removed: [UUID] = []
        var next: CaptureWorkspaceContents?
        try store.transaction {
            try store.requireShareInvocation(freshShare ? shareInvocationID : nil, account: account.id, workspaceID: workspaceID)
            removed = try store.deleteDrafts(ids, account: account.id)
            if let current = draft, removed.contains(current.id) {
                next = try store.openWorkspace(account: account.id, id: workspaceID, defaultChannel: defaultChannel, migrateLegacy: false, shareInvocationID: freshShare ? shareInvocationID : nil)
            }
        }
        if let next {
            historyReturnDraft = nil
            resolution?.cancel(); generation = UUID(); draft = nil; preview = nil
            draft = next.draft; retainedResult = next.retainedResult
        }
        if let current = retainedResult, removed.contains(current.id) { retainedResult = nil }
        if let previous = historyReturnDraft, removed.contains(previous.id) { historyReturnDraft = nil }
        deliveryRevision += 1
        return removed
    }

    @discardableResult func clearDrafts() throws -> [UUID] {
        let candidates = try savedDrafts(limit: Int.max).filter { $0.isUnsubmittedDraft && canDeleteDraft($0) }
        return try deleteDrafts(candidates.map(\.id))
    }

    func restoreDeletedDrafts(_ ids: [UUID]) throws {
        guard let account else { return }
        try store.restoreDeletedDrafts(ids, account: account.id)
        deliveryRevision += 1
    }

    func deletedDrafts() throws -> [DeletedCapture] {
        guard let account else { return [] }
        return try store.values(DeletedCapture.self, account: account.id, kind: "deletedDraft", limit: Int(Int32.max))
    }

    public func receiveBrowserCapture(_ json: String) throws {
        guard !sharePresentationClosed else { throw CancellationError() }
        guard json.utf8.count <= 2 * 1024 * 1024 else { throw CaptureError.message("This shared page is too large to capture.") }
        let raw = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        let isSubstack = raw?["schema"] as? String == "arena-block/substack-browser-capture"
        let normalized = try isSubstack ? core().importSubstackCapture(json) : core().importRedditCapture(json)
        guard let object = try JSONSerialization.jsonObject(with: Data(normalized.utf8)) as? [String: Any],
              let source = object["sourceUrl"] as? String, let url = URL(string: source) else {
            throw CaptureError.message("Couldn’t identify the shared page.")
        }
        if !busy, let current = draft, !hasDurableSubmission(current.id),
           CaptureInput.urls(in: current.input).contains(where: { CaptureInput.canonicalSourceIdentity($0) == CaptureInput.canonicalSourceIdentity(url) }) {
            let records = isSubstack ? current.substackCapturesJSON : current.redditCapturesJSON
            let existing = records.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [[String: Any]] } ?? []
            var combined = existing.filter { value in
                guard let source = value["sourceUrl"] as? String, let priorURL = URL(string: source) else { return false }
                return CaptureInput.canonicalSourceIdentity(priorURL) != CaptureInput.canonicalSourceIdentity(url)
            }
            combined.append(object)
            let bytes = try JSONSerialization.data(withJSONObject: combined)
            guard bytes.count <= 2 * 1024 * 1024 else { throw CaptureError.message("These shared pages are too large to capture together.") }
            let replacement = try store.replaceBrowserSnapshot(in: current, recordsJSON: String(decoding: bytes, as: UTF8.self), workspaceID: workspaceID, substack: isSubstack, shareInvocationID: freshShare ? shareInvocationID : nil)
            draft = replacement; preview = nil
            resolvedSources.invalidate(); expandedSources.invalidate(); renderedSources.removeAll(); renderedIdentity = nil
            resolve()
        } else { receive(urls: [url], redditCaptureJSON: isSubstack ? nil : normalized, substackCaptureJSON: isSubstack ? normalized : nil) }
    }

    public func receiveBrowserCaptureFile(_ url: URL) throws {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 2 * 1024 * 1024 else { throw CaptureError.message("This shared file is too large to capture.") }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard data.count <= 2 * 1024 * 1024, let json = String(data: data, encoding: .utf8) else { throw CaptureError.message("Couldn’t read the shared file. Share the page from Safari instead.") }
        try receiveBrowserCapture(json)
    }

    public func receive(urls: [URL]) { receive(urls: urls, redditCaptureJSON: nil) }
    private func receive(urls: [URL], redditCaptureJSON: String?, substackCaptureJSON: String? = nil) {
        guard !sharePresentationClosed else { return }
        var seen = Set<String>()
        let values = urls.map(CaptureInput.canonicalSourceURL).map(\.absoluteString).filter { seen.insert($0).inserted }
        guard !values.isEmpty else { return }
        let pending = PendingShare(id: UUID(), urls: values, redditCaptureJSON: redditCaptureJSON, substackCaptureJSON: substackCaptureJSON)
        do {
            try store.transaction {
                if freshShare, let account { try store.requireShareInvocation(shareInvocationID, account: account.id, workspaceID: workspaceID) }
                try store.save(pending, account: 0, kind: "incoming", id: pending.id.uuidString)
            }
            if freshShare { sharePendingIDs.insert(pending.id) }
            try refreshIncoming()
            if account != nil && values.count == 1 && !busy { useIncoming(values[0]) }
        } catch { problem = error.localizedDescription }
    }

    func useIncoming(_ url: String) {
        guard newCapture(input: url, consumingIncoming: true) else { return }
        resolve()
    }

    func refreshSharedIntake() {
        do { try refreshIncoming() }
        catch { problem = error.localizedDescription }
    }

    private func refreshIncoming() throws {
        incomingLinks = try readIncomingLinks()
    }

    private func readIncomingLinks() throws -> [String] {
        var seen = Set<String>()
        return try store.values(PendingShare.self, account: 0, kind: "incoming")
            .filter { !freshShare || sharePendingIDs.contains($0.id) }
            .flatMap(\.urls).filter { seen.insert($0).inserted }
    }

    public func reportInputFailure(_ message: String = "Couldn’t read the shared link. Share the page again.") {
        guard !sharePresentationClosed else { return }
        problem = message
    }
}

enum CaptureVideoChoice: Hashable { case none, video, frame }

#endif
