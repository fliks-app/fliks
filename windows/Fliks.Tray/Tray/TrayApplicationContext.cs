using System.Reflection;
using Fliks.Tray.Services;
using Fliks.Tray.State;
using Fliks.Tray.Utilities;

namespace Fliks.Tray.Tray;

/// <summary>The tray: a <see cref="NotifyIcon"/> with a native menu that
/// drives the <see cref="AppState"/> orchestrator. State changes arrive on a
/// background thread and are marshalled onto the UI thread.</summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly AppState _app;
    private readonly NotifyIcon _icon;
    private readonly SynchronizationContext _ui;

    private readonly NativeMenu _menu = new();
    private readonly NativeMenu.Item _status;
    private readonly NativeMenu.Item _open;
    private readonly NativeMenu.Item _startAtLogin;
    private readonly NativeMenu.Item _restart;
    private readonly NativeMenu.Item _update;
    private readonly UpdateService _updates = new();
    private readonly System.Windows.Forms.Timer _updateTimer = new() { Interval = 30_000 };

    public TrayApplicationContext(bool openBrowserWhenReady)
    {
        _app = new AppState(openBrowserWhenReady);
        _ui = SynchronizationContext.Current ?? new SynchronizationContext();

        NativeMenu.FollowSystemTheme();
        _status = _menu.Add("");
        _status.Enabled = false;
        _menu.AddSeparator();
        _open = _menu.Add("Open Fliks", _app.OpenInBrowser);
        _update = _menu.Add("", () => _ = UpdateAsync());
        _update.Visible = false;
        _startAtLogin = _menu.Add("Start at Login", ToggleStartAtLogin);
        _startAtLogin.Checked = StartupRegistry.IsEnabled;
        _menu.AddSeparator();
        _restart = _menu.Add("Restart Server", () => _ = _app.RestartAsync());
        _menu.Add("View Logs…", _app.OpenLogsFolder);
        _menu.AddSeparator();
        _menu.Add("Quit Fliks", Quit);

        _icon = new NotifyIcon
        {
            Icon = LoadIcon(SystemInformation.SmallIconSize),
            Text = "Fliks",
            Visible = true,
        };
        _icon.MouseUp += (_, e) => { if (e.Button == MouseButtons.Right) _menu.ShowAtCursor(); };
        _icon.DoubleClick += (_, _) => _app.OpenInBrowser();

        _app.StateChanged += OnStateChanged;
        // Logoff / OS shutdown: stop postgres cleanly instead of letting it be killed.
        Microsoft.Win32.SystemEvents.SessionEnded += (_, _) => Quit();
        Render(_app.State);

        _updateTimer.Tick += async (_, _) =>
        {
            _updateTimer.Interval = (int)TimeSpan.FromHours(6).TotalMilliseconds;
            await CheckForUpdateAsync();
        };
        _updateTimer.Start();

        _ = _app.StartAllAsync();
    }

    private void OnStateChanged(ServerState state) => _ui.Post(_ => Render(state), null);

    private void Render(ServerState state)
    {
        _status.Text = state.DisplayText;
        // NotifyIcon tooltip is capped at 63 chars.
        _icon.Text = state.DisplayText.Length > 63
            ? state.DisplayText[..63]
            : state.DisplayText;
        _open.Enabled = state.Phase == ServerPhase.Running;
        _restart.Enabled = !state.IsStarting && state.Phase != ServerPhase.Stopping;

        if (state.Phase == ServerPhase.Error)
        {
            _icon.ShowBalloonTip(10000, "Fliks failed to start",
                state.Message ?? "Unknown error — see the tray-*.log in the logs folder.",
                ToolTipIcon.Error);
        }
    }

    private async Task CheckForUpdateAsync()
    {
        if (_update.Visible || !await _updates.CheckAsync()) return;
        _update.Text = $"Update to {_updates.AvailableVersion}";
        _update.Visible = true;
        _icon.ShowBalloonTip(10000, "Fliks Server update",
            $"Version {_updates.AvailableVersion} is available from the tray menu.", ToolTipIcon.Info);
    }

    private async Task UpdateAsync()
    {
        _update.Enabled = false;
        try
        {
            await _updates.DownloadAsync(p => _ui.Post(_ => _update.Text = $"Downloading update… {p}%", null));
            _update.Text = "Installing update…";
            _updateTimer.Stop();
            await Task.Run(_app.ShutdownAsync);
            _icon.Visible = false;
            _updates.ApplyAndRestart();
        }
        catch (Exception ex)
        {
            Log.Error($"update failed: {ex}");
            _update.Text = $"Update to {_updates.AvailableVersion}";
            _update.Enabled = true;
            _icon.ShowBalloonTip(10000, "Fliks Server update failed", ex.Message, ToolTipIcon.Error);
            if (_app.State.Phase == ServerPhase.Stopped) _ = _app.StartAllAsync();
        }
    }

    private void ToggleStartAtLogin()
    {
        var enabled = !_startAtLogin.Checked;
        StartupRegistry.SetEnabled(enabled);
        _startAtLogin.Checked = StartupRegistry.IsEnabled;
    }

    private void Quit()
    {
        _icon.Visible = false;
        // Bounded graceful shutdown so a hung child can't wedge exit.
        Task.Run(() => _app.ShutdownAsync()).Wait(TimeSpan.FromSeconds(20));
        _icon.Dispose();
        _menu.Dispose();
        ExitThread();
    }

    internal static Icon LoadIcon(Size size)
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            var name = asm
                .GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("fliks.ico", StringComparison.OrdinalIgnoreCase));
            if (name is not null)
            {
                using var stream = asm.GetManifestResourceStream(name);
                if (stream is not null) return new Icon(stream, size);
            }
            // Fallback: the exe's own embedded ApplicationIcon.
            if (Environment.ProcessPath is { } exe)
            {
                var extracted = Icon.ExtractAssociatedIcon(exe);
                if (extracted is not null) return extracted;
            }
        }
        catch
        {
            // Fall through to the system default.
        }
        return SystemIcons.Application;
    }
}
