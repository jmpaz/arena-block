#if os(iOS)
import CaptureCore
import SwiftUI
import UIKit

struct ChannelRow: View {
    let channel: Channel
    var selected = false
    var isDefault = false
    var isStandingDefault = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                Image(systemName: "square").opacity(selected ? 0 : 1)
                Image(systemName: "checkmark.square.fill").opacity(selected ? 1 : 0)
            }
            .font(.body)
            .foregroundStyle(ChannelAppearance.tint(channel))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: selected)
            .accessibilityHidden(true)
            ChannelIdentity(channel: channel, isDefault: isDefault, isStandingDefault: isStandingDefault, stacked: false)
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(channel.title), \(channel.owner.name), \(ChannelAppearance.visibility(channel))\(isDefault ? ", Default" : "")")
        .accessibilityValue(selected ? "Selected" : "Not selected")
    }
}

struct ChannelPicker: View {
    @Bindable var session: CaptureSession
    var choosingDefault = false
    var onClose: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var scope = SearchScope.my
    @State private var results: [Channel] = []
    @State private var local: [Channel] = []
    @State private var localSearchKey = ""
    @State private var nextPage: Int?
    @State private var failedPage: Int?
    @State private var loading = true
    @State private var problem: String?
    @State private var showSelected = false
    @State private var requestID = UUID()
    @State private var displayedSearch = "my|"
    @State private var updatingDefault: Int?
    @State private var dismissKeyboardRevision = 0
    @State private var searchFocused = false
    @State private var searchIndex = ChannelSearch.Index([])
    @State private var indexRevision = 0
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(session: CaptureSession, choosingDefault: Bool = false, onClose: (() -> Void)? = nil) {
        self.session = session
        self.choosingDefault = choosingDefault
        self.onClose = onClose
        _local = State(initialValue: session.recent)
        _results = State(initialValue: ChannelSearch.retainedBrowse(session.cached, accountID: session.account?.id, excluding: session.recent))
    }

    private var recentChoices: [Channel] {
        var seen = Set<Int>()
        return session.recent.filter { seen.insert($0.id).inserted && !automaticDefault($0) }
    }

    private var searchKey: String { "\(scope.rawValue)|\(query.trimmingCharacters(in: .whitespacesAndNewlines))" }
    private var currentLocal: [Channel] { localSearchKey == searchKey ? local : [] }
    private var selected: [Channel] {
        (session.draft?.selection.channels ?? []).filter { !automaticDefault($0) }
    }
    private var reviewChannels: [Channel] { session.actualDestinations }
    private func closePicker() {
        if let onClose { onClose() }
        else { dismiss() }
    }
    private func dismissKeyboard() {
        dismissKeyboardRevision += 1
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
    private var visible: [Channel] {
        if showSelected { return selected }
        let separatelyShownDefaultID = query.isEmpty && scope == .my && !choosingDefault &&
            session.defaultPolicy.mode == .fallback &&
            !session.recent.contains(where: { $0.id == session.defaultChannel?.id })
            ? session.defaultChannel?.id : nil
        let remote = displayedSearch == searchKey ? results : []
        let refreshed = Dictionary(remote.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        var seen = Set<Int>()
        return (currentLocal + remote).filter { seen.insert($0.id).inserted }
            .map { refreshed[$0.id] ?? $0 }
            .filter { !automaticDefault($0) && $0.id != separatelyShownDefaultID }
    }

    private func saveSelection() {
        Task {
            let id = session.draft?.id
            let submitted = await session.save()
            if submitted, let id, session.hasDurableSubmission(id) { closePicker() }
        }
    }

    private var scopeMenu: some View {
        Menu {
            Picker("Search in", selection: $scope) {
                ForEach(SearchScope.allCases, id: \.self) { Text($0.title).tag($0) }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Search in \(scope.title)")
        .accessibilityIdentifier("channel.scope")
    }

    private var defaultOptionsMenu: some View {
        Menu {
            Picker("Search in", selection: $scope) {
                ForEach(SearchScope.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            if session.defaultChannel != nil {
                Button("Remove default", systemImage: "pin.slash") {
                    do { try session.clearDefault(); dismiss() } catch { problem = error.localizedDescription }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle").frame(width: 44, height: 44)
        }
        .accessibilityLabel("Channel options")
        .accessibilityIdentifier("channel.options")
    }

    private var searchActions: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                PickerSearchInput(text: $query, dismissRevision: dismissKeyboardRevision,
                                  isEditing: $searchFocused)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 44)
                if !choosingDefault { saveButton }
            }
            if choosingDefault || !dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 16) {
                    if choosingDefault { defaultOptionsMenu }
                    else {
                        clearButton
                        Spacer(minLength: 8)
                        Button { showSelected.toggle() } label: {
                            Label("\(reviewChannels.count) selected", systemImage: showSelected ? "checkmark.circle.fill" : "checkmark.circle")
                                .foregroundStyle(Color(uiColor: .label))
                                .fixedSize(horizontal: true, vertical: false)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .tint(Color(uiColor: .label))
                        .accessibilityLabel("Review \(reviewChannels.count) selected channels")
                        .accessibilityIdentifier("channel.list-mode")
                        .accessibilityValue(showSelected ? "Selected channels" : "All channels")
                    }
                }
            }
            if let problem = session.problem { Text(problem).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(Color(uiColor: .systemBackground))
    }

    private var clearButton: some View {
        Button(action: resetOrClearDestinations) {
            Text(resetOrClearTitle)
                .font(.body)
                .foregroundStyle(Color(uiColor: canResetOrClear ? .label : .tertiaryLabel))
                .fixedSize(horizontal: true, vertical: false)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
            .tint(Color(uiColor: .label))
            .disabled(!canResetOrClear)
            .accessibilityIdentifier("channel.clear")
    }

    private var selectionOptionsMenu: some View {
        Menu {
            Button(resetOrClearTitle, action: resetOrClearDestinations)
                .disabled(!canResetOrClear)
                .accessibilityIdentifier("channel.clear")
            Button(showSelected ? "Show all channels" : "\(reviewChannels.count) selected") { showSelected.toggle() }
                .accessibilityLabel(showSelected ? "Show all channels" : "Review \(reviewChannels.count) selected channels")
                .accessibilityIdentifier("channel.list-mode")
                .accessibilityValue(showSelected ? "Selected channels" : "All channels")
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Selection options, \(reviewChannels.count) selected")
        .accessibilityIdentifier("channel.selection-options")
    }

    private var resetOrClearTitle: String { session.defaultChannel == nil ? "Clear" : "Reset to default" }

    private var canResetOrClear: Bool {
        guard let selection = session.draft?.selection else { return false }
        guard let defaultChannel = session.defaultChannel else { return !selection.channels.isEmpty }
        return !selection.implicitDefault || selection.channels.map(\.id) != [defaultChannel.id]
    }

    private func resetOrClearDestinations() {
        if session.defaultChannel == nil { session.clearDestinations() }
        else { session.resetDestinations() }
    }

    private var saveButton: some View {
        Button(action: saveSelection) {
            HStack {
                if session.busy { ProgressView() }
                Text("Save").font(.body.weight(.semibold))
            }.fixedSize(horizontal: true, vertical: false).frame(minWidth: 64, minHeight: 44)
        }
        .modifier(PickerSaveStyle())
        .disabled(!session.canSubmitCapture)
        .accessibilityLabel("Save to \(session.actualDestinations.count) \(session.actualDestinations.count == 1 ? "channel" : "channels")")
        .accessibilityIdentifier("channel.connect")
    }

    var body: some View {
        let recentIDs = Set(currentLocal.map(\.id))
        let selectedIDs = Set(selected.map(\.id))
        List {
            if showSelected {
                if reviewChannels.isEmpty {
                    ContentUnavailableView("No channels selected", systemImage: "checkmark.square")
                } else {
                    Section("Selected channels") {
                        ForEach(reviewChannels) { channel in
                            if automaticDefault(channel) || !selectedIDs.contains(channel.id) {
                                automaticDestinationRow(channel)
                            }
                            else { channelRow(channel, selectedIDs: selectedIDs) }
                        }
                    }
                }
            } else {
                if query.isEmpty && scope == .my && !choosingDefault,
                   session.defaultPolicy.mode == .fallback, let channel = session.defaultChannel,
                   !recentIDs.contains(channel.id) {
                    Section("Default channel") { channelRow(channel, selectedIDs: selectedIDs) }
                }
                if !visible.isEmpty, query.isEmpty && scope == .my && !currentLocal.isEmpty {
                    Section {
                        Text("Recent channels")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                            .accessibilityAddTraits(.isHeader)
                            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))
                            .listRowSeparator(.hidden)
                        ForEach(visible.filter { recentIDs.contains($0.id) }) { channel in channelRow(channel, selectedIDs: selectedIDs) }
                    }
                    let remaining = visible.filter { !recentIDs.contains($0.id) }
                    if !remaining.isEmpty {
                        Section("My channels") { ForEach(remaining) { channel in channelRow(channel, selectedIDs: selectedIDs) } }
                    }
                } else if !visible.isEmpty {
                    Section {
                        ForEach(visible) { channel in channelRow(channel, selectedIDs: selectedIDs) }
                    } header: {
                        if query.isEmpty {
                            Text(scope == .my ? "My channels" : "Channels")
                        }
                    }
                }
                if !loading && problem == nil && displayedSearch == searchKey && visible.isEmpty &&
                    !(query.isEmpty && scope == .my && session.defaultChannel != nil) {
                    ContentUnavailableView.search(text: query)
                }
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .frame(minHeight: 44).listRowSeparator(.hidden)
                        .accessibilityLabel("Updating channels")
                } else if nextPage != nil && problem == nil {
                    Button("Load more") { fetchNextPage() }
                        .accessibilityIdentifier("channel.load-more")
                }
                if let problem {
                    Section {
                        Text(problem).font(.callout).foregroundStyle(.secondary)
                        Button("Try again") { Task { await load(page: failedPage ?? 1, ticket: requestID) } }
                            .disabled(loading)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemBackground))
        .safeAreaInset(edge: .top, spacing: 0) {
            if !choosingDefault {
                PickerBlockPreview(session: session)
                    .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .systemBackground))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { searchActions }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(choosingDefault ? "Default channel" : "Channels")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", action: closePicker).foregroundStyle(.primary).accessibilityIdentifier("channel.done")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                scopeMenu
                if !choosingDefault && dynamicTypeSize.isAccessibilitySize { selectionOptionsMenu }
            }
        }
        .onChange(of: scope) { _, _ in showSelected = false }
        .task(id: session.cached) {
            let channels = session.cached
            let build = Task.detached(priority: .userInitiated) { ChannelSearch.Index(channels) }
            let index = await withTaskCancellationHandler(operation: { await build.value }, onCancel: { build.cancel() })
            guard !Task.isCancelled else { return }
            searchIndex = index
            indexRevision += 1
        }
        .task(id: "\(searchKey)|\(indexRevision)") {
            let key = searchKey
            let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
            let index = searchIndex
            let accountID = session.account?.id
            let selectedScope = scope
            if term.isEmpty { local = selectedScope == .my ? recentChoices : [] }
            else {
                let ranking = Task.detached(priority: .userInitiated) {
                    index.matches(query: term).filter { channel in
                        switch selectedScope {
                        case .all: return true
                        case .my: return channel.owner.type == "User" && channel.owner.id == accountID
                        case .following: return false
                        }
                    }
                }
                let matches = await withTaskCancellationHandler(operation: { await ranking.value }, onCancel: { ranking.cancel() })
                guard !Task.isCancelled, searchKey == key else { return }
                local = matches
            }
            localSearchKey = key
        }
        .task(id: searchKey) {
            let ticket = UUID()
            requestID = ticket
            nextPage = nil
            failedPage = nil
            problem = nil
            loading = true
            let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
            if !term.isEmpty { showSelected = false }
            results = term.isEmpty && scope == .my
                ? ChannelSearch.retainedBrowse(session.cached, accountID: session.account?.id, excluding: recentChoices) : []
            displayedSearch = searchKey
            do {
                if !term.isEmpty { try await Task.sleep(for: .milliseconds(250)) }
                try Task.checkCancellation()
                await load(page: 1, ticket: ticket)
            } catch { }
        }
    }

    private func channelRow(_ channel: Channel, selectedIDs: Set<Int>) -> some View {
        let isSelected = choosingDefault ? session.defaultChannel?.id == channel.id : selectedIDs.contains(channel.id)
        return Button { choose(channel) } label: {
            ChannelRow(channel: channel, selected: isSelected, isDefault: session.defaultChannel?.id == channel.id)
                .padding(.horizontal, 12)
        }
        .buttonStyle(ChannelSelectionStyle(tint: ChannelAppearance.tint(channel), selected: isSelected))
        .accessibilityIdentifier("channel.select.\(channel.id)")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .disabled(channel.can?.addTo == false && !isSelected)
        .contextMenu {
            if session.defaultChannel?.id == channel.id {
                Button("Remove default", systemImage: "pin.slash") {
                    do { try session.clearDefault() } catch { problem = error.localizedDescription }
                }
            } else {
                Button("Set as default", systemImage: "pin") { setDefault(channel) }
                    .disabled(channel.can?.addTo == false)
            }
            Link("Open in Are.na", destination: channel.url)
        }
        .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
        .listRowSeparator(.hidden)
        .onAppear {
            if !showSelected && results.suffix(5).contains(where: { $0.id == channel.id }) { fetchNextPage() }
        }
    }

    private func automaticDestinationRow(_ channel: Channel) -> some View {
        let tint = ChannelAppearance.tint(channel)
        let alwaysIncluded = session.defaultPolicy.mode == .always
        return ChannelRow(channel: channel, selected: true, isDefault: true)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(tint.opacity(0.08))
            .overlay(Rectangle().strokeBorder(tint.opacity(0.55), lineWidth: 1))
            .accessibilityValue(alwaysIncluded ? "Always included" : "Default destination")
            .accessibilityIdentifier(alwaysIncluded ? "channel.always-included" : "channel.default-destination")
            .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
            .listRowSeparator(.hidden)
    }

    private func choose(_ channel: Channel) {
        if choosingDefault { setDefault(channel) }
        else { toggle(channel) }
    }

    private func automaticDefault(_ channel: Channel) -> Bool {
        !choosingDefault && session.defaultPolicy.mode == .always && channel.id == session.defaultChannel?.id
    }

    private func setDefault(_ channel: Channel) {
        guard updatingDefault == nil else { return }
        updatingDefault = channel.id
        Task {
            defer { updatingDefault = nil }
            do {
                guard let api = session.api else { return }
                let resolved = try await api.channel(String(channel.id))
                try session.setDefault(resolved)
                try session.remember([resolved])
                if choosingDefault { dismiss() }
            } catch { problem = error.localizedDescription }
        }
    }

    private func toggle(_ channel: Channel) {
        let isSelected = session.draft?.selection.contains(channel) == true
        guard isSelected || channel.can?.addTo != false else {
            problem = "You cannot add to \(channel.label)."
            return
        }
        guard !automaticDefault(channel) else { return }
        guard isSelected || session.canAddDestination(channel) else {
            problem = "Choose up to 20 destinations, including the default."
            return
        }
        session.toggle(channel)
        if (session.draft?.selection.contains(channel) == true) != isSelected {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.4)
        }
    }

    private func fetchNextPage() {
        guard let page = nextPage, !loading, problem == nil, displayedSearch == searchKey else { return }
        loading = true
        let ticket = requestID
        Task { await load(page: page, ticket: ticket) }
    }

    private func load(page: Int, ticket: UUID) async {
        guard ticket == requestID else { return }
        guard let api = session.api, let account = session.account else { loading = false; return }
        loading = true
        defer { if ticket == requestID { loading = false } }
        do {
            let result: Page<Channel>
            let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
            if term.isEmpty && scope == .my { result = try await api.channels(accountID: account.id, page: page) }
            else if account.supportsSearch { result = try await api.search(term, scope: scope, page: page) }
            else {
                guard ticket == requestID else { return }
                problem = "Search across Are.na requires Premium. You can still search your channels on this device."
                return
            }
            try Task.checkCancellation()
            guard ticket == requestID else { return }
            var seen = Set<Int>()
            // Keep retained rows in place as fresh metadata and additional pages arrive.
            let updatedChannels = Dictionary(result.data.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
            results = (results.map { updatedChannels[$0.id] ?? $0 } + result.data).filter { seen.insert($0.id).inserted }
            nextPage = result.meta.hasMorePages ? result.meta.nextPage : nil
            failedPage = nil
            try session.remember(result.data)
            problem = nil
            // If a page contains only the already selected default, keep paging
            // until the browse view has a real choice or the server is exhausted.
            if visible.isEmpty, let nextPage, nextPage > page {
                await load(page: nextPage, ticket: ticket)
            }
        } catch is CancellationError { }
        catch { if ticket == requestID { failedPage = page; problem = error.localizedDescription } }
    }
}

private struct PickerSaveStyle: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        content.buttonStyle(.borderedProminent).tint(.accentColor)
    }
}

private struct PickerScrollFocus: ViewModifier {
    var onScroll: () -> Void

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollPhaseChange { _, phase in
                if phase == .interacting { onScroll() }
            }
        } else { content }
    }
}

/// A native search field with a stable width at accessibility sizes. SwiftUI's
/// sheet search cancel control can otherwise grow until it hides the query.
private struct PickerSearchInput: UIViewRepresentable {
    @Binding var text: String
    var dismissRevision: Int
    @Binding var isEditing: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> FocusedSearchField {
        let field = FocusedSearchField()
        field.placeholder = "Search channels"
        field.accessibilityIdentifier = "channel.search"
        field.font = UIFont.preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.returnKeyType = .search
        field.clearButtonMode = .whileEditing
        field.setContentHuggingPriority(.required, for: .vertical)
        field.setContentCompressionResistancePriority(.required, for: .vertical)
        field.delegate = context.coordinator
        #if DEBUG && targetEnvironment(simulator)
        let inspectMediumSheet = ProcessInfo.processInfo.environment["CAPTURE_UI_HALF_PICKER"] == "1"
        #else
        let inspectMediumSheet = false
        #endif
        if !inspectMediumSheet {
            field.onAttach = { [weak field] in
                DispatchQueue.main.async { field?.becomeFirstResponder() }
            }
        }
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: FocusedSearchField, context: Context) {
        context.coordinator.parent = self
        if field.text != text { field.text = text }
        if context.coordinator.lastDismissRevision != dismissRevision {
            context.coordinator.lastDismissRevision = dismissRevision
            field.resignFirstResponder()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: FocusedSearchField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? max(120, uiView.intrinsicContentSize.width),
               height: max(44, (uiView.font?.lineHeight ?? 20) + 16))
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: PickerSearchInput
        var lastDismissRevision = 0
        init(_ parent: PickerSearchInput) { self.parent = parent }
        @objc func changed(_ field: UISearchTextField) { parent.text = field.text ?? "" }
        func textFieldDidBeginEditing(_ textField: UITextField) { parent.isEditing = true }
        func textFieldDidEndEditing(_ textField: UITextField) { parent.isEditing = false }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            textField.resignFirstResponder()
            return true
        }
    }

    final class FocusedSearchField: UISearchTextField {
        var onAttach: (() -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { onAttach?() }
        }
    }
}

#endif
