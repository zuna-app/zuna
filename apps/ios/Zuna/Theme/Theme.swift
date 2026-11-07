import SwiftUI
import UIKit

/// The desktop's design tokens (packages/ui/src/styles/tokens.css),
/// so both apps look like the same product, on a pure black background.
enum Theme {
    // Surfaces: true neutrals, each step lighter than the last. The screens
    // and their bars are black, as on an OLED phone; sheets and cards sit above.
    static let bg0 = Color(hex: 0x000000)
    static let bg1 = Color(hex: 0x151517)
    static let bg2 = Color(hex: 0x1B1B1E)
    static let bg3 = Color(hex: 0x232326)
    static let bg4 = Color(hex: 0x2C2C30)
    static let bg5 = Color(hex: 0x38383D)
    static let line = Color.white.opacity(0.07)
    static let lineStrong = Color.white.opacity(0.13)

    static let text1 = Color(hex: 0xECECEE)
    static let text2 = Color(hex: 0xA0A0A6)
    static let text3 = Color(hex: 0x6E6E75)

    static let bubbleOwn = Color(hex: 0x2F2F33)
    static let bubbleOwnText = Color(hex: 0xF2F2F3)
    static let bubbleOther = Color(hex: 0x1D1D20)

    /// In channels, as the desktop's channel.css: names and times beside the text, and the line joining a reply to its message.
    static let channelMuted = Color(hex: 0x8B8B92)
    static let spine = Color(hex: 0x505057)

    static let link = Color(hex: 0x8AB4F8)
    static let green = Color(hex: 0x4CC38A)
    static let red = Color(hex: 0xF2555A)
    static let amber = Color(hex: 0xE5A50A)

    static let avatarColors: [Color] = Format.avatarColors.map { Color(hex: $0) }
    static let nameColors: [Color] = Format.nameColors.map { Color(hex: $0) }

    static func avatarColor(_ seed: String) -> Color { avatarColors[Format.colorIndex(seed, count: avatarColors.count)] }
    static func nameColor(_ seed: String) -> Color { nameColors[Format.colorIndex(seed, count: nameColors.count)] }
}

/// The accent colors a person can pick in Appearance, as on the desktop.
enum Accent: String, CaseIterable, Codable, Sendable {
    case neutral, blue, green, red, amber

    var color: Color {
        switch self {
        case .neutral: Color(hex: 0xECECEE)
        case .blue: Color(hex: 0x4B8FE0)
        case .green: Color(hex: 0x3FA772)
        case .red: Color(hex: 0xD9534F)
        case .amber: Color(hex: 0xD9962A)
        }
    }

    /// Your own messages' bubbles take on the accent, as on the desktop.
    var bubbleOwn: Color {
        switch self {
        case .neutral: Theme.bubbleOwn
        case .blue: Color(hex: 0x24486F)
        case .green: Color(hex: 0x235240)
        case .red: Color(hex: 0x6A2C2B)
        case .amber: Color(hex: 0x5A4318)
        }
    }

    var bubbleOwnText: Color {
        self == .neutral ? Theme.bubbleOwnText : .white
    }

    /// Switches: a near-white track would hide the white thumb, so neutral uses the system's green.
    var switchTint: Color {
        self == .neutral ? Theme.green : color
    }

    /// Text and icons drawn on top of the accent.
    var onAccent: Color {
        switch self {
        case .neutral, .amber: Color(hex: 0x111113)
        default: .white
        }
    }

    var text: Color {
        switch self {
        case .neutral: Color(hex: 0xECECEE)
        case .blue: Color(hex: 0x7FB0EC)
        case .green: Color(hex: 0x6CC798)
        case .red: Color(hex: 0xEC8784)
        case .amber: Color(hex: 0xE8B562)
        }
    }
}

/// The three message sizes the desktop offers, at iOS sizes, before Dynamic Type scaling.
enum MessageSize: String, CaseIterable, Codable, Sendable {
    case small, medium, large

    var points: CGFloat {
        switch self {
        case .small: 15
        case .medium: 16
        case .large: 17.5
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

extension Color {
    /// A CSS color as Shiki writes it: `#rrggbb` or `#rrggbbaa`.
    init?(css: String) {
        let hex = css.hasPrefix("#") ? String(css.dropFirst()) : css
        guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else { return nil }
        let rgb = hex.count == 8 ? value >> 8 : value
        let alpha = hex.count == 8 ? Double(value & 0xFF) / 255 : 1
        self.init(.sRGB, red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255, opacity: alpha)
    }
}
