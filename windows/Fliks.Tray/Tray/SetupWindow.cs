using Fliks.Tray.State;

namespace Fliks.Tray.Tray;

/// <summary>First-launch progress window. Its button hands the browser launch a user
/// click, which Windows needs before it lets the browser take the foreground.</summary>
internal sealed class SetupWindow : Form
{
    private readonly AppState _app;
    private readonly Label _title = new()
    {
        AutoSize = true,
        Font = new Font(SystemFonts.MessageBoxFont!.FontFamily, 12f, FontStyle.Bold),
    };
    private readonly Label _status = new() { AutoSize = true, MaximumSize = new Size(360, 0) };
    private readonly ProgressBar _progress = new()
    {
        Style = ProgressBarStyle.Marquee,
        Width = 360,
        Margin = new Padding(3, 12, 3, 12),
    };
    private readonly Button _action = new() { AutoSize = true, Visible = false };

    public SetupWindow(AppState app)
    {
        _app = app;
        Text = "Fliks Server";
        Icon = TrayApplicationContext.LoadIcon(SystemInformation.IconSize);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(24);

        var logo = new PictureBox
        {
            Image = TrayApplicationContext.LoadIcon(new Size(64, 64)).ToBitmap(),
            SizeMode = PictureBoxSizeMode.AutoSize,
            Margin = new Padding(3, 3, 3, 12),
        };
        var layout = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
        };
        layout.Controls.AddRange(new Control[] { logo, _title, _status, _progress, _action });
        Controls.Add(layout);

        _action.Click += OnAction;
        _app.StateChanged += OnStateChanged;
        FormClosed += (_, _) => _app.StateChanged -= OnStateChanged;
        Shown += (_, _) => Render(_app.State);
        Render(_app.State);
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
                _status.Text = "Your server is set up and running.";
                _action.Text = "Open Fliks";
                break;
            case ServerPhase.Error:
                _title.Text = "Fliks Server failed to start";
                _status.Text = state.Message ?? "See the logs for details.";
                _action.Text = "Open Logs";
                break;
            default:
                _title.Text = "Setting up Fliks Server";
                _status.Text = $"{state.DisplayText}\nThe first launch can take a few minutes.";
                break;
        }
        var done = state.Phase is ServerPhase.Running or ServerPhase.Error;
        _progress.Visible = !done;
        _action.Visible = done;
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
}
