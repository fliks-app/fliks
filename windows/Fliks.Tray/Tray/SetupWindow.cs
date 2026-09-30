using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using Fliks.Tray.State;

namespace Fliks.Tray.Tray;

/// <summary>First-launch progress window. Its button hands the browser launch a user
/// click, which Windows needs before it lets the browser take the foreground.</summary>
internal sealed class SetupWindow : Form
{
    // The web client's dark theme (daisyUI base-100 / primary).
    private static readonly Color Background = Color.FromArgb(0x1d, 0x23, 0x2a);
    private static readonly Color Track = Color.FromArgb(0x2a, 0x32, 0x3c);
    private static readonly Color Accent = Color.FromArgb(0x7a, 0x3f, 0xf2);
    private static readonly Color Foreground = Color.FromArgb(0xf3, 0xf4, 0xf6);
    private static readonly Color Muted = Color.FromArgb(0x9c, 0xa3, 0xaf);
    private static readonly Color Danger = Color.FromArgb(0xf8, 0x71, 0x71);

    private readonly AppState _app;
    private readonly Label _title = CenteredLabel(new Font("Segoe UI Semibold", 15f), Foreground);
    private readonly Label _step = CenteredLabel(new Font("Segoe UI", 10f), Muted);
    private readonly Label _hint = CenteredLabel(new Font("Segoe UI", 9f), Muted);
    private readonly SweepBar _bar = new() { Anchor = AnchorStyles.None };
    private readonly AccentButton _action = new() { Anchor = AnchorStyles.None, Visible = false };
    // The browser opens on its own; the ready screen stays a moment for the Open Fliks fallback.
    private readonly System.Windows.Forms.Timer _autoClose = new() { Interval = 5000 };

    public SetupWindow(AppState app)
    {
        _app = app;
        Text = "Fliks Server";
        Icon = TrayApplicationContext.LoadIcon(SystemInformation.IconSize);
        // Point-sized fonts already follow the DPI; pixel sizes are scaled by hand, and the
        // window sizes itself to its content so a larger font can never clip it.
        AutoScaleMode = AutoScaleMode.None;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Background;

        var scale = DeviceDpi / 96f;
        int S(int px) => (int)Math.Round(px * scale);
        Padding Pad(int top, int bottom) => new(0, S(top), 0, S(bottom));

        var logo = new PictureBox
        {
            Image = TrayApplicationContext.LoadIcon(new Size(256, 256)).ToBitmap(),
            SizeMode = PictureBoxSizeMode.Zoom,
            Size = new Size(S(80), S(80)),
            Anchor = AnchorStyles.None,
            Margin = Pad(0, 16),
        };
        foreach (var label in new[] { _title, _step, _hint }) label.MaximumSize = new Size(S(396), 0);
        _title.Margin = Pad(0, 6);
        _step.Margin = Pad(0, 0);
        _hint.Margin = Pad(4, 0);
        _bar.Size = new Size(S(280), S(4));
        _bar.Margin = Pad(22, 0);
        _action.Size = new Size(S(180), S(40));
        _action.Margin = Pad(18, 0);

        var layout = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            Padding = new Padding(S(32), S(28), S(32), S(28)),
            MinimumSize = new Size(S(460), 0),
            Margin = Padding.Empty,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        foreach (var c in new Control[] { logo, _title, _step, _hint, _bar, _action })
        {
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(c, 0, layout.RowStyles.Count - 1);
        }
        layout.RowCount = layout.RowStyles.Count;
        Controls.Add(layout);

        _action.Click += OnAction;
        _autoClose.Tick += (_, _) => Close();
        _app.StateChanged += OnStateChanged;
        FormClosed += (_, _) =>
        {
            _app.StateChanged -= OnStateChanged;
            _autoClose.Dispose();
        };
        Shown += (_, _) => Render(_app.State);
        Render(_app.State);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Dark title bar on Windows 10 20H1+ / 11; ignored on older builds.
        var on = 1;
        _ = DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int));
    }

    private void OnStateChanged(ServerState state)
    {
        if (!IsHandleCreated || IsDisposed) return;
        try { BeginInvoke(new Action(() => Render(state))); }
        catch (InvalidOperationException) { /* closing */ }
    }

    private void Render(ServerState state)
    {
        switch (state.Phase)
        {
            case ServerPhase.Running:
                _title.Text = "Fliks Server is ready";
                _title.ForeColor = Foreground;
                _step.Text = "Your server is set up and running.";
                _hint.Text = "This window closes on its own.";
                _action.Text = "Open Fliks";
                break;
            case ServerPhase.Error:
                _title.Text = "Fliks Server failed to start";
                _title.ForeColor = Danger;
                _step.Text = state.Message ?? "The logs have the details.";
                _hint.Text = "";
                _action.Text = "Open Logs";
                break;
            default:
                _title.Text = "Setting up Fliks Server";
                _title.ForeColor = Foreground;
                _step.Text = state.DisplayText;
                _hint.Text = "The first launch can take a few minutes.";
                break;
        }
        var done = state.Phase is ServerPhase.Running or ServerPhase.Error;
        _hint.Visible = state.Phase != ServerPhase.Error;
        _autoClose.Enabled = state.Phase == ServerPhase.Running;
        _bar.Visible = !done;
        _action.Visible = done;
        if (done) _action.Focus();
    }

    private void OnAction(object? sender, EventArgs e)
    {
        if (_app.State.Phase == ServerPhase.Running)
        {
            _app.OpenInBrowser();
            Close();
        }
        else
        {
            _app.OpenLogsFolder();
        }
    }

    private static Label CenteredLabel(Font font, Color color) => new()
    {
        AutoSize = true,
        Anchor = AnchorStyles.None,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = font,
        ForeColor = color,
    };

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    /// <summary>Indeterminate bar: an accent segment sweeping across a rounded track.</summary>
    private sealed class SweepBar : Control
    {
        private readonly System.Windows.Forms.Timer _timer = new() { Interval = 16 };
        private float _phase;

        public SweepBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            _timer.Tick += (_, _) => { _phase = (_phase + 0.012f) % 1f; Invalidate(); };
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            _timer.Enabled = Visible;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Background);
            using (var track = new SolidBrush(Track)) FillPill(g, track, 0, Width);

            var segment = Width * 0.35f;
            // Ease in-out so the segment accelerates off one edge and settles into the other.
            var t = _phase < 0.5f ? 2 * _phase * _phase : 1 - MathF.Pow(-2 * _phase + 2, 2) / 2;
            var x = -segment + t * (Width + segment);
            g.SetClip(new Rectangle(0, 0, Width, Height));
            using var accent = new SolidBrush(Accent);
            FillPill(g, accent, x, segment);
        }

        private void FillPill(Graphics g, Brush brush, float x, float width)
        {
            using var path = new GraphicsPath();
            float d = Height;
            path.AddArc(x, 0, d, d, 90, 180);
            path.AddArc(x + width - d, 0, d, d, 270, 180);
            path.CloseFigure();
            g.FillPath(brush, path);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _timer.Dispose();
            base.Dispose(disposing);
        }
    }

    /// <summary>Flat accent button with rounded corners.</summary>
    private sealed class AccentButton : Button
    {
        private bool _hover;

        public AccentButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Font = new Font("Segoe UI Semibold", 10f);
            ForeColor = Color.White;
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Background);
            var fill = _hover ? ControlPaint.Light(Accent, 0.2f) : Accent;
            using (var brush = new SolidBrush(fill))
            using (var path = new GraphicsPath())
            {
                var r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
                float d = LogicalToDeviceUnits(16);
                path.AddArc(r.X, r.Y, d, d, 180, 90);
                path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
                path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                path.CloseFigure();
                g.FillPath(brush, path);
            }
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, ForeColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            if (Focused && ShowFocusCues)
            {
                using var pen = new Pen(Color.FromArgb(160, Color.White), 1f) { DashStyle = DashStyle.Dot };
                g.DrawRectangle(pen, 4, 4, Width - 9, Height - 9);
            }
        }
    }
}
