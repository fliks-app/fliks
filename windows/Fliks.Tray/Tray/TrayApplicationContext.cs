using Fliks.Tray.Services;
using Fliks.Tray.State;
using Fliks.Tray.Utilities;

namespace Fliks.Tray.Tray;

/// <summary>The tray: a <see cref="NotifyIcon"/> with a context menu that
/// drives the <see cref="AppState"/> orchestrator. State changes arrive on a
/// background thread and are marshalled onto the UI thread.</summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly AppState _app = new();
    private readonly NotifyIcon _icon;
    private readonly SynchronizationContext _ui;

    private readonly ToolStripMenuItem _status;
    private readonly ToolStripMenuItem _open;
    private readonly ToolStripMenuItem _startAtLogin;
    private readonly ToolStripMenuItem _restart;

    public TrayApplicationContext()
    {
        _ui = SynchronizationContext.Current ?? new SynchronizationContext();

        _status = new ToolStripMenuItem { Enabled = false };
        _open = new ToolStripMenuItem("Open Fliks", null, (_, _) => _app.OpenInBrowser());
        _startAtLogin = new ToolStripMenuItem("Start at Login", null, ToggleStartAtLogin)
        {
            Checked = StartupRegistry.IsEnabled,
        };
        _restart = new ToolStripMenuItem("Restart Server", null,
            async (_, _) => await _app.RestartAsync());
        var viewLogs = new ToolStripMenuItem("View Logs…", null, (_, _) => _app.OpenLogsFolder());
        var quit = new ToolStripMenuItem("Quit Fliks", null, (_, _) => Quit());

        var menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[]
        {
            _status,
            new ToolStripSeparator(),
            _open,
            _startAtLogin,
            new ToolStripSeparator(),
            _restart,
            viewLogs,
            new ToolStripSeparator(),
            quit,
        });

        _icon = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = "Fliks",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _icon.DoubleClick += (_, _) => _app.OpenInBrowser();

        _app.StateChanged += OnStateChanged;
        Render(_app.State);

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

    private void ToggleStartAtLogin(object? sender, EventArgs e)
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
        ExitThread();
    }

    private static Icon LoadIcon()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "Resources", "fliks.ico");
        try
        {
            if (File.Exists(bundled)) return new Icon(bundled);
        }
        catch
        {
            // Fall through to the system default.
        }
        return SystemIcons.Application;
    }
}
