#if os(iOS)
import AVKit
import CaptureCore
import ImageIO
import SwiftUI
import UIKit

public struct CaptureRootView: View {
    private struct PreviewInvalidationKey: Equatable {
        var draftID: UUID?
        var phase: CapturePhase?
        var busy: Bool
        var policy: JSONValue?
        var plan: JSONValue?
        var inCaptureTab: Bool
    }

    @Bindable var session: CaptureSession
    let isExtension: Bool
    let completion: (() -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tab = CaptureTab.capture
    @State private var channels = false
    @State private var retryConfirmation = false
    @State private var offeredClipboard = -1
    @State private var historyPath: [UUID] = []
    @State private var savedNotice: CaptureDraft?
    @State private var compositionPreviewURL: URL?
    @State private var compositionPreviewProblem: String?
    @State private var compositionPreviewIsLoading = false
    @State private var compositionPreviewTask: Task<Void, Never>?
    @State private var compositionPreviewTicket = UUID()
    @State private var expandedSourceIndex: Int?
    @State private var pasteProblem: String?
    @State private var pickerDetent: PresentationDetent = .large
    @FocusState private var focusedField: CaptureField?

    public init(session: CaptureSession, isExtension: Bool = false, completion: (() -> Void)? = nil) {
        self.session = session
        #if DEBUG && targetEnvironment(simulator)
        self.isExtension = isExtension || ProcessInfo.processInfo.environment["CAPTURE_UI_PRESENTATION"] == "share"
        #else
        self.isExtension = isExtension
        #endif
        self.completion = completion
    }

    public var body: some View {
        Group {
            if session.account == nil {
                NavigationStack {
                    if isExtension {
                        ContentUnavailableView("Connect Are.na first", systemImage: "link", description: Text("Open Capture to connect Are.na."))
                            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { completion?() } } }
                    } else { ConnectView(session: session) }
                }
            } else if isExtension {
                NavigationStack { composer }
            } else {
                TabView(selection: $tab) {
                    NavigationStack { composer }
                        .tabItem {
                            Label {
                                Text("Capture")
                            } icon: {
                                Image("CaptureTab", bundle: .module).renderingMode(.template)
                                    .accessibilityHidden(true)
                            }
                        }.tag(CaptureTab.capture)
                    NavigationStack(path: $historyPath) {
                        DraftsView(session: session, resume: { draft in
                            session.resumeFromHistory(draft)
                            tab = .capture
                        }, addPlacements: { draft in
                            session.addPlacements(to: draft)
                            if session.isAddingPlacements { tab = .capture }
                        })
                    }.tabItem { Label("History", systemImage: "clock") }.tag(CaptureTab.history)
                    NavigationStack { SettingsView(session: session) }
                        .tabItem { Label("Settings", systemImage: "gearshape") }.tag(CaptureTab.settings)
                }
            }
        }
        .tint(.accentColor)
        .preferredColorScheme(fixtureColorScheme)
        .alert("Capture", isPresented: Binding(get: { session.problem != nil }, set: { if !$0 { session.problem = nil } })) {
            Button("OK") { session.problem = nil }
        } message: { Text(session.problem ?? "") }
        .onChange(of: session.draft?.phase) { _, _ in acknowledgeSave() }
        .onChange(of: session.busy) { _, busy in if !busy { acknowledgeSave() } }
        .onChange(of: previewInvalidationKey) { _, _ in resetCompositionPreview() }
        .onChange(of: session.draft?.input) { _, input in
            if input?.isEmpty == false && session.draft?.phase != .saved { savedNotice = nil }
        }
        .onChange(of: session.account?.id) { _, _ in savedNotice = nil; historyPath = [] }
        .onChange(of: scenePhase) { _, phase in
            #if DEBUG
            session.logLockState("scenePhase.\(phase)")
            #endif
            if phase == .active {
                session.refreshSharedIntake()
                if !session.busy {
                    do { try session.reloadAccount() } catch { session.problem = error.localizedDescription }
                }
                Task { await session.resumeDelivery() }
                offerClipboard()
            } else {
                session.persistOrReport()
                if phase == .background { session.releaseStoreForSuspension() }
            }
        }
        .task {
            #if DEBUG
            session.logLockState("sceneTask")
            #endif
            await session.resumeDelivery()
            if session.draft?.phase == .editing && session.draft?.input.isEmpty == false { session.resolve() }
            acknowledgeSave()
            offerClipboard()
        }
        .onDisappear { resetCompositionPreview() }
    }

    private var fixtureColorScheme: ColorScheme? {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] != nil {
            return ProcessInfo.processInfo.environment["CAPTURE_UI_STYLE"] == "dark" ? .dark : .light
        }
        #endif
        return nil
    }

    private var previewInvalidationKey: PreviewInvalidationKey {
        PreviewInvalidationKey(draftID: session.draft?.id, phase: session.draft?.phase,
                               busy: session.busy, policy: session.draft?.compositionPolicy,
                               plan: session.preview?.plan, inCaptureTab: tab == .capture)
    }

    private var locked: Bool {
        session.busy || session.draft?.blockID != nil || [.queued, .creating, .checking, .uncertain, .saved].contains(session.draft?.phase ?? .editing)
    }

    private var pending: Bool {
        [.queued, .creating, .checking].contains(session.draft?.phase ?? .editing)
    }

    private var destinationsLocked: Bool {
        session.busy || [.queued, .creating, .checking, .uncertain, .saved].contains(session.draft?.phase ?? .editing)
    }

    private var stoppedSubmission: CaptureDraft? {
        guard let draft = session.draft, draft.deliveryState?.stopRequested == true,
              draft.deliveryState?.stage == .attention, session.canCheck(draft.id) else { return nil }
        return draft
    }

    private var sourceControlLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
    }

    private var threadBinding: Binding<Bool> {
        Binding(get: { session.canExpandAtprotoThread ? session.expandsAtprotoThread : session.importsXThread },
                set: { session.canExpandAtprotoThread ? session.setAtprotoThreadExpansion($0) : session.setXThreadImport($0) })
    }

    private var composer: some View {
      ScrollViewReader { scrollProxy in
        Form {
            #if DEBUG && targetEnvironment(simulator)
            if ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] == "background" {
                Section("Background transport fixture") { FixtureBackgroundView(directory: session.container) }
            }
            #endif
            if !session.incomingLinks.isEmpty {
                Section("Shared links") {
                    ForEach(session.incomingLinks, id: \.self) { link in
                        Button(link) { session.useIncoming(link) }.lineLimit(2)
                            .disabled(session.busy)
                    }
                }
            }
            if session.draft?.phase == .saved {
                if let result = session.draft { Section { deliveryStatus(result) } }
                Section {
                    if let block = session.savedBlock { BlockContentView(block: block, showTitle: false) }
                    else { Text("Saved to Are.na.").foregroundStyle(.secondary) }
                }
            } else {
                if let current = session.draft, pending || current.phase == .uncertain {
                    Section { deliveryStatus(current) }
                }
                if session.draft?.blockID == nil && !pending && session.draft?.phase != .uncertain {
                  Section {
                    ForEach(session.sourceRows.indices, id: \.self) { index in
                        sourcePostRow(at: index)
                        .listRowInsets(EdgeInsets(top: session.sourceRows.count == 1 ? 12 : 6,
                                                  leading: 16, bottom: 6, trailing: 16))
                        .swipeActions {
                            Button("Remove", role: .destructive) { session.removeSource(at: index); expandedSourceIndex = nil }
                                .disabled(locked)
                        }
                    }
                    sourceExtras
                    if session.draft?.originalLinkOnly == true {
                        Text("Original link only. Reddit content and media aren’t included.")
                            .font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("capture.original-link.notice")
                    }
                    if !destinationsLocked { destinationRow }
                    if [.preparing, .failed].contains(session.draft?.phase ?? .editing) { sourceReadingRow }
                }
                }
                if !destinationsLocked && session.draft?.blockID != nil {
                    Section { destinationRow }
                }
                if !pending && session.draft?.phase != .uncertain &&
                    (session.preview != nil || session.draft?.titleOverride != nil || session.draft?.descriptionOverride != nil ||
                     (locked && session.draft?.isPlacementOnly == true)) {
                    Section {
                      if session.draft?.isPlacementOnly == true, let block = session.savedBlock {
                        BlockContentView(block: block)
                      } else {
                        VStack(alignment: .leading, spacing: 14) {
                        TextField("Title", text: Binding(get: { session.editorTitle }, set: session.setTitle), axis: .vertical)
                            .font(.title3.weight(.semibold)).lineLimit(1...5)
                            .accessibilityLabel("Block title").accessibilityIdentifier("capture.title")
                            .focused($focusedField, equals: .title).disabled(locked)
                            .listRowSeparator(.hidden)
                        if let plan = session.preview?.plan,
                           plan["sources"]?.array.first?["provider"]?.string == "soundcloud" {
                            SoundCloudSourceView(plan: plan).listRowSeparator(.hidden)
                        }
                        if session.sourceRows.count == 1 && session.preview?.media.isEmpty == false && singleImageChoice == nil {
                            CaptureMediaSelection(session: session, locked: locked)
                                .listRowSeparator(.hidden)
                        }
                        if canOfferCompositionPreview {
                            compositionPreviewControls
                                .listRowSeparator(.hidden)
                        }
                        if session.preview?.media.isEmpty == false {
                            descriptionEditor
                        }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                            .listRowSeparator(.hidden)
                        if let url = displayedMediaURL {
                            ZStack(alignment: .topTrailing) {
                                CaptureMediaView(url: url, isVideo: url == session.renderURL && session.renderIsVideo)
                                    .opacity(singleImageChoice.map { session.includedMediaRefs.contains($0.ref) } == false ? 0.42 : 1)
                                    .accessibilityIdentifier(compositionPreviewURL == url ? "capture.composition-preview.image" : "capture.block-media")
                                if let choice = singleImageChoice, session.sourceRows.count == 1 {
                                    renderedImageChoice(choice.ref)
                                        .padding(12)
                                }
                            }
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                        }
                        if let preview = session.preview, preview.hasQuotes {
                            Picker("Quotes", selection: Binding(get: { session.draft?.quoteDepth ?? .levels(2) }, set: session.setQuoteDepth)) {
                                ForEach(0...max(2, preview.availableQuoteDepth), id: \.self) { depth in
                                    Text(CaptureQuoteDepth.levels(depth).title).tag(CaptureQuoteDepth.levels(depth))
                                }
                                Text(CaptureQuoteDepth.full.title).tag(CaptureQuoteDepth.full)
                            }.pickerStyle(.menu).disabled(locked)
                                .accessibilityIdentifier("capture.quote-depth")
                        }
                        if session.preview?.plan?["block"]?["kind"]?.string == "text",
                           let content = session.preview?.plan?["block"]?["markdown"]?.string, !content.isEmpty {
                            CaptureTextView(text: content)
                        }
                        if session.preview?.media.isEmpty != false { descriptionEditor }
                        if let note = session.preview?.threadCoverageNote {
                            Text(note).font(.footnote).foregroundStyle(.secondary)
                                .accessibilityIdentifier("capture.thread-coverage")
                        }
                        if let raw = session.preview?.url,
                           (session.preview?.plan?["sources"]?.array.count ?? 1) <= 1,
                           let source = URL(string: raw), ["http", "https"].contains(source.scheme?.lowercased() ?? "") {
                            Link(destination: source) {
                                Label("Source · \(source.host ?? "Link")", systemImage: "arrow.up.right")
                                    .font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .tint(.primary)
                            .accessibilityLabel("Open source, \(source.absoluteString)")
                            .accessibilityIdentifier("capture.resolved-link")
                        }
                      }
                    }
                    .id("capture.block-preview")
                }
                if session.busy && !pending && session.draft?.phase != .preparing {
                    Section {
                        ProgressView(session.progress.isEmpty ? "Preparing…" : session.progress)
                            .font(.callout)
                    }
                }
                if let problem = session.draft?.problem,
                   (session.canEditSubmission && session.draft?.deliveryState?.preparationFailureStage == nil) || session.draft?.phase == .uncertain {
                    Section {
                        if !pending && session.draft?.phase != .uncertain { Label(problem, systemImage: "exclamationmark.circle").font(.callout) }
                        if session.canEditSubmission { Button("Edit capture") { session.editSubmission() } }
                        if session.draft?.phase == .uncertain {
                            Text("The save may have reached Are.na. Check these channels before trying again.").font(.callout)
                            ForEach(session.draft?.selection.channels ?? []) { channel in Link(channel.label, destination: channel.url) }
                            Button("I checked Are.na…") { retryConfirmation = true }
                        }
                    }
                }
            }
        }
        .listSectionSpacing(24)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: session.draft?.phase)
        .contentMargins(.top, 24, for: .scrollContent)
        .navigationTitle("Capture")
        .navigationBarTitleDisplayMode(dynamicTypeSize.isAccessibilitySize ? .inline : .large)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }.accessibilityIdentifier("capture.keyboard.done")
            }
            ToolbarItem(placement: .cancellationAction) {
                if session.isAddingPlacements {
                    Button("Cancel") { session.cancelPlacements() }.disabled(session.busy)
                        .accessibilityIdentifier("capture.cancel-placements")
                } else if session.isResumingHistory {
                    Button("Cancel") { session.cancelHistoryResume() }.disabled(session.busy)
                        .accessibilityIdentifier("capture.cancel-history")
                } else if isExtension { Button("Close") { session.persistOrReport(); completion?() } }
            }
            ToolbarItem(placement: .topBarLeading) {
                if !isExtension {
                    Button {
                        focusedField = nil; channels = false; savedNotice = nil
                        session.newCapture()
                    } label: { Image(systemName: "plus") }
                        .disabled(session.busy || session.draft?.hasDraftContent != true)
                        .accessibilityLabel("New capture")
                        .accessibilityHint("Keep this capture in History and start with an empty link")
                        .accessibilityIdentifier("capture.new")
                }
            }
            ToolbarItemGroup(placement: .confirmationAction) {
                if session.draft?.phase == .saved {
                    if isExtension { Button("Done") { completion?() } }
                } else if let stopped = stoppedSubmission {
                    Button("Continue") { Task { await session.continueSave(stopped.id) } }
                        .accessibilityLabel("Continue save")
                        .accessibilityIdentifier("capture.toolbar.continue")
                    if isExtension { Button("Done") { completion?() } }
                } else if pending {
                    if let current = session.draft, session.canCheck(current.id), current.deliveryState?.preparationFailureStage == nil {
                        if current.deliveryState?.stopRequested == true {
                            Button("Stopping…") { }.disabled(true)
                        } else {
                            Button("Stop") { session.stopSave(current.id) }
                                .accessibilityLabel("Stop save")
                                .accessibilityIdentifier("capture.toolbar.stop")
                        }
                    }
                    if isExtension { Button("Done") { completion?() } }
                } else {
                    Button(session.draft?.isPlacementOnly == true ? "Add" : "Save") {
                        focusedField = nil
                        Task { await session.save() }
                    }
                        .fontWeight(.semibold)
                        .foregroundStyle(destinationsLocked || !session.canSubmitCapture ? Color.primary.opacity(0.3) : Color.primary)
                        .disabled(destinationsLocked || !session.canSubmitCapture)
                }
            }
        }
        .sheet(isPresented: $channels) {
            NavigationStack { ChannelPicker(session: session, onClose: { channels = false }) }
                .presentationDetents(availablePickerDetents, selection: $pickerDetent)
                .presentationBackground(Color(uiColor: .systemBackground))
                .presentationDragIndicator(.visible)
        }
        .safeAreaInset(edge: .bottom) {
            if !isExtension, let savedNotice {
                Button {
                    historyPath = [savedNotice.id]; tab = .history; self.savedNotice = nil
                } label: {
                    Label("Saved", systemImage: "checkmark.circle.fill").font(.subheadline.weight(.medium))
                        .padding(.horizontal, 20).padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Saved to Are.na")
                .accessibilityHint("Show the saved capture in History")
                .accessibilityIdentifier("capture.saved-notice")
                .padding(.bottom, 8)
            }
        }
        .task(id: savedNotice?.id) {
            guard savedNotice != nil, !UIAccessibility.isVoiceOverRunning,
                  !UIAccessibility.isSwitchControlRunning else { return }
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, !UIAccessibility.isVoiceOverRunning,
                  !UIAccessibility.isSwitchControlRunning else { return }
            savedNotice = nil
        }
        .confirmationDialog("Save again?", isPresented: $retryConfirmation, titleVisibility: .visible) {
            Button("I checked; save again") { session.retryAfterInspection() }
        } message: { Text("Check your channels in Are.na first. Saving again may create a duplicate block.") }
      }
    }

    @ViewBuilder
    private func deliveryStatus(_ value: CaptureDraft) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            CaptureStatusView(draft: value)
            if hasInlineStatusActions(value) {
                Divider()
                VStack(alignment: .leading, spacing: 0) { resultLinks(value) }
                    .font(.callout).buttonStyle(.borderless)
            }
            if !isExtension, value.canAddPlacements {
                Divider()
                Button("Add to channels") { session.addPlacements(to: value) }
                    .foregroundStyle(.primary)
                    .disabled(session.busy).accessibilityIdentifier("capture.add-placements")
            }
        }
    }

    @ViewBuilder
    private func resultLinks(_ value: CaptureDraft) -> some View {
        if value.deliveryState?.preparationFailureStage != nil {
            if let source = try? CaptureInput.selectedPosts(value.input, roles: value.sourceRoles).primary.first {
                Link(destination: source) {
                    Text("Open source").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("capture.failed-source.open")
            }
            if !CaptureSourceAccess.redditDenied(value.problem) {
                Button { Task { await session.checkAgain(value.id) } } label: {
                    Text("Try again").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                    .buttonStyle(.plain).disabled(session.busy)
                    .accessibilityIdentifier("capture.preparation.retry")
            }
            if session.canEditSubmission {
                Button { session.editSubmission() } label: {
                    Text("Edit capture").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                    .buttonStyle(.plain).disabled(session.busy)
                    .accessibilityIdentifier("capture.preparation.edit")
            }
            if session.canUseOriginalLink { originalLinkChoice }
        } else if value.phase != .saved, session.canCheck(value.id) {
            if value.deliveryState?.stopRequested == true {
                if value.deliveryState?.stage == .attention {
                    if value.blockID != nil || value.phase == .uncertain {
                        Button("Check stop status") { Task { await session.checkAgain(value.id) } }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                            .buttonStyle(.borderedProminent)
                            .tint(Color.primary).foregroundStyle(Color(uiColor: .systemBackground))
                            .disabled(session.busy).accessibilityIdentifier("capture.check.\(value.id)")
                    }
                }
            } else {
                if value.problem != nil {
                    Button("Check save status") { Task { await session.checkAgain(value.id) } }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                        .buttonStyle(.borderedProminent)
                        .tint(Color.primary).foregroundStyle(Color(uiColor: .systemBackground))
                        .disabled(session.busy).accessibilityIdentifier("capture.check.\(value.id)")
                }
            }
        }
        if let id = value.blockID {
            Link("Open block in Are.na", destination: blockURL(id))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
                .accessibilityIdentifier("capture.open.\(value.id)")
        }
    }

    private func hasInlineStatusActions(_ value: CaptureDraft) -> Bool {
        if value.blockID != nil { return true }
        guard value.phase != .saved, session.canCheck(value.id) else { return false }
        if value.deliveryState?.stopRequested == true {
            return value.phase == .uncertain
        }
        return value.problem != nil
    }

    private var destinationRow: some View {
        destinationButton
            .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
    }

    private var sourcePasteButton: some View {
        SourcePasteControl { value in
            guard let links = CaptureInput.pasteableSourceText(value) else {
                pasteProblem = "No supported link on the clipboard"
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                UIAccessibility.post(notification: .announcement, argument: pasteProblem)
                return
            }
            pasteProblem = nil
            session.setInput(links)
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.4)
        }
        .fixedSize()
        .accessibilityLabel("Paste link")
        .accessibilityIdentifier("capture.paste")
    }

    @ViewBuilder
    private func sourcePostRow(at index: Int) -> some View {
        if session.sourceRows.count > 1 {
            let excerpt = sourceContext(at: index)?["text"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.14)) {
                        expandedSourceIndex = expandedSourceIndex == index ? nil : index
                    }
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            sourcePostIdentity(index: index, handle: sourceContext(at: index)?["author"]?["handle"]?.string)
                                .font(.subheadline.weight(.medium))
                            Text(excerpt?.isEmpty == false ? excerpt! : session.sourceRows[index].isEmpty ? "Enter a link" : session.sourceRows[index])
                                .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: expandedSourceIndex == index ? "chevron.up" : "chevron.down")
                            .font(.footnote).foregroundStyle(.tertiary)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Post \(index + 1), \(expandedSourceIndex == index ? "hide details" : "edit link and media")")
                .accessibilityValue(expandedSourceIndex == index ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("capture.source.details.\(index + 1)")
                if expandedSourceIndex == index {
                    sourcePostDetails(at: index)
                        .transition(.opacity)
                }
            }
        } else { sourcePostDetails(at: index) }
    }

    private func sourcePostDetails(at index: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if session.sourceRows.count == 1 {
                Text("Link").font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                    .accessibilityIdentifier("capture.source.label")
                    .accessibilityHidden(true) // The field already announces its descriptive Link label.
            }
            sourceControlLayout {
                TextField("Enter a link", text: Binding(
                    get: { session.sourceRows.indices.contains(index) ? session.sourceRows[index] : "" },
                    set: { session.replaceSource(at: index, with: $0) }), axis: .vertical)
                    .font(.subheadline).foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 1...3 : 1...2)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Source post \(index + 1) link")
                    .accessibilityIdentifier("capture.source.\(index + 1)")
                    .focused($focusedField, equals: .source(index))
                if index == 0, session.sourceRows.first?.isEmpty == true { sourcePasteButton }
            }
            if index == 0, let pasteProblem {
                Text(pasteProblem).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("capture.paste-problem")
            }
            if session.sourceRows.count > 1 {
                sourceControlLayout {
                    sourceTextToggle(at: index)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    Button("Remove post", role: .destructive) {
                        session.removeSource(at: index)
                        expandedSourceIndex = nil
                    }
                    .font(.footnote)
                    .disabled(locked)
                    .accessibilityIdentifier("capture.source.remove.\(index + 1)")
                }
            }

            if session.sourceRows.count > 1,
               let excerpt = sourceContext(at: index)?["text"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines),
               !excerpt.isEmpty {
                Text(excerpt).font(.footnote).foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("capture.source.excerpt.\(index + 1)")
            }
            if session.sourceRows.count > 1,
               let sources = session.preview?.plan?["sources"]?.array,
               sources.indices.contains(index),
               sources[index]["media"]?.array.isEmpty == false {
                Text("Media from this post")
                    .font(.footnote).foregroundStyle(.secondary)
                CaptureMediaSelection(session: session, locked: locked, sourceIndex: index)
            }
        }
        .disabled(locked)
    }

    private var sourceExtras: some View {
        sourceControlLayout {
            Button {
                session.addSource()
                expandedSourceIndex = session.sourceRows.count - 1
                focusedField = .source(session.sourceRows.count - 1)
            } label: {
                Label("Add post", systemImage: "plus")
                    .labelStyle(.titleAndIcon)
                    .fixedSize(horizontal: true, vertical: true)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .disabled(locked || session.sourceRows.count >= 20 || session.sourceRows.last?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false)
            .accessibilityIdentifier("capture.source.add")
            if session.canExpandForumMagnumComment {
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                Picker("Comment context", selection: Binding(
                    get: { session.forumMagnumExpansion },
                    set: { session.setForumMagnumExpansion($0) })) {
                    Text("Selected only").tag(CaptureThreadExpansion.off)
                    Text("With parents").tag(CaptureThreadExpansion.auto)
                    Text("Nearby replies").tag(CaptureThreadExpansion.on)
                }
                .accessibilityIdentifier("capture.comment-context")
                .accessibilityHint("Parents are limited to six. Nearby replies include up to eight direct replies and same-author continuations.")
                .disabled(locked)
            } else if session.canImportXThread || session.canExpandAtprotoThread {
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                Toggle("Import thread", isOn: threadBinding)
                    .fixedSize(horizontal: dynamicTypeSize.isAccessibilitySize ? false : true, vertical: false)
                    .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil, alignment: .leading)
                    .accessibilityIdentifier("capture.thread-import")
                    .disabled(locked)
            }
        }
        .buttonStyle(.borderless)
        .font(.subheadline)
        .foregroundStyle(.primary)
        .frame(minHeight: 44)
        .textCase(nil)
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
    }

    private var singleImageChoice: (ref: String, url: URL)? {
        guard let media = session.preview?.media, media.count == 1,
              media[0]["kind"]?.string == "image", let ref = media[0]["ref"]?.string,
              let url = session.renderURL ?? media[0]["url"]?.string.flatMap(URL.init(string:)) else { return nil }
        return (ref, url)
    }

    private var displayedMediaURL: URL? {
        if let choice = singleImageChoice { return choice.url }
        if let compositionPreviewURL { return compositionPreviewURL }
        return session.preview?.media.isEmpty != false ? session.renderURL : nil
    }

    private var canOfferCompositionPreview: Bool {
        session.draft?.phase == .ready && !session.busy && session.preview?.kind == "social" &&
            singleImageChoice == nil && !session.includedMediaRefs.isEmpty
    }

    private var previewVideoLimitation: String? {
        guard let plan = session.preview?.plan else { return nil }
        let selected = Set(session.includedMediaRefs)
        let frames = Set((plan["block"]?["frameMedia"]?.array ?? []).compactMap { $0["ref"]?.string })
        let hasFullVideo = (plan["sources"]?.array ?? []).flatMap { $0["media"]?.array ?? [] }.contains { asset in
            guard let ref = asset["ref"]?.string else { return false }
            return selected.contains(ref) && asset["kind"]?.string == "video" && !frames.contains(ref)
        }
        return hasFullVideo ? "Video preview unavailable" : nil
    }

    @ViewBuilder private var compositionPreviewControls: some View {
        if let limitation = previewVideoLimitation {
            Text(limitation).font(.footnote).foregroundStyle(.secondary)
        } else if compositionPreviewIsLoading {
            HStack(spacing: 10) {
                ProgressView()
                Text("Preparing media")
                Spacer(minLength: 8)
                Button("Cancel preview") { resetCompositionPreview() }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("capture.composition-preview.cancel")
            }.font(.subheadline)
        } else if compositionPreviewURL != nil {
            HStack {
                Label("Media preview", systemImage: "checkmark.circle")
                Spacer(minLength: 8)
                Button("Hide preview") { resetCompositionPreview() }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("capture.composition-preview.hide")
            }.font(.subheadline)
        } else {
            Button("Preview media", systemImage: "eye") { startCompositionPreview() }
                .font(.subheadline)
                .frame(minHeight: 44, alignment: .leading)
                .accessibilityIdentifier("capture.composition-preview.start")
        }
        if let compositionPreviewProblem {
            Text("Preview unavailable: \(compositionPreviewProblem)")
                .font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("capture.composition-preview.problem")
        }
    }

    @MainActor private func resetCompositionPreview() {
        compositionPreviewTask?.cancel(); compositionPreviewTask = nil
        compositionPreviewTicket = UUID()
        if let compositionPreviewURL {
            try? FileManager.default.removeItem(at: compositionPreviewURL.deletingLastPathComponent())
        }
        compositionPreviewURL = nil
        compositionPreviewProblem = nil
        compositionPreviewIsLoading = false
    }

    @MainActor private func startCompositionPreview() {
        guard canOfferCompositionPreview, previewVideoLimitation == nil,
              let draft = session.draft, let plan = session.preview?.plan else { return }
        resetCompositionPreview()
        let ticket = compositionPreviewTicket
        compositionPreviewIsLoading = true
        compositionPreviewTask = Task {
            do {
                let url = try await session.previewComposition(plan: plan, draftID: draft.id)
                try Task.checkCancellation()
                guard compositionPreviewTicket == ticket, session.draft?.id == draft.id,
                      session.draft?.phase == .ready, session.preview?.plan == plan else {
                    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                    return
                }
                compositionPreviewURL = url
                compositionPreviewIsLoading = false
                compositionPreviewTask = nil
            } catch is CancellationError {
                if compositionPreviewTicket == ticket { compositionPreviewIsLoading = false; compositionPreviewTask = nil }
            } catch {
                if compositionPreviewTicket == ticket {
                    compositionPreviewProblem = error.localizedDescription
                    compositionPreviewIsLoading = false
                    compositionPreviewTask = nil
                }
            }
        }
    }

    private func renderedImageChoice(_ ref: String) -> some View {
        let included = session.includedMediaRefs.contains(ref)
        return Button { session.toggleMedia(ref) } label: {
            Image(systemName: included ? "checkmark.circle.fill" : "circle")
                .font(.body)
                .frame(width: 32, height: 32)
                .background(.regularMaterial, in: Circle())
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .accessibilityLabel(included ? "Exclude image" : "Include image")
        .accessibilityValue(included ? "Included" : "Excluded")
        .accessibilityIdentifier("capture.media.asset.\(ref)")
    }

    private var descriptionEditor: some View {
        TextField("Description", text: Binding(get: { session.editorDescription }, set: session.setDescription), axis: .vertical)
            .font(.subheadline).lineLimit(1...14)
            .accessibilityLabel("Block description")
            .accessibilityIdentifier("capture.description")
            .focused($focusedField, equals: .description)
            .disabled(locked)
    }

    @ViewBuilder
    private var destinationButton: some View {
        Button {
            #if DEBUG && targetEnvironment(simulator)
            pickerDetent = ProcessInfo.processInfo.environment["CAPTURE_UI_HALF_PICKER"] == "1" ? .medium : .large
            #else
            pickerDetent = .large
            #endif
            channels = true
        } label: { compactDestinationRow.contentShape(Rectangle()) }
            .buttonStyle(.plain)
    }

    private var availablePickerDetents: Set<PresentationDetent> {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["CAPTURE_UI_HALF_PICKER"] == "1" { return [.medium] }
        #endif
        return dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large]
    }

    private var sourceReadingRow: some View {
        let reading = session.draft?.phase == .preparing
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    Image(systemName: "exclamationmark.circle").opacity(reading ? 0 : 1)
                    ProgressView().controlSize(.small).opacity(reading ? 1 : 0)
                }.frame(width: 22, height: 22).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(reading ? "Reading link" : "Couldn’t read this link").font(.subheadline.weight(.medium))
                    Text(session.draft?.problem.map(CaptureSourceAccess.message) ?? "")
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .opacity(reading && session.draft?.problem != nil ? 0 : 1)
                        .accessibilityHidden(reading && session.draft?.problem != nil)
                        .overlay(alignment: .topLeading) {
                            if reading && session.draft?.problem != nil {
                                Text("Trying again…").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if !reading, CaptureSourceAccess.redditDenied(session.draft?.problem),
               let source = try? CaptureInput.selectedPosts(session.draft?.input ?? "", roles: session.draft?.sourceRoles).primary.first {
                Link(destination: source) {
                    Text("Open source").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("capture.failed-source.open")
                if session.canUseOriginalLink { originalLinkChoice }
            } else {
                Button(reading ? "Stop" : "Try again") {
                    if reading { session.cancelSourceRead() } else { session.resolve() }
                }
                .frame(minHeight: 44).accessibilityIdentifier("capture.source-action")
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("capture.source-status")
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: reading)
    }

    private var originalLinkChoice: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { session.useOriginalLink() } label: {
                Text("Use original link").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("capture.original-link.choose")
            Text("Reddit content and media won't be included.")
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func sourcePostIdentity(index: Int, handle: String?) -> some View {
        Text(handle.map { $0.hasPrefix("@") ? $0 : "@" + $0 } ??
             URL(string: session.sourceRows[index])?.host ?? "New post")
            .lineLimit(1)
    }

    private func sourceTextToggle(at index: Int) -> some View {
        let includesText = session.sourceRole(at: index) == .primary
        let lastTextPost = includesText && session.sourceRows.indices.filter { session.sourceRole(at: $0) == .primary }.count <= 1
        return Toggle("Include text", isOn: Binding(
            get: { session.sourceRole(at: index) == .primary },
            set: { session.setSourceRole(at: index, to: $0 ? .primary : .extra) }))
            .font(.footnote)
            .fixedSize(horizontal: !dynamicTypeSize.isAccessibilitySize, vertical: true)
            .frame(minHeight: 44)
            .disabled(locked || lastTextPost)
            .accessibilityLabel("Include text from post \(index + 1)")
            .accessibilityHint(lastTextPost ? "Include text from at least one post" : "")
            .accessibilityIdentifier("capture.source.role.\(index + 1)")
    }

    private var compactDestinationRow: some View {
        let selected = session.actualDestinations
        return VStack(alignment: .leading, spacing: 7) {
            Text("Add to").font(.footnote).foregroundStyle(.primary)
            HStack(alignment: .center, spacing: 10) {
                destinationSummary(selected)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(selected.isEmpty ? "Add to, choose channels" : "Add to \(selected.count) channels: " + selected.map(\.label).joined(separator: ", "))
        .accessibilityHint("Choose destinations and manage your default channel")
        .accessibilityIdentifier("capture.destinations")
    }

    @ViewBuilder
    private func destinationSummary(_ selected: [Channel]) -> some View {
        if selected.isEmpty {
            Text("Choose channels").font(.body)
        } else {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(selected.prefix(3))) { channel in
                    destinationSummaryChannel(channel)
                }
                if selected.count > 3 {
                    HStack(spacing: 5) {
                        ForEach(Array(selected.dropFirst(3).prefix(5))) { channel in
                            Circle().fill(ChannelAppearance.tint(channel))
                                .frame(width: 7, height: 7)
                                .accessibilityHidden(true)
                        }
                        Text("+\(selected.count - 3) more")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 18)
                }
            }
        }
    }

    private func destinationSummaryChannel(_ channel: Channel) -> some View {
        let isDefault = channel.id == session.defaultChannel?.id
        return HStack(spacing: 7) {
            Capsule().fill(ChannelAppearance.tint(channel)).frame(width: 3, height: 18)
                .accessibilityHidden(true)
            Text(channel.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(ChannelAppearance.tint(channel))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if isDefault {
                Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Text(channel.owner.name).font(.caption).foregroundStyle(.secondary)
                .lineLimit(1).frame(maxWidth: 84, alignment: .trailing)
        }
        .frame(minHeight: 24)
    }

    private func sourceContext(at index: Int) -> JSONValue? {
        guard session.sourceRows.indices.contains(index),
              let entered = try? CaptureInput.singleURL(session.sourceRows[index]) else { return nil }
        let identity = CaptureInput.canonicalSourceIdentity(entered)
        return session.preview?.plan?["sources"]?.array.first { source in
            guard let raw = source["canonicalUrl"]?.string, let url = URL(string: raw) else { return false }
            return CaptureInput.canonicalSourceIdentity(url) == identity
        }
    }

    private func acknowledgeSave() {
        guard !isExtension, !session.busy, !session.isAddingPlacements,
              let result = session.draft, result.phase == .saved, result.blockID != nil else { return }
        if session.newCapture() {
            savedNotice = result
            if UIAccessibility.isVoiceOverRunning {
                UIAccessibility.post(notification: .announcement, argument: "Saved to Are.na")
            }
        }
    }

    private func offerClipboard() {
        guard !isExtension, session.automaticPaste, session.account != nil,
              session.incomingLinks.isEmpty, session.draft?.input.isEmpty == true,
              offeredClipboard != UIPasteboard.general.changeCount else { return }
        offeredClipboard = UIPasteboard.general.changeCount
        if let string = UIPasteboard.general.string,
           let links = CaptureInput.pasteableSourceText(string) { session.setInput(links) }
    }
}

private enum CaptureField: Hashable { case source(Int), title, description }

private enum CaptureTab: Hashable { case capture, history, settings }

func blockURL(_ id: Int) -> URL { URL(string: "https://www.are.na/block/\(id)")! }

struct CaptureMediaView: View {
    let url: URL
    var isVideo = false
    @State private var player: AVPlayer?
    @State private var localImage: UIImage?
    @State private var localLoadFinished = false
    private var video: Bool { isVideo || ["mp4", "mov", "m4v", "webm"].contains(url.pathExtension.lowercased()) }
    var body: some View {
        VStack(spacing: 0) {
            if video {
                VideoPlayer(player: player).frame(minHeight: 230)
                    .onAppear { player = AVPlayer(url: url) }
                    .onDisappear { player?.pause(); player = nil }
            } else if url.isFileURL {
                if let localImage { Image(uiImage: localImage).renderingMode(.original).resizable().scaledToFit() }
                else if localLoadFinished { Label("Image could not load", systemImage: "photo").frame(maxWidth: .infinity, minHeight: 140) }
                else { ProgressView().frame(maxWidth: .infinity, minHeight: 140) }
            } else {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .failure: Label("Image could not load", systemImage: "photo.badge.exclamationmark").frame(maxWidth: .infinity, minHeight: 140)
                    default: ProgressView().frame(maxWidth: .infinity, minHeight: 140)
                    }
                }
            }
        }.frame(maxWidth: .infinity).accessibilityLabel(video ? "Block video preview" : "Block image preview")
            .task(id: url) {
                guard url.isFileURL, !video else { return }
                localImage = nil; localLoadFinished = false
                let sourceURL = url
                let image = await Task.detached(priority: .userInitiated) {
                    guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1600, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil as UIImage? }
                    return UIImage(cgImage: image)
                }.value
                guard !Task.isCancelled else { return }
                localImage = image; localLoadFinished = true
            }
    }
}

struct CaptureTextView: View {
    let text: String
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(text).lineLimit(expanded ? nil : 6).textSelection(.enabled)
                .accessibilityIdentifier("capture.text.content")
            if text.count > 250 {
                Button {
                    if reduceMotion { expanded.toggle() }
                    else { withAnimation(.easeInOut(duration: 0.22)) { expanded.toggle() } }
                } label: {
                    Text(expanded ? "show less" : "show more")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 8)
                        .contentShape(Rectangle())
                }
                .buttonStyle(CaptureExpansionButtonStyle())
                .accessibilityIdentifier("capture.text.expansion")
            }
        }
    }
}

private struct CaptureExpansionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Color.primary.opacity(configuration.isPressed ? 0.08 : 0), in: RoundedRectangle(cornerRadius: 8))
            .opacity(configuration.isPressed ? 0.72 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct BlockContentView: View {
    let block: JSONValue
    var showTitle = true
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let url = BlockDisplay.mediaURL(block) {
                CaptureMediaView(url: url, isVideo: block["attachment"]?["content_type"]?.string?.hasPrefix("video/") == true)
            }
            if showTitle, let title = block["title"]?.string, !title.isEmpty { Text(title).font(.headline).textSelection(.enabled) }
            if let content = BlockDisplay.text(block, "content"), !content.isEmpty { Text(content).textSelection(.enabled) }
            if let description = BlockDisplay.text(block, "description"), !description.isEmpty { Text(description).textSelection(.enabled) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum BlockDisplay {
    static func text(_ block: JSONValue, _ field: String) -> String? { block[field]?["markdown"]?.string ?? block[field]?.string }
    static func mediaURL(_ block: JSONValue) -> URL? {
        let attachment = block["attachment"]
        if attachment?["content_type"]?.string?.hasPrefix("video/") == true,
           let raw = attachment?["url"]?.string { return URL(string: raw) }
        return imageURL(block)
    }
    static func imageURL(_ block: JSONValue) -> URL? {
        let image = block["image"]
        let raw = image?["large"]?["url"]?.string ?? image?["original"]?["url"]?.string
            ?? image?["large"]?["src"]?.string ?? image?["medium"]?["src"]?.string ?? image?["src"]?.string
        return raw.flatMap(URL.init(string:))
    }
}

#endif
