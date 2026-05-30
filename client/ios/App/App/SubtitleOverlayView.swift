import UIKit
import CoreMedia

// MARK: - Style

/// App-controlled subtitle appearance, mapped from the JS `setSubtitleStyle`.
struct SubtitleStyle {
    var fontScale: CGFloat = 1.0
    var foregroundColor: UIColor = .white
    /// nil = transparent (no box). A real colour paints a tight per-line
    /// highlight behind the text — fully under app control, unlike the
    /// user-preference-gated system caption box.
    var backgroundColor: UIColor?
    var edgeType: String = "none"
    /// Distance from the bottom edge as a fraction of view height.
    var bottomMarginFraction: CGFloat = 0.08
}

extension SubtitleStyle {
    /// Build from the raw JS `setSubtitleStyle` parameters.
    init(
        fontScale: CGFloat,
        foregroundHex: String,
        backgroundHex: String,
        edgeType: String,
        bottomMarginPercent: CGFloat
    ) {
        self.init()
        self.fontScale = fontScale
        self.foregroundColor = SubtitleStyle.color(fromHex: foregroundHex) ?? .white
        // "transparent" (or an unparseable value) → no box; a real colour is
        // honoured directly because the overlay owns the rendering.
        self.backgroundColor = backgroundHex == "transparent"
            ? nil
            : SubtitleStyle.color(fromHex: backgroundHex)
        self.edgeType = edgeType
        self.bottomMarginFraction = max(0, min(0.45, bottomMarginPercent / 100.0))
    }

    /// Parse a hex colour string (#RRGGBB or #AARRGGBB) into a UIColor.
    static func color(fromHex hex: String) -> UIColor? {
        var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.hasPrefix("#") { h.removeFirst() }
        guard let val = UInt64(h, radix: 16) else { return nil }

        var a: CGFloat = 1.0, r: CGFloat = 1.0, g: CGFloat = 1.0, b: CGFloat = 1.0
        switch h.count {
        case 6: // RRGGBB
            r = CGFloat((val >> 16) & 0xFF) / 255.0
            g = CGFloat((val >> 8) & 0xFF) / 255.0
            b = CGFloat(val & 0xFF) / 255.0
        case 8: // AARRGGBB
            a = CGFloat((val >> 24) & 0xFF) / 255.0
            r = CGFloat((val >> 16) & 0xFF) / 255.0
            g = CGFloat((val >> 8) & 0xFF) / 255.0
            b = CGFloat(val & 0xFF) / 255.0
        default:
            return nil
        }
        return UIColor(red: r, green: g, blue: b, alpha: a)
    }
}

// MARK: - Cue runs

/// One styled span of a cue. Only bold / italic are carried from the source;
/// every other visual is applied from `SubtitleStyle`.
struct SubtitleRun {
    let text: String
    let bold: Bool
    let italic: Bool
}

extension SubtitleRun {
    /// Flatten a cue delivered by `AVPlayerItemLegibleOutput` into runs that
    /// carry only bold / italic; colour, size, edge and background come from
    /// the app style applied in the overlay.
    static func runs(from attributed: NSAttributedString) -> [SubtitleRun] {
        var runs: [SubtitleRun] = []
        let full = NSRange(location: 0, length: attributed.length)
        attributed.enumerateAttributes(in: full, options: []) { attrs, range, _ in
            let text = attributed.attributedSubstring(from: range).string
            guard !text.isEmpty else { return }
            let bold = (attrs[NSAttributedString.Key(kCMTextMarkupAttribute_BoldStyle as String)] as? Bool) ?? false
            let italic = (attrs[NSAttributedString.Key(kCMTextMarkupAttribute_ItalicStyle as String)] as? Bool) ?? false
            runs.append(SubtitleRun(text: text, bold: bold, italic: italic))
        }
        return runs
    }
}

// MARK: - Overlay view

/// Draws subtitle cues as a no-box, app-styled overlay. Sits above the
/// AVPlayerLayer and below the transparent WebView. Font size tracks view
/// height so it scales with rotation and surface size.
final class SubtitleOverlayView: UIView {
    private let label = UILabel()
    private var style = SubtitleStyle()
    private var cues: [[SubtitleRun]] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        label.numberOfLines = 0
        label.textAlignment = .center
        label.lineBreakMode = .byWordWrapping
        addSubview(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(_ style: SubtitleStyle) {
        self.style = style
        rebuild()
    }

    /// Replace the displayed cues. Empty array clears the overlay.
    func render(_ cues: [[SubtitleRun]]) {
        self.cues = cues
        rebuild()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        rebuild()
    }

    private func rebuild() {
        guard bounds.height > 0 else { return }
        let visible = cues.filter { !$0.isEmpty }
        if visible.isEmpty {
            label.attributedText = nil
            label.isHidden = true
            return
        }
        label.isHidden = false
        label.attributedText = buildAttributed(visible)
        positionLabel()
    }

    private func buildAttributed(_ lines: [[SubtitleRun]]) -> NSAttributedString {
        // Size to the screen's short side so captions stay the same size in
        // portrait and landscape (the short side is orientation-invariant),
        // rather than the full height (oversized in portrait) or the
        // letterboxed video band (undersized in portrait).
        let pointSize = max(8, min(bounds.width, bounds.height) * 0.05 * style.fontScale)
        let base = UIFont.systemFont(ofSize: pointSize, weight: .semibold)
        let out = NSMutableAttributedString()
        for (lineIdx, runs) in lines.enumerated() {
            if lineIdx > 0 { out.append(NSAttributedString(string: "\n")) }
            for run in runs {
                var traits: UIFontDescriptor.SymbolicTraits = []
                if run.bold { traits.insert(.traitBold) }
                if run.italic { traits.insert(.traitItalic) }
                let font: UIFont
                if !traits.isEmpty, let desc = base.fontDescriptor.withSymbolicTraits(traits) {
                    font = UIFont(descriptor: desc, size: pointSize)
                } else {
                    font = base
                }
                var attrs: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: style.foregroundColor,
                ]
                if let bg = style.backgroundColor {
                    attrs[.backgroundColor] = bg
                }
                applyEdge(&attrs, pointSize: pointSize)
                out.append(NSAttributedString(string: run.text, attributes: attrs))
            }
        }
        return out
    }

    private func applyEdge(_ attrs: inout [NSAttributedString.Key: Any], pointSize: CGFloat) {
        switch style.edgeType {
        case "drop_shadow", "raised":
            let shadow = NSShadow()
            shadow.shadowColor = UIColor.black.withAlphaComponent(0.9)
            shadow.shadowOffset = CGSize(width: 0, height: 1)
            shadow.shadowBlurRadius = pointSize * 0.12
            attrs[.shadow] = shadow
        case "outline":
            attrs[.strokeColor] = UIColor.black
            attrs[.strokeWidth] = -3.0
        default:
            break
        }
    }

    private func positionLabel() {
        // Anchored to the bottom of the surface (the screen in fullscreen), not
        // the video rect, so captions sit below a letterboxed video in portrait.
        let maxWidth = bounds.width * 0.9
        let fit = label.sizeThatFits(CGSize(width: maxWidth, height: bounds.height))
        let w = min(fit.width, maxWidth)
        let bottomInset = bounds.height * style.bottomMarginFraction
        label.frame = CGRect(
            x: (bounds.width - w) / 2,
            y: max(0, bounds.height - bottomInset - fit.height),
            width: w,
            height: fit.height
        )
    }
}
