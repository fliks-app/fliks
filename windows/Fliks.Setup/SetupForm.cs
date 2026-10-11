using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
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
    private readonly Timer _autoClose = new() { Interval = 1500 };
    private readonly float _scale;

    private Process? _setup;
    private bool _hadInstall;
    private bool _wasRunning;
    private List<string> _backupsBefore = new();
    private bool _installing;
    private bool _cancelled;
    private Action? _primaryAction;
    private Action? _secondaryAction;
    // The install keeps moving while the quit prompt is up: stages are recorded and shown on "No".
    private Stage _stage = new("", "", Bar: false);
    private bool _confirming;

    private sealed record Stage(string Step, string Hint, bool Bar, bool Indeterminate = false,
        bool Danger = false, string? Primary = null, Action? OnPrimary = null,
        string? Secondary = null, Action? OnSecondary = null);

    public SetupForm(SetupConfig config)
    {
        _config = config;
        Text = $"{config.Title} Setup";
        Icon = LoadIcon();
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Background;
        AutoScaleMode = AutoScaleMode.None;
        // DeviceDpi stays 96 outside per-monitor mode on .NET Framework; fonts still scale.
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) _scale = g.DpiX / 96f;
        ClientSize = new Size(S(560), S(380));

        _title = Label(new Font("Segoe UI Semibold", 17f), Theme.Foreground);
        _title.Text = Text;
        _step = Label(new Font("Segoe UI", 10f), Theme.Foreground);
        _hint = Label(new Font("Segoe UI", 9.5f), Theme.Muted);

        var logo = new PictureBox
        {
            Image = new Icon(Icon, new Size(256, 256)).ToBitmap(),
            SizeMode = PictureBoxSizeMode.Zoom,
            Size = new Size(S(88), S(88)),
            Anchor = AnchorStyles.None,
            Margin = Pad(0, 16),
        };
        _title.Margin = Pad(0, 14);
        _step.Margin = Pad(36, 0);
        _hint.Margin = Pad(6, 0);
        _bar.Size = new Size(S(320), S(8));
        _bar.Margin = Pad(12, 0);
        foreach (var b in new[] { _primary, _secondary }) b.Size = new Size(S(150), S(38));

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
        Shown += (_, _) => Enter(new Stage("Ready to install", $"{_config.Title} will be installed on this computer.",
            Bar: false, Primary: "Install", OnPrimary: async () => await RunAsync()));
    }

    private int S(int px) => (int)Math.Round(px * _scale);
    private Padding Pad(int top, int bottom) => new(0, S(top), 0, S(bottom));

    private Label Label(Font font, Color color) => new()
    {
        AutoSize = true,
        MaximumSize = new Size(S(480), 0),
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
            Enter(new Stage("Installing…", "This can take a few minutes.", Bar: true));
            var setupExe = await Task.Run(() => ExtractPayload(p => BeginInvoke(new Action(() => _bar.Value = p * 0.1f))));
            if (_cancelled) return;

            // What a cancel must undo depends on what was already here.
            _hadInstall = Directory.Exists(_config.InstallDir) && Directory.EnumerateFileSystemEntries(_config.InstallDir).Any();
            _wasRunning = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(_config.MainExe)).Length > 0;
            _backupsBefore = Backups().Select(d => d.FullName).ToList();
            _setup = Process.Start(new ProcessStartInfo(setupExe, $"--silent --log \"{log}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            })!;

            // Velopack logs each install step: copy the package into packages\, extract it into
            // current\, then shortcuts and the app's install hook, which report no progress.
            var finishing = false;
            DateTime? extractStart = null;
            while (!_setup.HasExited)
            {
                await Task.Delay(500);
                if (_cancelled) continue;
                var phase = ReadShared(log);
                // Setup then deletes the previous install's backup, minutes for tens of thousands of
                // files; it carries on in the background.
                if (phase.Contains("Installation completed successfully")) break;
                if (finishing) continue;
                if (phase.Contains("Creating shortcuts") || phase.Contains("install hook"))
                {
                    finishing = true;
                    _bar.Value = 1f;
                    Enter(new Stage("Finishing…", "This step can take a minute.", Bar: true, Indeterminate: true));
                    continue;
                }
                // Files, not bytes: the few large binaries land in seconds, the thousands of small
                // ones take the rest.
                var extracting = Regex.Match(phase, @"Extracting (\d+) app files");
                if (!extracting.Success) continue;
                var total = int.Parse(extracting.Groups[1].Value);
                // Tens of thousands of files: walking them on the UI thread hangs the window.
                var done = await Task.Run(() => FileCount(Path.Combine(_config.InstallDir, "current")));
                if (_cancelled || total <= 0) continue;
                _bar.Value = Math.Max(_bar.Value, 0.1f + 0.88f * Math.Min(1f, done / (float)total));

                extractStart ??= DateTime.UtcNow;
                var elapsed = (DateTime.UtcNow - extractStart.Value).TotalSeconds;
                // The first seconds' rate says little: the large files go first.
                if (done == 0 || elapsed < 15) continue;
                var left = elapsed * (total - done) / done;
                var hint = left < 60 ? "Less than a minute left." : $"About {Math.Ceiling(left / 60)} minutes left.";
                if (hint != _stage.Hint) Enter(new Stage("Installing…", hint, Bar: true));
            }
            _installing = false;
            if (_cancelled) return;
            // Nothing left to cancel: drop an open quit prompt.
            _confirming = false;
            if (_setup.HasExited && _setup.ExitCode != 0)
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
                Enter(new Stage("Installed", "Starting…", Bar: false));
                _autoClose.Start();
                return;
            }

            Enter(new Stage("Starting the server…", "This step can take 1 to 2 minutes.", Bar: true, Indeterminate: true));
            // .NET Framework's HttpClient does proxy discovery and the connect synchronously on the
            // calling thread, which froze the window while the server wasn't listening yet.
            if (await Task.Run(() => WaitForServerAsync(port, TimeSpan.FromMinutes(10))))
            {
                // The tray opens the browser once the server answers.
                Close();
            }
            else
            {
                Enter(new Stage("The server is still starting.", "Its status is in the tray.", Bar: false, Primary: "Close", OnPrimary: Close));
            }
        }
        catch (Exception ex)
        {
            _installing = false;
            _confirming = false;
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
        int read, percent = 0;
        while (!_cancelled && (read = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            file.Write(buffer, 0, read);
            copied += read;
            // One UI update per MB queues hundreds of invokes ahead of the first paint.
            var now = (int)(copied * 100 / source.Length);
            if (now == percent) continue;
            percent = now;
            progress(now / 100f);
        }
        return target;
    }

    private static int FileCount(string dir)
    {
        try
        {
            return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Count();
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
        if (_confirming) return;
        _confirming = true;
        SetView("Do you really want to quit?", $"{_config.Title} will not be installed.", bar: false);
        Buttons("Yes", async () => await CancelInstallAsync(), "No", ResumeInstall, danger: true);
        _secondary.Focus();
    }

    private void ResumeInstall()
    {
        _confirming = false;
        Render(_stage);
    }

    private async Task CancelInstallAsync()
    {
        _confirming = false;
        if (!_installing)
        {
            // It finished while the prompt was up; keep it.
            Render(_stage);
            return;
        }
        _cancelled = true;
        Render(new Stage("Cancelling…", "Removing the installed files.", Bar: true, Indeterminate: true));
        await Task.Run(UndoInstall);
        Close();
    }

    // Velopack writes shortcuts and the uninstall entry last, so the install folder is all a
    // killed run leaves. A reinstall first stops the running app and renames the existing
    // install to "<packId>.<16 random chars>" for rollback, which Velopack undoes on failure
    // but not when killed.
    private void UndoInstall()
    {
        try { if (_setup is { HasExited: false }) { _setup.Kill(); _setup.WaitForExit(10_000); } }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception) { /* already gone */ }
        if (_setup is null) return;

        var backup = Backups().FirstOrDefault(d => !_backupsBefore.Contains(d.FullName));
        // Killed before the rename: the folder is still the previous install.
        if (_hadInstall && backup is null) return;

        for (var i = 0; i < 5 && Directory.Exists(_config.InstallDir); i++)
        {
            try { Directory.Delete(_config.InstallDir, recursive: true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { System.Threading.Thread.Sleep(500); }
        }
        if (backup is null) return;
        try
        {
            backup.MoveTo(_config.InstallDir);
            if (_wasRunning)
                Process.Start(new ProcessStartInfo(Path.Combine(_config.InstallDir, _config.MainExe))
                {
                    UseShellExecute = true,
                    WorkingDirectory = _config.InstallDir,
                    Arguments = "--autostart",
                });
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception)
        {
            // Left in place for the next install to overwrite.
        }
    }

    private IEnumerable<DirectoryInfo> Backups()
    {
        try
        {
            return new DirectoryInfo(Path.GetDirectoryName(_config.InstallDir)!)
                .GetDirectories(_config.PackId + ".*")
                .Where(d => d.Name.Length == _config.PackId.Length + 17)
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Enumerable.Empty<DirectoryInfo>();
        }
    }

    private static string ReadShared(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            return reader.ReadToEnd();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return "";
        }
    }

    private void Fail(string message, string log) =>
        Enter(new Stage("The installation failed.", message, Bar: false, Danger: true,
            Primary: "Open Log", OnPrimary: () => { if (File.Exists(log)) OpenUrl(log); },
            Secondary: "Close", OnSecondary: Close));

    private void Enter(Stage stage)
    {
        _stage = stage;
        if (!_confirming) Render(stage);
    }

    private void Render(Stage stage)
    {
        SetView(stage.Step, stage.Hint, stage.Bar, stage.Danger);
        _bar.Indeterminate = stage.Indeterminate;
        if (stage.Primary is not null) Buttons(stage.Primary, stage.OnPrimary!, stage.Secondary, stage.OnSecondary);
    }

    private void SetView(string step, string hint, bool bar, bool danger = false)
    {
        _step.ForeColor = danger ? Theme.Danger : Theme.Foreground;
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
        if (!Directory.Exists(_temp)) return;
        // Deleting the fresh 270 MB Setup.exe waits minutes on the antivirus scan, and Setup may
        // still be running: a detached shell retries for up to five minutes.
        Process.Start(new ProcessStartInfo("cmd.exe",
            $"/d /c for /l %i in (1,1,60) do @if exist \"{_temp}\" (rmdir /s /q \"{_temp}\" 2>nul & ping -n 6 127.0.0.1 >nul)")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        });
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
