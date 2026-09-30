using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Fliks.Setup;

/// <summary>Runs the embedded Velopack Setup.exe silently behind a themed window. Velopack reports
/// no progress in silent mode, so the bar follows the install folder filling up.</summary>
internal sealed class SetupForm : Form
{
    private readonly SetupConfig _config;
    private readonly string _temp = Path.Combine(Path.GetTempPath(), "fliks-setup-" + Guid.NewGuid().ToString("N"));
    private readonly Label _title;
    private readonly Label _step;
    private readonly Label _hint;
    private readonly PillBar _bar = new() { Anchor = AnchorStyles.None };
    private readonly RoundButton _primary = new(ButtonKind.Primary) { Anchor = AnchorStyles.None, Visible = false };
    private readonly RoundButton _secondary = new(ButtonKind.Secondary) { Anchor = AnchorStyles.None, Visible = false };
    private readonly CloseButton _close = new();
    private readonly Timer _autoClose = new() { Interval = 5000 };
    private readonly float _scale;

    private Process? _setup;
    private bool _installing;
    private bool _cancelled;
    private Action? _primaryAction;
    private Action? _secondaryAction;
    private (string title, string step, string hint, bool bar)? _beforeConfirm;

    public SetupForm(SetupConfig config)
    {
        _config = config;
        Text = $"{config.Title} Setup";
        Icon = LoadIcon();
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Background;
        AutoScaleMode = AutoScaleMode.None;
        _scale = DeviceDpi / 96f;
        ClientSize = new Size(S(540), S(460));

        _title = Label(new Font("Segoe UI Semibold", 17f), Theme.Foreground);
        _step = Label(new Font("Segoe UI", 11f), Theme.Muted);
        _hint = Label(new Font("Segoe UI", 9.5f), Theme.Muted);

        var logo = new PictureBox
        {
            Image = new Icon(Icon, new Size(256, 256)).ToBitmap(),
            SizeMode = PictureBoxSizeMode.Zoom,
            Size = new Size(S(104), S(104)),
            Anchor = AnchorStyles.None,
            Margin = Pad(0, 16),
        };
        _title.Margin = Pad(0, 8);
        _step.Margin = Pad(0, 0);
        _hint.Margin = Pad(6, 0);
        _bar.Size = new Size(S(360), S(10));
        _bar.Margin = Pad(28, 0);
        foreach (var b in new[] { _primary, _secondary }) b.Size = new Size(S(180), S(44));

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            WrapContents = false,
            Anchor = AnchorStyles.None,
            Margin = Pad(24, 0),
        };
        _secondary.Margin = new Padding(0, 0, S(12), 0);
        _primary.Margin = Padding.Empty;
        buttons.Controls.AddRange(new Control[] { _secondary, _primary });

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            Padding = new Padding(S(32), S(36), S(32), S(28)),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        // Spacer rows keep the content vertically centred in the fixed window.
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
        foreach (var c in new Control[] { logo, _title, _step, _hint, _bar, buttons })
        {
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(c, 0, layout.RowStyles.Count - 1);
        }
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
        layout.RowCount = layout.RowStyles.Count;

        _close.Size = new Size(S(44), S(44));
        _close.Click += (_, _) => Close();
        Controls.Add(_close);
        Controls.Add(layout);
        _close.BringToFront();

        // Borderless: any non-button surface drags the window.
        foreach (var c in new Control[] { this, layout, logo, _title, _step, _hint, buttons })
            c.MouseDown += DragWindow;

        _primary.Click += (_, _) => _primaryAction?.Invoke();
        _secondary.Click += (_, _) => _secondaryAction?.Invoke();
        _autoClose.Tick += (_, _) => Close();
        Shown += async (_, _) => await RunAsync();
    }

    private int S(int px) => (int)Math.Round(px * _scale);
    private Padding Pad(int top, int bottom) => new(0, S(top), 0, S(bottom));

    private Label Label(Font font, Color color) => new()
    {
        AutoSize = true,
        MaximumSize = new Size(S(460), 0),
        Anchor = AnchorStyles.None,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = font,
        ForeColor = color,
    };

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        _close.Location = new Point(ClientSize.Width - _close.Width - S(12), S(12));
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Windows 11 rounds and borders the borderless window; older builds ignore both.
        var round = DwmRound;
        _ = DwmSetWindowAttribute(Handle, DwmCornerPreference, ref round, sizeof(int));
        var border = ColorTranslator.ToWin32(Theme.Track);
        _ = DwmSetWindowAttribute(Handle, DwmBorderColor, ref border, sizeof(int));
    }

    private async Task RunAsync()
    {
        var log = Path.Combine(_temp, "setup.log");
        try
        {
            _installing = true;
            SetView($"Installing {_config.Title}", "Preparing…", "", bar: true);
            var setupExe = await Task.Run(() => ExtractPayload(p => BeginInvoke(new Action(() => _bar.Value = p * 0.1f))));
            if (_cancelled) return;

            _step.Text = "Installing…";
            _setup = Process.Start(new ProcessStartInfo(setupExe, $"--silent --log \"{log}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            })!;
            var current = Path.Combine(_config.InstallDir, "current");
            long lastSize = -1;
            var lastGrowth = DateTime.UtcNow;
            var finishing = false;
            while (!_setup.HasExited)
            {
                await Task.Delay(500);
                if (_config.InstalledBytes <= 0 || _cancelled || finishing) continue;
                // Tens of thousands of files: walking them on the UI thread hangs the window.
                var size = await Task.Run(() => DirectorySize(current));
                if (_cancelled) continue;
                var ratio = Math.Min(1f, size / (float)_config.InstalledBytes);
                _bar.Value = Math.Max(_bar.Value, 0.1f + 0.88f * ratio);
                if (size != lastSize) { lastSize = size; lastGrowth = DateTime.UtcNow; }
                // Copy done: shortcuts, the app's install hook and the antivirus scan of the new
                // files follow, with nothing to measure.
                if (ratio >= 0.97f || (ratio > 0.5f && DateTime.UtcNow - lastGrowth > TimeSpan.FromSeconds(3)))
                {
                    finishing = true;
                    if (_beforeConfirm is null)
                        SetView($"Installing {_config.Title}", "Finishing the installation…",
                            "This step can take 1 to 2 minutes.", bar: true);
                    _bar.Indeterminate = true;
                }
            }
            _installing = false;
            if (_cancelled) return;
            if (_setup.ExitCode != 0)
            {
                Fail("The installation did not complete.", log);
                return;
            }
            _bar.Value = 1f;

            // Velopack's silent mode doesn't start the app; the root stub survives updates.
            Process.Start(new ProcessStartInfo(Path.Combine(_config.InstallDir, _config.MainExe))
            {
                UseShellExecute = true,
                WorkingDirectory = _config.InstallDir,
            });

            if (_config.ServerPort is not int port)
            {
                SetView($"{_config.Title} is installed", "Starting…", "", bar: false);
                _autoClose.Interval = 1500;
                _autoClose.Start();
                return;
            }

            SetView($"Setting up {_config.Title}", "Starting the server…", "This step can take 1 to 2 minutes.", bar: true);
            _bar.Indeterminate = true;
            // .NET Framework's HttpClient does proxy discovery and the connect synchronously on the
            // calling thread, which froze the window while the server wasn't listening yet.
            if (await Task.Run(() => WaitForServerAsync(port, TimeSpan.FromMinutes(10))))
            {
                // The tray opens the browser itself; the button covers it landing behind other windows.
                SetView($"{_config.Title} is ready", "Your server is set up and running.", "This window closes on its own.", bar: false);
                Buttons("Open Fliks", () => { OpenUrl($"http://localhost:{port}"); Close(); });
                _autoClose.Start();
            }
            else
            {
                SetView($"{_config.Title} is installed", "The server is still starting. Its status is in the tray.", "", bar: false);
                Buttons("Close", Close);
            }
        }
        catch (Exception ex)
        {
            _installing = false;
            if (!_cancelled) Fail(ex.Message, log);
        }
    }

    private string ExtractPayload(Action<float> progress)
    {
        Directory.CreateDirectory(_temp);
        var target = Path.Combine(_temp, "Setup.exe");
        using var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.exe")
                           ?? throw new InvalidOperationException("This setup carries no payload.");
        using var file = File.Create(target);
        var buffer = new byte[1 << 20];
        long copied = 0;
        int read;
        while (!_cancelled && (read = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            file.Write(buffer, 0, read);
            copied += read;
            progress(copied / (float)source.Length);
        }
        return target;
    }

    private static long DirectorySize(string dir)
    {
        try
        {
            return new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    private static async Task<bool> WaitForServerAsync(int port, TimeSpan timeout)
    {
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var response = await http.GetAsync($"http://127.0.0.1:{port}/api");
                if ((int)response.StatusCode < 500) return true;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                // Not listening yet.
            }
            await Task.Delay(1000);
        }
        return false;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_installing && !_cancelled)
        {
            e.Cancel = true;
            ConfirmCancel();
            return;
        }
        base.OnFormClosing(e);
    }

    private void ConfirmCancel()
    {
        if (_beforeConfirm is not null) return;
        _beforeConfirm = (_title.Text, _step.Text, _hint.Text, _bar.Visible);
        SetView("Do you really want to quit?", $"{_config.Title} will not be installed.", "", bar: false);
        Buttons("Yes", async () => await CancelInstallAsync(), "No", ResumeInstall, danger: true);
        _secondary.Focus();
    }

    private void ResumeInstall()
    {
        if (_beforeConfirm is not { } state) return;
        _beforeConfirm = null;
        SetView(state.title, state.step, state.hint, state.bar);
    }

    private async Task CancelInstallAsync()
    {
        _cancelled = true;
        SetView("Cancelling…", "Removing the installed files.", "", bar: true);
        _bar.Indeterminate = true;
        await Task.Run(() =>
        {
            try { if (_setup is { HasExited: false }) { _setup.Kill(); _setup.WaitForExit(10_000); } }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception) { /* already gone */ }
            // Velopack writes shortcuts and the uninstall entry last, so the folder is all there is.
            for (var i = 0; i < 5 && Directory.Exists(_config.InstallDir); i++)
            {
                try { Directory.Delete(_config.InstallDir, recursive: true); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { System.Threading.Thread.Sleep(500); }
            }
            RestorePreviousInstall();
        });
        Close();
    }

    // A reinstall first renames the existing install to "<packId>.<16 random chars>" for rollback,
    // which Velopack itself undoes on failure but not when killed.
    private void RestorePreviousInstall()
    {
        if (Directory.Exists(_config.InstallDir)) return;
        try
        {
            var backup = new DirectoryInfo(Path.GetDirectoryName(_config.InstallDir)!)
                .GetDirectories(_config.PackId + ".*")
                .Where(d => d.Name.Length == _config.PackId.Length + 17)
                .OrderByDescending(d => d.LastWriteTimeUtc)
                .FirstOrDefault();
            backup?.MoveTo(_config.InstallDir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Left for the next install, which starts clean.
        }
    }

    private void Fail(string message, string log)
    {
        SetView($"{_config.Title} could not be installed", message, "", bar: false, danger: true);
        Buttons("Open Log", () => { if (File.Exists(log)) OpenUrl(log); }, "Close", Close);
    }

    private void SetView(string title, string step, string hint, bool bar, bool danger = false)
    {
        _title.ForeColor = danger ? Theme.Danger : Theme.Foreground;
        _title.Text = title;
        _step.Text = step;
        _step.Visible = step.Length > 0;
        _hint.Text = hint;
        _hint.Visible = hint.Length > 0;
        _bar.Visible = bar;
        if (!bar) _bar.Indeterminate = false;
        _primary.Visible = _secondary.Visible = false;
    }

    private void Buttons(string primary, Action onPrimary, string? secondary = null, Action? onSecondary = null,
        bool danger = false)
    {
        _primary.Kind = danger ? ButtonKind.Danger : ButtonKind.Primary;
        _primary.Text = primary;
        _primaryAction = onPrimary;
        _primary.Visible = true;
        _secondary.Text = secondary ?? "";
        _secondaryAction = onSecondary;
        _secondary.Visible = secondary is not null;
        _primary.Focus();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        base.OnFormClosed(e);
        try { Directory.Delete(_temp, recursive: true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* Setup.exe still locked */ }
    }

    private static void OpenUrl(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Win32Exception) { /* no handler */ }
    }

    private static Icon LoadIcon()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico");
        return stream is not null ? new Icon(stream) : SystemIcons.Application;
    }

    private void DragWindow(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        ReleaseCapture();
        _ = SendMessage(Handle, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
    }

    private const int DwmCornerPreference = 33;
    private const int DwmBorderColor = 34;
    private const int DwmRound = 2;
    private const int WmNcLButtonDown = 0xA1;
    private const int HtCaption = 2;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
