#if os(iOS)
import CaptureCore
import SwiftUI

struct CaptureStatusView: View {
    let draft: CaptureDraft
    var showTitle = true
    @State private var showsDestinations = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var state: CaptureDeliveryState? {
        draft.deliveryState?.operationID == draft.id ? draft.deliveryState : nil
    }
    private var title: String {
        if draft.phase == .saved { return "Saved to Are.na" }
        if let state {
            if state.stopRequested == true { return state.stage == .attention ? "Save paused" : "Stopping save" }
            return state.title
        }
        if draft.phase == .queued { return "Queued" }
        if draft.phase == .uncertain { return "Checking earlier save" }
        return draft.problem == nil ? "Waiting to save" : "Save interrupted"
    }
    private var confirmedCount: Int {
        if state == nil && draft.phase == .saved { return draft.statusChannels.count }
        return draft.statusChannels.filter { state?.confirmedChannelIDs.contains($0.id) == true }.count
    }
    private var sourceTitle: String? {
        if let name = draft.savedBlock?["title"]?.string ?? draft.titleOverride ?? draft.previewSnapshot?.title,
           !name.isEmpty { return name }
        let rows = draft.input.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if rows.count > 1 { return "\(rows.count) source posts" }
        guard let url = rows.first.flatMap(URL.init(string:)), let host = url.host else { return nil }
        return "Source · \(host)\(url.path)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showTitle, let name = sourceTitle {
                Text(name).font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.primary.opacity(0.75)).lineLimit(2)
            }
            Label(title, systemImage: draft.phase == .saved ? "checkmark.circle.fill" : state?.preparationFailureStage != nil ? "exclamationmark.circle" : "arrow.triangle.2.circlepath")
                .font(.headline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("capture.status.\(draft.id)")
            if state?.preparationFailureStage != nil {
                Text("Nothing was sent to Are.na. Your link and destinations are kept.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Selected destinations").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
            } else if draft.statusChannels.count > 1 {
                Text(dynamicTypeSize.isAccessibilitySize
                     ? "\(confirmedCount)/\(draft.statusChannels.count) confirmed"
                     : "\(confirmedCount) of \(draft.statusChannels.count) confirmed")
                    .font(.footnote.monospacedDigit()).foregroundStyle(Color.primary.opacity(0.75))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if draft.statusChannels.count > 2 && draft.problem == nil && state?.stage != .attention {
                DisclosureGroup("Destinations", isExpanded: $showsDestinations) {
                    destinationRows
                }
                .accessibilityIdentifier("capture.status.destinations")
            } else {
                destinationRows
            }
            if let date = state?.notBefore, date > Date() {
                Text("Waiting until \(date.formatted(date: .omitted, time: .shortened)) to check again.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let problem = draft.problem { Text(CaptureSourceAccess.message(problem)).font(.callout).foregroundStyle(Color.primary.opacity(0.75)) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var destinationRows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(draft.statusChannels) { channel in
                    let standingDefault = channel.id == draft.submittedDefaultChannelID
                    let confirmed = state?.confirmedChannelIDs.contains(channel.id) == true || (state == nil && draft.phase == .saved)
                    Link(destination: channel.url) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            (Text(channel.title).foregroundColor(state?.preparationFailureStage != nil ? .primary : ChannelAppearance.tint(channel)) +
                             Text(" · " + channel.owner.name).foregroundColor(.primary.opacity(0.75)))
                                .font(.footnote)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 8)
                            Image(systemName: "checkmark")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .opacity(confirmed ? 1 : 0)
                                .frame(width: 18)
                                .accessibilityHidden(true)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(channel.label + (standingDefault ? ", Default" : ""))
                    .accessibilityIdentifier("placement.\(draft.id).\(channel.id)")
                    .accessibilityValue(state?.preparationFailureStage != nil ? "Selected, not sent" : confirmed ? "Confirmed" : "Awaiting confirmation")
            }
        }
    }
}
#endif
