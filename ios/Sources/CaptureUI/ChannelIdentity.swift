#if os(iOS)
import CaptureCore
import SwiftUI
import UIKit

enum ChannelAppearance {
    static func tint(_ channel: Channel) -> Color {
        switch channel.visibility {
        case "private":
            Color(uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(red: 0.91, green: 0.43, blue: 0.40, alpha: 1)
                    : UIColor(red: 0.68, green: 0.18, blue: 0.16, alpha: 1)
            })
        case "public", "open":
            Color(uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(red: 0.36, green: 0.74, blue: 0.47, alpha: 1)
                    : UIColor(red: 0.09, green: 0.43, blue: 0.20, alpha: 1)
            })
        default: Color.primary
        }
    }

    static func visibility(_ channel: Channel) -> String {
        channel.visibility == "public" ? "Open" : channel.visibility.capitalized
    }
}

struct ChannelIdentity: View {
    let channel: Channel
    var isDefault = false
    var isStandingDefault = false
    var stacked = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize || stacked {
                VStack(alignment: .leading, spacing: 5) {
                    title
                    if dynamicTypeSize.isAccessibilitySize { metadata }
                    else {
                        Text(channel.owner.name).font(.caption).foregroundStyle(.primary).lineLimit(1).truncationMode(.tail)
                    }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    title.frame(maxWidth: .infinity, alignment: .leading)
                    metadata.frame(maxWidth: 112, alignment: .trailing)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(channel.title), \(channel.owner.name), \(ChannelAppearance.visibility(channel))\(isDefault ? ", Default" : "")")
    }

    private var title: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(channel.title).font(isStandingDefault ? .subheadline : .body)
                .foregroundStyle(ChannelAppearance.tint(channel))
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            if isDefault {
                Image(systemName: "pin.fill").font(.caption2)
                    .accessibilityHidden(true)
            }
        }
    }

    private var metadata: some View {
        VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: 3) {
            Text(channel.owner.name).font(isStandingDefault ? .caption2 : .caption)
                .foregroundStyle(.primary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        }
    }
}

struct ChannelSelectionStyle: ButtonStyle {
    let tint: Color
    var selected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.vertical, 6)
            .background(tint.opacity(configuration.isPressed ? 0.13 : selected ? 0.08 : 0))
            .overlay {
                Rectangle().strokeBorder(tint.opacity(selected ? 0.55 : configuration.isPressed ? 0.30 : 0), lineWidth: 1)
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.10), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}
#endif
