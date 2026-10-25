using System.Diagnostics;
using System.Text;
using Fliks.Tray.Utilities;

namespace Fliks.Tray.Services;

/// <summary>Environment injected into the engine and its fliks-server child.</summary>
internal sealed record ServerEnvironment(ushort Port, ushort DbPort)
{
    public IReadOnlyDictionary<string, string> AsEnvironment()
    {
        // ffmpeg + pg_dump/psql first on PATH: the engine and the server spawn them by name.
        var systemPath = Environment.GetEnvironmentVariable("PATH") ?? "";
        var path = string.Join(Path.PathSeparator,
            new[] { AppPaths.FfmpegBinDir, AppPaths.PgBinDir, systemPath });

        return new Dictionary<string, string>
        {
            ["PORT"] = Port.ToString(),
            ["FLIKS_BIND"] = "127.0.0.1",
            ["DB_HOST"] = "127.0.0.1",
            ["DB_PORT"] = DbPort.ToString(),
            ["DB_USERNAME"] = "fliks",
            ["DB_PASSWORD"] = "fliks",
            ["DB_NAME"] = "fliks",
            ["SERVE_STATIC_PATH"] = AppPaths.ClientDir,
            ["FLIKS_SUPERVISED"] = "1",
            ["FLIKS_CONF_DIR"] = AppPaths.ConfDir,
            ["FLIKS_TRANSCODE_DIR"] = AppPaths.TranscodeDir,
            ["PATH"] = path,
            ["FLIKS_CAST_DIR"] = AppPaths.CastDir,
            ["TMDB_API_KEY"] = BuildConfig.TmdbApiKey,
            ["TVDB_API_KEY"] = BuildConfig.TvdbApiKey,
        };
    }
}

/// <summary>The engine supervising fliks-server: spawn, monitor, crash recovery,
/// shutdown. The cwd is the writable data dir (images/ and backups/ of existing
/// installs live there).</summary>
internal sealed class ServerManager
{
    private Process? _process;
    private JobObject? _job;
    private FileStream? _logStream;
    private readonly object _logGate = new();
    private bool _intentionalStop;

    /// <summary>Fired when the server exits unexpectedly (non-zero, not stopped
    /// by us). The int is the exit code.</summary>
    public Action<int>? OnCrash { get; set; }

    public bool IsRunning => _process is { HasExited: false };

    public async Task StartAsync(ServerEnvironment config, CancellationToken ct)
    {
        _intentionalStop = false;
        Directory.CreateDirectory(AppPaths.DataDir);
        Directory.CreateDirectory(AppPaths.LogsDir);

        var engine = AppPaths.EngineExe ?? throw new FileNotFoundException($"fliks-engine.exe not found in {AppPaths.BinDir}");
        Log.Info($"server spawn: {engine} supervising fliks-server (cwd={AppPaths.DataDir})");
        var proc = new Process();
        proc.StartInfo.FileName = engine;
        // The engine owns the public port; fliks-server listens on port + 1 behind it.
        foreach (var a in new[] { "--supervise", "--public-listen", $"0.0.0.0:{config.Port}",
                     "--upstream", $"http://127.0.0.1:{config.Port + 1}", "--",
                     Path.Combine(AppPaths.BinDir, "fliks-server.exe") })
            proc.StartInfo.ArgumentList.Add(a);
        proc.StartInfo.WorkingDirectory = AppPaths.DataDir;
        proc.StartInfo.UseShellExecute = false;
        proc.StartInfo.CreateNoWindow = true;
        proc.StartInfo.RedirectStandardOutput = true;
        proc.StartInfo.RedirectStandardError = true;
        foreach (var (k, v) in config.AsEnvironment()) proc.StartInfo.Environment[k] = v;

        // Windows doesn't kill children with their parent: the engine, the server
        // and their ffmpeg runs share a job, closed as soon as the engine exits.
        var job = new JobObject();
        proc.EnableRaisingEvents = true;
        proc.Exited += (_, _) =>
        {
            job.Dispose();
            var code = proc.ExitCode;
            Log.Info($"server exited: code={code} intentional={_intentionalStop}");
            if (code != 0 && !_intentionalStop) OnCrash?.Invoke(code);
        };

        proc.Start();
        try { job.Assign(proc); }
        catch (System.ComponentModel.Win32Exception) when (proc.HasExited) { /* Exited already closed it */ }
        _job = job;
        _logStream = OpenDailyLog();
        // Copy the child's raw bytes to the log — the server emits UTF-8, so passing
        // the bytes through untouched avoids any code-page transcode.
        PumpToLog(proc.StandardOutput.BaseStream);
        PumpToLog(proc.StandardError.BaseStream);
        _process = proc;

        await WaitForHttpReadyAsync(config.Port, TimeSpan.FromSeconds(120), ct);
    }

    public async Task StopAsync()
    {
        _intentionalStop = true;
        var proc = _process;
        if (proc is null || proc.HasExited) { Cleanup(); return; }

        try { proc.CloseMainWindow(); } catch { /* no window */ }
        try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }

        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (!proc.HasExited && DateTime.UtcNow < deadline) await Task.Delay(200);
        _job?.Dispose();
        Cleanup();
    }

    private void Cleanup()
    {
        lock (_logGate)
        {
            _logStream?.Dispose();
            _logStream = null;
        }
        _process = null;
        _job = null;
    }

    private static FileStream OpenDailyLog()
    {
        var file = Path.Combine(AppPaths.LogsDir, $"server-{DateTime.Now:yyyy-MM-dd}.log");
        var fs = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        var header = Encoding.UTF8.GetBytes($"\n--- Fliks server started at {DateTime.Now:O} ---\n");
        fs.Write(header, 0, header.Length);
        fs.Flush();
        return fs;
    }

    /// <summary>Drain a child output stream into the log file (flushed per
    /// chunk, serialised with the sibling stream via _logGate).</summary>
    private void PumpToLog(Stream source) => _ = Task.Run(async () =>
    {
        var buffer = new byte[8192];
        try
        {
            int read;
            while ((read = await source.ReadAsync(buffer)) > 0)
            {
                lock (_logGate)
                {
                    _logStream?.Write(buffer, 0, read);
                    _logStream?.Flush();
                }
            }
        }
        catch
        {
            // Stream closed on process exit.
        }
    });

    private static async Task WaitForHttpReadyAsync(ushort port, TimeSpan timeout, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var url = $"http://127.0.0.1:{port}/api/system/liveness";
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var response = await http.GetAsync(url, ct);
                if ((int)response.StatusCode < 500) return;
            }
            catch when (!ct.IsCancellationRequested)
            {
                // Connection refused — not up yet.
            }
            await Task.Delay(1000, ct);
        }
        throw new TimeoutException("Server did not become ready in time");
    }
}
