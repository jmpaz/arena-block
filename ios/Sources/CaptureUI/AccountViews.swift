#if os(iOS)
import AuthenticationServices
import CaptureCore
import SwiftUI
import UIKit

struct WindowReader: UIViewRepresentable {
    var found: (UIWindow) -> Void
    func makeUIView(context: Context) -> UIView { WindowProbe(found: found) }
    func updateUIView(_ view: UIView, context: Context) { }
    final class WindowProbe: UIView {
        let found: (UIWindow) -> Void
        init(found: @escaping (UIWindow) -> Void) { self.found = found; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
        override func didMoveToWindow() { super.didMoveToWindow(); if let window { found(window) } }
    }
}

struct ConnectView: View {
    @Bindable var session: CaptureSession
    @State private var token = ""
    @State private var tokenEntry = false
    @State private var window: UIWindow?
    @State private var oauth: OAuthConnection?
    @State private var connecting = false
    private var oauthAvailable: Bool { !session.clientID.isEmpty && !session.clientID.contains("$(") }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Spacer(minLength: 40)
                Text("Capture").font(.largeTitle).fontWeight(.medium)
                Text("Save links and posts to Are.na.")
                    .font(.title3).foregroundStyle(.secondary)
                if oauthAvailable {
                Button(connecting ? "Connecting…" : "Connect Are.na") {
                    guard let window else { session.problem = "The account window is not ready. Try again."; return }
                    guard !session.clientID.isEmpty, !session.clientID.contains("$(") else { session.problem = "Use a personal access token to connect."; return }
                    connecting = true
                    Task {
                        defer { connecting = false; oauth = nil }
                        do {
                            let connection = OAuthConnection(window: window); oauth = connection
                            let token = try await connection.connect(clientID: session.clientID, callbackScheme: session.callbackScheme)
                            await session.connect(token: token)
                        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin { }
                        catch { session.problem = error.localizedDescription }
                    }
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(connecting || session.busy)
                }
                DisclosureGroup("Use a personal access token", isExpanded: $tokenEntry) {
                    VStack(alignment: .leading, spacing: 16) {
                        Link("Create a token on Are.na", destination: URL(string: "https://www.are.na/developers/personal-access-tokens")!)
                        Text("Write access required.").font(.callout).foregroundStyle(.secondary)
                        SecureField("Access token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                        Button("Connect with token") { Task { await session.connect(token: token); if session.account != nil { token = "" } } }
                            .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.busy)
                    }.padding(.top, 16)
                }
            }.padding(24).frame(maxWidth: 540)
        }
        .background(WindowReader { window = $0 }.frame(width: 0, height: 0))
        .onAppear { if !oauthAvailable { tokenEntry = true } }
    }
}

struct SettingsView: View {
    @Bindable var session: CaptureSession
    var exportStorageReport: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var defaultSetup = false
    @State private var defaultPickerDetent: PresentationDetent = .large
    @State private var disconnect = false
    @State private var problem: String?
    var body: some View {
        Form {
            if let account = session.account {
                Section("Account") {
                    LabeledContent("Name", value: account.name)
                    LabeledContent("Plan", value: account.tier.capitalized)
                    Button("Disconnect Are.na", role: .destructive) { disconnect = true }
                }
                Section {
                    Button { defaultSetup = true } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Channel").font(.footnote).foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                if let channel = session.defaultChannel { ChannelIdentity(channel: channel, stacked: true) }
                                else { Text("Choose a channel") }
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                        .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if session.defaultChannel != nil {
                        Toggle("Include on every save", isOn: Binding(get: { session.defaultPolicy.mode == .always }, set: {
                            do { try session.setDefaultMode($0 ? .always : .fallback) } catch { problem = error.localizedDescription }
                        }))
                        Toggle("Save capture details", isOn: Binding(get: { session.defaultPolicy.provenance }, set: {
                            do { try session.setDefaultProvenance($0) } catch { problem = error.localizedDescription }
                        }))
                        Button("Remove default", role: .destructive) {
                            do { try session.clearDefault() } catch { problem = error.localizedDescription }
                        }
                    }
                } header: { Text("Default channel") }
                Section {
                    LabeledContent("Unedited drafts", value: "24 hours")
                    NavigationLink("Deleted captures") { DeletedDraftsView(session: session) }
                } header: { Text("Draft retention") } footer: {
                    Text("Unedited drafts move to Deleted captures. Edited drafts stay until you delete them.")
                }
                Section {
                    Picker("Use a frame for videos over", selection: Binding(
                        get: { session.autoFrameThresholdSeconds }, set: session.setAutoFrameThreshold)) {
                        Text("1 min").tag(60)
                        Text("2 min").tag(120)
                        Text("5 min").tag(300)
                        Text("10 min").tag(600)
                    }
                    .accessibilityIdentifier("settings.auto-frame-threshold")
                } header: { Text("Video defaults") }
                Section {
                    Toggle("Paste on open", isOn: Binding(get: { session.automaticPaste }, set: {
                        session.automaticPaste = $0
                        session.defaults.set($0, forKey: "automaticPaste.\(account.id)")
                        session.defaults.synchronize()
                    }))
                } header: { Text("Clipboard") }
            }
            if let exportStorageReport {
                Section {
                    Button("Export storage report", action: exportStorageReport)
                } header: { Text("Storage") } footer: { Text("Existing saves may continue while you create a report.") }
            }
        }
        .contentMargins(.top, 24, for: .scrollContent)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(dynamicTypeSize.isAccessibilitySize ? .inline : .large)
        .alert("Settings", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK") { problem = nil }
        } message: { Text(problem ?? "") }
        .sheet(isPresented: $defaultSetup) { NavigationStack { ChannelPicker(session: session, choosingDefault: true) }.presentationDetents([.medium, .large], selection: $defaultPickerDetent).presentationBackground(Color(uiColor: .systemBackground)).presentationDragIndicator(.visible) }
        .confirmationDialog("Disconnect Are.na?", isPresented: $disconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { session.disconnect(); dismiss() }
        }
    }
}

struct DraftsView: View {
    @Bindable var session: CaptureSession
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var resume: (CaptureDraft) -> Void
    var addPlacements: (CaptureDraft) -> Void
    @State private var removedIDs: [UUID] = []
    @State private var clearConfirmation = false
    @State private var captures: [CaptureHistorySummary] = []
    @State private var activeCaptures: [CaptureHistorySummary] = []
    @State private var activeLimit = 100
    @State private var hasMoreActive = false
    @State private var limit = 100
    @State private var hasMore = false
    @State private var problem: String?
    @State private var query = ""

    private func matches(_ draft: CaptureHistorySummary) -> Bool {
        query.isEmpty || draft.title.localizedStandardContains(query) || draft.input.localizedStandardContains(query)
            || draft.selection.channels.contains { $0.label.localizedStandardContains(query) }
    }

    private var visible: [CaptureHistorySummary] { captures.filter(matches) }
    private var visibleActive: [CaptureHistorySummary] { activeCaptures.filter(matches) }

    var body: some View {
        List {
            if let problem {
                ContentUnavailableView("History couldn’t load", systemImage: "exclamationmark.triangle", description: Text(problem))
                Button("Try again") { reload() }
            } else if captures.isEmpty && activeCaptures.isEmpty {
                ContentUnavailableView("No captures yet", systemImage: "clock")
            } else if visible.isEmpty && visibleActive.isEmpty { ContentUnavailableView.search(text: query) }
            else {
                if !visibleActive.isEmpty || hasMoreActive {
                    Section {
                        captureRows(visibleActive)
                        if hasMoreActive { Button("Load more active captures") { activeLimit += 100; reload() } }
                    } header: { Text("Active captures") } footer: {
                        Text("Swipe to cancel a save. Confirmed blocks and channels stay on Are.na.")
                    }
                }
                let drafts = visible.filter { $0.isDraftCapture }
                let saved = visible.filter { !$0.isDraftCapture }
                if !drafts.isEmpty { Section("Drafts") { captureRows(drafts) } }
                if !saved.isEmpty { Section("Saved and canceled captures") { captureRows(saved) } }
            }
            if hasMore {
                Button(query.isEmpty ? "Load older captures" : "Search older captures") { limit += 100; reload() }
            }
        }
        .contentMargins(.top, 24, for: .scrollContent)
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(dynamicTypeSize.isAccessibilitySize ? .inline : .large)
        .searchable(text: $query, prompt: "Search captures")
        .navigationDestination(for: UUID.self) { id in
            if let draft = session.historyDraft(id) {
                CaptureDetailView(session: session, draft: draft, resume: resume, addPlacements: addPlacements,
                    removeDraft: { delete([$0.id]) })
            } else { ContentUnavailableView("Capture unavailable", systemImage: "clock") }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Clear drafts", role: .destructive) { clearConfirmation = true }
                        .disabled(!captures.contains(where: { $0.isUnsubmittedDraft && session.canDeleteDraft($0) }))
                    NavigationLink("Deleted captures") { DeletedDraftsView(session: session) }
                } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("History actions")
            }
        }
        .confirmationDialog("Clear drafts?", isPresented: $clearConfirmation, titleVisibility: .visible) {
            Button("Clear drafts", role: .destructive) {
                do { removedIDs = try session.clearDrafts(); reload() }
                catch { problem = error.localizedDescription }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if !removedIDs.isEmpty {
                HStack {
                    Text(removedIDs.count == 1 ? "Capture deleted" : "Drafts cleared")
                    Spacer()
                    Button("Undo") {
                        do { try session.restoreDeletedDrafts(removedIDs); removedIDs = []; reload() }
                        catch { problem = error.localizedDescription }
                    }.accessibilityIdentifier("history.undo-delete")
                }.font(.callout).padding().background(.regularMaterial)
            }
        }
        .refreshable { reload() }
        .task { reload() }
        .onChange(of: session.draft?.phase) { reload() }
        .onChange(of: session.deliveryRevision) { reload() }
        .onChange(of: session.account?.id) { reload() }
    }

    private func captureRows(_ values: [CaptureHistorySummary]) -> some View {
        ForEach(values) { draft in
            NavigationLink(value: draft.id) { HistoryRow(summary: draft) }
                .accessibilityIdentifier("history.capture.\(draft.id)")
                .accessibilityValue(draft.isActiveCapture ? "Active capture, \(HistoryRow.status(draft))" : HistoryRow.status(draft))
                .swipeActions {
                    if session.canCancelCapture(draft) {
                        Button("Cancel", role: .destructive) { if session.cancelCapture(draft.id) { reload() } }
                            .accessibilityIdentifier("history.cancel.\(draft.id)")
                    } else if session.canDeleteDraft(draft) {
                        Button("Delete", role: .destructive) { _ = delete([draft.id]) }
                    }
                }
        }
    }

    private func delete(_ ids: [UUID]) -> Bool {
        do {
            removedIDs = try session.deleteDrafts(ids)
            reload()
            return !removedIDs.isEmpty
        } catch { problem = error.localizedDescription; return false }
    }

    private func reload() {
        do {
            let active = try session.historySummaries(activeOnly: true, limit: activeLimit + 1)
            hasMoreActive = active.count > activeLimit
            activeCaptures = Array(active.prefix(activeLimit))
            let loaded = try session.historySummaries(activeOnly: false, limit: limit + 1)
            hasMore = loaded.count > limit
            captures = Array(loaded.prefix(limit)); problem = nil
        }
        catch { problem = error.localizedDescription }
    }
}

struct HistoryRow: View {
    let summary: CaptureHistorySummary
    init(summary: CaptureHistorySummary) { self.summary = summary }
    init(draft: CaptureDraft) { summary = CaptureHistorySummary(draft: draft) }
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    static func title(_ draft: CaptureDraft) -> String {
        CaptureHistorySummary(draft: draft).title
    }
    static func status(_ draft: CaptureDraft) -> String {
        status(CaptureHistorySummary(draft: draft))
    }
    static func status(_ draft: CaptureHistorySummary) -> String {
        if draft.isCanceled { return "Canceled" }
        // A retained Stop fence does not override a subsequently confirmed receipt.
        if draft.phase == .saved, draft.deliveryState?.stage == .done { return "Saved" }
        if draft.deliveryState?.operationID == draft.id, draft.deliveryState?.stopRequested == true {
            if draft.deliveryState?.stage != .attention { return draft.deliveryState?.title ?? "Checking save" }
            if let reason = draft.deliveryState?.interruption?.reason, reason != .userPause { return "Save interrupted" }
            return draft.phase == .uncertain ? "Save unconfirmed" : "Save paused"
        }
        if draft.deliveryState?.stage == .attention { return draft.phase == .uncertain ? "Save unconfirmed" : "Save interrupted" }
        if let retry = draft.deliveryState?.notBefore, retry > Date() { return "Waiting to retry" }
        if draft.hasProblem && [.queued, .creating, .checking].contains(draft.phase) { return "Save interrupted" }
        if let state = draft.deliveryState, [.queued, .creating, .checking].contains(draft.phase) { return state.title }
        return switch draft.phase {
        case .saved: "Saved"
        case .queued: "Waiting to save"
        case .creating, .checking: "Saving"
        case .uncertain: "Check save status"
        case .failed: "Needs attention"
        default: "Draft"
        }
    }
    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Text(summary.title).lineLimit(2)
                if let first = summary.selection.channels.first {
                    Text(first.label + (summary.selection.channels.count > 1 ? " + \(summary.selection.channels.count - 1)" : ""))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Self.status(summary))
                            Text(summary.updatedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else {
                        HStack(spacing: 8) {
                            Text(Self.status(summary))
                            Text(summary.updatedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                        }
                    }
                }.font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !dynamicTypeSize.isAccessibilitySize,
               let url = summary.imageURL {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: {
                    Rectangle().fill(Color(uiColor: .secondarySystemBackground))
                }.frame(width: 56, height: 56).clipped().accessibilityHidden(true)
            }
        }.padding(.vertical, 4)
    }
}

struct CaptureDetailView: View {
    @Bindable var session: CaptureSession
    let draft: CaptureDraft
    let resume: (CaptureDraft) -> Void
    let addPlacements: (CaptureDraft) -> Void
    let removeDraft: (CaptureDraft) -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var block: JSONValue?
    @State private var latest: CaptureDraft?
    @State private var loading = false
    private var current: CaptureDraft { latest ?? draft }
    @State private var problem: String?

    var body: some View {
        List {
            Section {
                if current.isCanceled || (current.deliveryState != nil && current.phase != .saved) {
                    CaptureStatusView(draft: current, showTitle: false)
                } else {
                    Label(HistoryRow.status(current), systemImage: current.phase == .saved ? "checkmark.circle" : "clock")
                    if let problem = current.problem, current.phase != .saved { Text(problem).font(.callout).foregroundStyle(.secondary) }
                }
                if let shown = block ?? current.savedBlock { BlockContentView(block: shown) }
                else {
                    Text(HistoryRow.title(current)).font(.headline)
                    if let description = current.descriptionOverride, !description.isEmpty { CaptureTextView(text: description, accessibilityPrefix: "history.description") }
                    if loading { ProgressView("Loading block…") }
                }
                if let problem { Text(problem).font(.callout).foregroundStyle(.secondary) }
            }
            if !current.isCanceled && (current.deliveryState == nil || current.phase == .saved) {
                Section("Channels") {
                    ForEach(current.selection.channels) { channel in Link(destination: channel.url) { ChannelIdentity(channel: channel) } }
                }
            }
            Section {
                if let id = current.blockID { Link("Open in Are.na", destination: blockURL(id)) }
                if let url = URL(string: current.input) { Link("Original source", destination: url) }
                Text(current.updatedAt, format: .dateTime.day().month().year().hour().minute()).foregroundStyle(.secondary)
            }
            if !current.isCanceled, current.canAddPlacements {
                Section {
                    Button("Add to channels") { addPlacements(current) }
                        .disabled(session.busy).accessibilityIdentifier("history.add-placements")
                }
            }
            if !current.isCanceled, current.phase != .saved {
                Section {
                    Button(current.deliveryState?.stopRequested == true ? "Review paused save" : (current.blockID != nil || current.phase == .uncertain ? "Review save" : "Resume capture")) { resume(current) }
                        .disabled(session.busy)
                }
            }
            if session.canCancelCapture(CaptureHistorySummary(draft: current)) {
                Section {
                    Button("Cancel save", role: .destructive) {
                        if session.cancelCapture(current.id) { latest = session.historyDraft(current.id) }
                    }.accessibilityIdentifier("history.cancel-save")
                }
            }
        }
        .navigationTitle("Capture").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if session.canDeleteDraft(current) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Delete", role: .destructive) { if removeDraft(current) { dismiss() } }
                        .accessibilityIdentifier("history.delete-draft")
                }
            }
        }
        .task(id: draft.id) {
            latest = session.historyDraft(draft.id)
        }
        .onChange(of: session.deliveryRevision) { latest = session.historyDraft(draft.id) }
        .onChange(of: session.transferRevision) { latest = session.historyDraft(draft.id) }
        .task(id: current.blockID) {
            guard let id = current.blockID, let api = session.api else { return }
            loading = true
            defer { loading = false }
            do { block = try await api.block(id) }
            catch { problem = "Could not refresh this block. \(error.localizedDescription)" }
        }
    }
}

struct DeletedDraftsView: View {
    @Bindable var session: CaptureSession
    @State private var deleted: [DeletedCapture] = []
    @State private var problem: String?

    var body: some View {
        List {
            if let problem {
                ContentUnavailableView("Deleted captures couldn’t load", systemImage: "exclamationmark.triangle", description: Text(problem))
                Button("Try again") { reload() }
            } else if deleted.isEmpty { ContentUnavailableView("No deleted captures", systemImage: "trash") }
            else { ForEach(deleted) { capture in
                HStack {
                    HistoryRow(draft: capture.draft)
                    Spacer()
                    Button("Restore") {
                        do { try session.restoreDeletedDrafts([capture.id]); reload() }
                        catch { problem = error.localizedDescription }
                    }.buttonStyle(.borderless).accessibilityIdentifier("history.restore.\(capture.id)")
                }
            } }
        }.navigationTitle("Deleted captures")
            .task { reload() }.onChange(of: session.deliveryRevision) { reload() }
    }

    private func reload() {
        do { deleted = try session.deletedDrafts(); problem = nil }
        catch { problem = error.localizedDescription }
    }
}

#endif
