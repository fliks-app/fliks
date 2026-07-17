using System.Diagnostics;
using Fliks.Tray.Services;
using Fliks.Tray.Utilities;

namespace Fliks.Tray.State;

/// <summary>Orchestrates the full server lifecycle: PostgreSQL → Node backend
/// → ready, with crash recovery and a periodic Postgres health check.</summary>
internal sealed class AppState
{
    public ConfigStore Config { get; } = new();
    private readonly PostgresManager _postgres;
    private readonly NodeManager _node = new();
    private System.Threading.Timer? _healthTimer;

    private ServerState _state = ServerState.Stopped;

    public ServerState State
    {
        get => _state;
        private set { _state = value; StateChanged?.Invoke(value); }
    }

    /// <summary>Raised (on a background thread) whenever the state changes; the
    /// tray marshals it onto the UI thread.</summary>
    public event Action<ServerState>? StateChanged;

    public AppState()
    {
        _postgres = new PostgresManager(Config.PgPort);
        _node.OnCrash = HandleNodeCrash;
    }

    public async Task StartAllAsync()
    {
        try
        {
            AppPaths.EnsureStructure();
            Log.Info($"startup: exe={Environment.ProcessPath} repoRoot={AppPaths.RepoRoot ?? "(installed)"}");
            Log.Info($"paths: node={AppPaths.NodeExe} main={AppPaths.BackendMainJs} pgBin={AppPaths.PgBinDir} client={AppPaths.ClientDir} data={AppPaths.AppData}");

            State = ServerState.StartingPostgres;
            Log.Info("postgres: initialize");
            await _postgres.InitializeAsync();
            Log.Info("postgres: start");
            await _postgres.StartAsync();
            Log.Info("postgres: create database");
            await _postgres.CreateDatabaseIfNeededAsync();

            State = ServerState.StartingBackend;
            Log.Info("backend: start");
            await _node.StartAsync(new BackendEnvironment(Config.Port, Config.PgPort));

            State = ServerState.Running;
            Log.Info("running");
            StartHealthChecks();

            if (!Config.HasCompletedFirstLaunch)
            {
                OpenInBrowser();
                Config.HasCompletedFirstLaunch = true;
            }
        }
        catch (Exception ex)
        {
            Log.Error($"startup failed: {ex}");
            State = ServerState.Errored(ex.Message);
        }
    }

    public async Task ShutdownAsync()
    {
        State = ServerState.Stopping;
        _healthTimer?.Dispose();
        _healthTimer = null;
        await _node.StopAsync();
        await _postgres.StopAsync();
        State = ServerState.Stopped;
    }

    public async Task RestartAsync()
    {
        await ShutdownAsync();
        await StartAllAsync();
    }

    public void OpenInBrowser()
    {
        Process.Start(new ProcessStartInfo($"http://localhost:{Config.Port}")
        {
            UseShellExecute = true,
        });
    }

    public void OpenLogsFolder()
    {
        Directory.CreateDirectory(AppPaths.LogsDir);
        Process.Start(new ProcessStartInfo(AppPaths.LogsDir) { UseShellExecute = true });
    }

    private void HandleNodeCrash(int exitCode)
    {
        State = ServerState.Errored($"Backend crashed (exit {exitCode})");
        _ = Task.Run(async () =>
        {
            await Task.Delay(3000);
            if (State.Phase != ServerPhase.Error) return;
            State = ServerState.StartingBackend;
            try
            {
                await _node.StartAsync(new BackendEnvironment(Config.Port, Config.PgPort));
                State = ServerState.Running;
            }
            catch (Exception ex)
            {
                State = ServerState.Errored(ex.Message);
            }
        });
    }

    private void StartHealthChecks()
    {
        _healthTimer = new System.Threading.Timer(async _ =>
        {
            if (State.Phase != ServerPhase.Running) return;
            if (!await _postgres.IsReadyAsync() && State.Phase == ServerPhase.Running)
                await RestartAsync();
        }, null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
    }
}
