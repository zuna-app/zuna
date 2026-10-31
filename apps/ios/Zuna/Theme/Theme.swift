import SwiftUI
import UIKit

/// The desktop's design tokens (apps/desktop/src/renderer/src/styles/tokens.css),
/// so both apps look like the same product.
enum Theme {
    // Surfaces: true neutrals, each step lighter than the last.
    static let bg0 = Color(hex: 0x0F0F11)
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

    static let link = Color(hex: 0x8AB4F8)
    static let green = Color(hex: 0x4CC38A)
    static let red = Color(hex: 0xF2555A)
    static let amber = Color(hex: 0xE5A50A)

    /// The muted avatar backgrounds and name colors (lib/format.ts), picked by a stable hash.
    static let avatarColors: [Color] = [0x5B6B7A, 0x6E625C, 0x5F7065, 0x7A6C58, 0x6B6470, 0x557072, 0x7A6060, 0x5F6775].map { Color(hex: $0) }
    static let nameColors: [Color] = [0xA9B7C4, 0xC4B4AC, 0xA8BDAC, 0xC9B89A, 0xB8B0B9, 0xA2BCBE, 0xC9ABAB, 0xAAB2C4].map { Color(hex: $0) }

    /// Same hash as `colorIndex` in lib/format.ts, so a person gets the same color on both apps.
    static func colorIndex(_ seed: String, count: Int) -> Int {
        var hash: Int32 = 0
        for unit in seed.utf16 { hash = hash &* 31 &+ Int32(unit) }
        return Int(hash.magnitude) % count
    }

    static func avatarColor(_ seed: String) -> Color { avatarColors[colorIndex(seed, count: avatarColors.count)] }
    static func nameColor(_ seed: String) -> Color { nameColors[colorIndex(seed, count: nameColors.count)] }
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
