using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Fliks.Setup;

/// <summary>The web client's dark theme (daisyUI base-100 / primary).</summary>
internal static class Theme
{
    public static readonly Color Background = Color.FromArgb(0x1d, 0x23, 0x2a);
    public static readonly Color Track = Color.FromArgb(0x2a, 0x32, 0x3c);
    public static readonly Color Accent = Color.FromArgb(0x7a, 0x3f, 0xf2);
    public static readonly Color Foreground = Color.FromArgb(0xf3, 0xf4, 0xf6);
    public static readonly Color Muted = Color.FromArgb(0x9c, 0xa3, 0xaf);
    public static readonly Color Danger = Color.FromArgb(0xf8, 0x71, 0x71);
    public static readonly Color DangerFill = Color.FromArgb(0xdc, 0x26, 0x26);

    public static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        var path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

/// <summary>Rounded progress bar: a determinate fill, or an accent segment sweeping the
/// track while <see cref="Indeterminate"/>.</summary>
internal sealed class PillBar : Control
{
    private readonly Timer _timer = new() { Interval = 16 };
    private float _value;
    private float _phase;
    private bool _indeterminate;

    public PillBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        _timer.Tick += (_, _) => { _phase = (_phase + 0.012f) % 1f; Invalidate(); };
    }

    public float Value
    {
        get => _value;
        set { _value = Math.Max(0f, Math.Min(1f, value)); Invalidate(); }
    }

    public bool Indeterminate
    {
        get => _indeterminate;
        set { _indeterminate = value; _timer.Enabled = value && Visible; Invalidate(); }
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        _timer.Enabled = _indeterminate && Visible;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Theme.Background);
        float radius = Height / 2f;
        using (var track = new SolidBrush(Theme.Track))
        using (var path = Theme.RoundedRect(new RectangleF(0, 0, Width, Height), radius))
            g.FillPath(track, path);

        RectangleF fill;
        if (_indeterminate)
        {
            var segment = Width * 0.35f;
            // Ease in-out so the segment accelerates off one edge and settles into the other.
            var t = _phase < 0.5f ? 2 * _phase * _phase : 1 - (float)Math.Pow(-2 * _phase + 2, 2) / 2;
            fill = new RectangleF(-segment + t * (Width + segment), 0, segment, Height);
            g.SetClip(new Rectangle(0, 0, Width, Height));
        }
        else
        {
            if (_value <= 0) return;
            fill = new RectangleF(0, 0, Math.Max(Height, Width * _value), Height);
        }
        using var accent = new SolidBrush(Theme.Accent);
        using var fillPath = Theme.RoundedRect(fill, radius);
        g.FillPath(accent, fillPath);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _timer.Dispose();
        base.Dispose(disposing);
    }
}

internal enum ButtonKind { Primary, Secondary, Danger }

/// <summary>Rounded button: a filled accent or danger action, or an outline.</summary>
internal sealed class RoundButton : Button
{
    private bool _hover;
    private ButtonKind _kind;

    public RoundButton(ButtonKind kind)
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.UserPaint, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Font = new Font("Segoe UI Semibold", 10.5f);
        Cursor = Cursors.Hand;
        Kind = kind;
    }

    public ButtonKind Kind
    {
        get => _kind;
        set { _kind = value; ForeColor = value == ButtonKind.Secondary ? Theme.Foreground : Color.White; Invalidate(); }
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Theme.Background);
        var r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
        using (var path = Theme.RoundedRect(r, Height / 4f))
        {
            if (_kind != ButtonKind.Secondary)
            {
                var fill = _kind == ButtonKind.Danger ? Theme.DangerFill : Theme.Accent;
                using var brush = new SolidBrush(_hover ? ControlPaint.Light(fill, 0.2f) : fill);
                g.FillPath(brush, path);
            }
            else
            {
                using var brush = new SolidBrush(_hover ? Theme.Track : Theme.Background);
                using var pen = new Pen(Theme.Track, 1f);
                g.FillPath(brush, path);
                g.DrawPath(pen, path);
            }
        }
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, ForeColor,
            // VerticalCenter only applies with SingleLine.
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        if (Focused && ShowFocusCues)
        {
            using var pen = new Pen(Color.FromArgb(160, Color.White), 1f) { DashStyle = DashStyle.Dot };
            g.DrawRectangle(pen, 4, 4, Width - 9, Height - 9);
        }
    }
}

/// <summary>The borderless window's close glyph.</summary>
internal sealed class CloseButton : Control
{
    private bool _hover;

    public CloseButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                 | ControlStyles.UserPaint, true);
        Cursor = Cursors.Hand;
        AccessibleName = "Close";
        AccessibleRole = AccessibleRole.PushButton;
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Theme.Background);
        if (_hover)
        {
            using var hover = new SolidBrush(Theme.Track);
            using var path = Theme.RoundedRect(new RectangleF(0, 0, Width - 1, Height - 1), Height / 4f);
            g.FillPath(hover, path);
        }
        var inset = Width * 0.34f;
        using var pen = new Pen(_hover ? Theme.Foreground : Theme.Muted, Math.Max(1.5f, Width / 20f));
        g.DrawLine(pen, inset, inset, Width - inset, Height - inset);
        g.DrawLine(pen, Width - inset, inset, inset, Height - inset);
    }
}
