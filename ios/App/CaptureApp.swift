import AppIntents
import CaptureCore
import BackgroundTasks
import CaptureUI
import SwiftUI
import UIKit
import OSLog

@main
@MainActor
struct CaptureApp: App {
    @UIApplicationDelegateAdaptor(CaptureApplicationDelegate.self) private var applicationDelegate
    private let session: CaptureSession?
    private let startupError: String?
    init() {
        do { let created = try CaptureApplicationDelegate.makeSession(); session = created; startupError = nil }
        catch { session = nil; startupError = error.localizedDescription }
    }
    var body: some Scene {
        WindowGroup {
            if let session { CaptureRootView(session: session) }
            else { ContentUnavailableView("Capture could not open", systemImage: "exclamationmark.triangle", description: Text(startupError ?? "Try opening the app again.")) }
        }
    }
}

@MainActor
final class CaptureApplicationDelegate: NSObject, UIApplicationDelegate {
    static var session: CaptureSession?
    private static var submissionTask = UIBackgroundTaskIdentifier.invalid
    private static var recoveryEarliestBeginDate: Date?
    @available(iOS 26.0, *) private static var continuedCoordinator: CaptureContinuedCoordinator?
    static var recoveryIdentifier: String { (Bundle.main.bundleIdentifier ?? "capture") + ".delivery-recovery" }

    private static func beginSubmission() {
        guard submissionTask == .invalid else { return }
        submissionTask = UIApplication.shared.beginBackgroundTask(withName: "Finish capture save") {
            Task { @MainActor in endSubmission() }
        }
    }

    private static func endSubmission() {
        guard submissionTask != .invalid else { return }
        let identifier = submissionTask
        submissionTask = .invalid
        UIApplication.shared.endBackgroundTask(identifier)
    }

    static func makeSession() throws -> CaptureSession {
        if let session { return session }
        let created = try CaptureSession()
        created.scheduleRecovery = { scheduleRecovery() }
        created.beginSubmission = { beginSubmission() }
        if #available(iOS 26.0, *) {
            let coordinator = CaptureContinuedCoordinator(session: created)
            continuedCoordinator = coordinator
            created.startContinuedProcessing = { [weak coordinator] id in coordinator?.start(id) }
            created.cancelContinuedProcessing = { [weak coordinator] id in coordinator?.cancel(id) }
            created.deliveryDidChange = { [weak coordinator] in coordinator?.refresh() }
        }
        session = created
        return created
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.recoveryIdentifier, using: nil) { task in
            let work = Task { @MainActor in
                Self.recoveryEarliestBeginDate = nil
                do {
                    let session = try Self.makeSession()
                    await session.resumeDelivery()
                    Self.scheduleRecovery()
                    session.releaseStoreForSuspension()
                    task.setTaskCompleted(success: !Task.isCancelled)
                } catch { task.setTaskCompleted(success: false) }
            }
            task.expirationHandler = { work.cancel() }
        }
        if #available(iOS 26.0, *) { Self.continuedCoordinator?.registerPersisted() }
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // A user may have closed the app in the switcher. That cancels a
        // continued task without a callback, so do not auto-submit its journal.
        if let paused = try? Self.session?.pauseUnclaimedContinuedSaves(), #available(iOS 26.0, *) {
            for id in paused { Self.continuedCoordinator?.cancel(id) }
        }
    }

    static func scheduleRecovery() {
        guard session?.hasPendingDeliveries == true else {
            recoveryEarliestBeginDate = nil
            endSubmission()
            return
        }
        if UIApplication.shared.applicationState == .background { beginSubmission() }
        let request = BGProcessingTaskRequest(identifier: recoveryIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        // Replacing a pending request on every stage must not keep moving its
        // earliest eligible time into the future.
        let earliest = recoveryEarliestBeginDate ?? Date().addingTimeInterval(60)
        request.earliestBeginDate = earliest
        recoveryEarliestBeginDate = earliest
        try? BGTaskScheduler.shared.submit(request)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        if Self.session?.hasPendingDeliveries == true { Self.beginSubmission() }
        Self.scheduleRecovery()
        Self.session?.releaseStoreForSuspension()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        Self.endSubmission()
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard let session = try? Self.makeSession() else { completionHandler(); return }
        if session.hasPendingDeliveries { Self.beginSubmission() }
        session.handleBackgroundEvents(identifier: identifier) {
            Task { @MainActor in
                Self.scheduleRecovery()
                session.releaseStoreForSuspension()
                completionHandler()
            }
        }
    }
}

/// Request iOS 26 execution for a retained save and update its system progress display.
/// Read confirmed remote completion from the save journal.
@available(iOS 26.0, *)
@MainActor
private final class CaptureContinuedCoordinator {
    private weak var session: CaptureSession?
    private var registered: Set<UUID> = []
    private var submitted: Set<UUID> = []
    private var running: [UUID: BGContinuedProcessingTask] = [:]
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Capture", category: "continued-save")

    init(session: CaptureSession) { self.session = session }

    private func identifier(_ id: UUID) -> String {
        (Bundle.main.bundleIdentifier ?? "capture") + ".save." + id.uuidString
    }

    func registerPersisted() {
        for id in session?.continuedOperationIDs ?? [] {
            if register(id) { submitted.insert(id) }
        }
    }

    private func register(_ id: UUID) -> Bool {
        guard !registered.contains(id) else { return true }
        let accepted = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier(id), using: .main) { [weak self] raw in
            MainActor.assumeIsolated {
                guard let continued = raw as? BGContinuedProcessingTask else { raw.setTaskCompleted(success: false); return }
                self?.handle(continued, id: id)
            }
        }
        if accepted { registered.insert(id) }
        return accepted
    }

    func start(_ id: UUID) {
        guard UIApplication.shared.applicationState == .active, let session, register(id) else { return }
        do {
            guard try session.beginContinuedSave(id) else { return }
            let fact = session.continuedProgress(id)
            let request = BGContinuedProcessingTaskRequest(identifier: identifier(id),
                title: fact?.title ?? "Saving to Are.na", subtitle: fact?.subtitle ?? "Checking save")
            request.strategy = .queue
            try BGTaskScheduler.shared.submit(request)
            submitted.insert(id)
        } catch {
            try? session.endContinuedSave(id)
            log.error("Continued save could not start: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func handle(_ task: BGContinuedProcessingTask, id: UUID) {
        guard let session, session.continuedOperationIDs.contains(id) else {
            task.setTaskCompleted(success: false)
            return
        }
        running[id] = task
        submitted.insert(id)
        task.expirationHandler = { [weak self, weak task] in
            let persistPause = {
                MainActor.assumeIsolated {
                    guard let task else { return }
                    self?.expire(task, id: id)
                }
            }
            // Expiration grants little cleanup time. Persist the mutation
            // fence before returning from the callback, on the main actor.
            if Thread.isMainThread { persistPause() }
            else { DispatchQueue.main.sync(execute: persistPause) }
        }
        session.activateContinuedSave(id)
        refresh(id)
        Task { await session.resumeDelivery() }
    }

    func refresh() {
        for id in Array(running.keys) { refresh(id) }
        for id in Array(submitted) where running[id] == nil {
            let fact = session?.continuedProgress(id)
            if fact == nil || fact?.isDone == true || fact?.needsAttention == true {
                BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier(id))
                submitted.remove(id)
                try? session?.endContinuedSave(id)
            }
        }
    }

    private func refresh(_ id: UUID) {
        guard let task = running[id] else { return }
        guard let fact = session?.continuedProgress(id) else { finish(task, id: id, success: false); return }
        task.progress.totalUnitCount = fact.isQuantifiable ? fact.totalUnits : 0
        task.progress.completedUnitCount = fact.completedUnits
        task.updateTitle(fact.title, subtitle: fact.subtitle)
        if fact.isDone { finish(task, id: id, success: true) }
        else if fact.needsAttention { finish(task, id: id, success: false) }
    }

    private func expire(_ task: BGContinuedProcessingTask, id: UUID) {
        guard running[id] === task else { return }
        do {
            try session?.pauseContinuedSave(id)
            finish(task, id: id, success: false)
        } catch {
            // Retain the durable claim if SQLite could not record Stop. No
            // unowned continuation may issue another mutation.
            session?.deactivateContinuedSave(id)
            log.error("Could not persist continued-save pause: \(error.localizedDescription, privacy: .public)")
            finish(task, id: id, success: false, releaseClaim: false)
        }
    }

    func cancel(_ id: UUID) {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier(id))
        submitted.remove(id)
        if let task = running[id] { finish(task, id: id, success: false) }
    }

    private func finish(_ task: BGContinuedProcessingTask, id: UUID, success: Bool, releaseClaim: Bool = true) {
        guard running[id] === task else { return }
        running.removeValue(forKey: id)
        submitted.remove(id)
        task.expirationHandler = nil
        if releaseClaim { try? session?.endContinuedSave(id) }
        task.setTaskCompleted(success: success)
    }
}

// Uses the same local transaction as Save/Connect. The result confirms acceptance, not remote completion.
enum ShortcutCaptureMedia: String, AppEnum {
    case automatic, all, none
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Media"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .automatic: "Automatic", .all: "All", .none: "None"
    ]
    var policy: MediaPolicy { switch self { case .automatic: .auto; case .all: .all; case .none: .none } }
}

struct SubmitCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Link to Are.na"
    static var description = IntentDescription("Queue a link using your connected account and default channel, or cached channel IDs. Check History for its progress.")
    static var openAppWhenRun = false
    @Parameter(title: "URL") var url: URL
    @Parameter(title: "Title") var captureTitle: String?
    @Parameter(title: "Description") var captureDescription: String?
    @Parameter(title: "Media", default: .automatic) var media: ShortcutCaptureMedia
    @Parameter(title: "Channel IDs") var channelIDs: [Int]?

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let session = try CaptureApplicationDelegate.makeSession()
        let id = try session.submitLink(url, title: captureTitle, description: captureDescription, media: media.policy, channelIDs: channelIDs ?? [])
        return .result(value: id.uuidString, dialog: "Capture queued. Check History for progress.")
    }
}
