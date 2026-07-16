using System.Diagnostics;
using Fliks.Tray.Utilities;

namespace Fliks.Tray.Services;

/// <summary>Backend environment injected into the Node process.</summary>
internal sealed record BackendEnvironment(ushort Port, ushort DbPort)
{
    public IReadOnlyDictionary<string, string> AsEnvironment()
    {
        // ffmpeg first on PATH — the backend spawns `ffmpeg`/`ffprobe` by name.
        var nodeDir = Path.GetDirectoryName(AppPaths.NodeExe) ?? "";
        var systemPath = Environment.GetEnvironmentVariable("PATH") ?? "";
        var path = string.Join(Path.PathSeparator,
            new[] { AppPaths.FfmpegBinDir, nodeDir, systemPath });

        return new Dictionary<string, string>
        {
            ["NODE_ENV"] = "production",
            ["PORT"] = Port.ToString(),
            ["DB_HOST"] = "127.0.0.1",
            ["DB_PORT"] = DbPort.ToString(),
            ["DB_USERNAME"] = "fliks",
            ["DB_PASSWORD"] = "fliks",
            ["DB_NAME"] = "fliks",
            ["SERVE_STATIC_PATH"] = AppPaths.ClientDir,
            ["FLIKS_CONF_DIR"] = AppPaths.ConfDir,
            ["FLIKS_TRANSCODE_DIR"] = AppPaths.TranscodeDir,
            ["PATH"] = path,
            ["UV_THREADPOOL_SIZE"] = "16",
            ["TMDB_API_KEY"] = BuildConfig.TmdbApiKey,
            ["TVDB_API_KEY"] = BuildConfig.TvdbApiKey,
        };
    }
}

/// <summary>Backend Node process: spawn, monitor, crash recovery, shutdown.
/// The script runs by absolute path so node_modules resolves from the backend
/// dir, while cwd stays on the writable data dir (images/, thumbnails/,
/// backups/ are created there) — no symlinks or junctions.</summary>
internal sealed class NodeManager
{
    private Process? _process;
    private StreamWriter? _logWriter;
    private bool _intentionalStop;

    /// <summary>Fired when the backend exits unexpectedly (non-zero, not stopped
    /// by us). The int is the exit code.</summary>
    public Action<int>? OnCrash { get; set; }

    public bool IsRunning => _process is { HasExited: false };

    public async Task StartAsync(BackendEnvironment config)
    {
        _intentionalStop = false;
        Directory.CreateDirectory(AppPaths.DataDir);
        Directory.CreateDirectory(AppPaths.LogsDir);

        if (!File.Exists(AppPaths.NodeExe))
            throw new FileNotFoundException($"node.exe not found: {AppPaths.NodeExe}");
        if (!File.Exists(AppPaths.BackendMainJs))
            throw new FileNotFoundException($"backend main.js not found: {AppPaths.BackendMainJs}");
        Log.Info($"backend spawn: {AppPaths.NodeExe} {AppPaths.BackendMainJs} (cwd={AppPaths.DataDir})");

        var proc = new Process();
        proc.StartInfo.FileName = AppPaths.NodeExe;
        proc.StartInfo.ArgumentList.Add(AppPaths.BackendMainJs);
        proc.StartInfo.WorkingDirectory = AppPaths.DataDir;
        proc.StartInfo.UseShellExecute = false;
        proc.StartInfo.CreateNoWindow = true;
        proc.StartInfo.RedirectStandardOutput = true;
        proc.StartInfo.RedirectStandardError = true;
        foreach (var (k, v) in config.AsEnvironment()) proc.StartInfo.Environment[k] = v;

        _logWriter = OpenDailyLog();
        proc.OutputDataReceived += (_, e) => WriteLog(e.Data);
        proc.ErrorDataReceived += (_, e) => WriteLog(e.Data);

        proc.EnableRaisingEvents = true;
        proc.Exited += (_, _) =>
        {
            var code = proc.ExitCode;
            Log.Info($"backend exited: code={code} intentional={_intentionalStop}");
            if (code != 0 && !_intentionalStop) OnCrash?.Invoke(code);
        };

        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        _process = proc;

        await WaitForHttpReadyAsync(config.Port, TimeSpan.FromSeconds(120));
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
        Cleanup();
    }

    private void Cleanup()
    {
        _logWriter?.Dispose();
        _logWriter = null;
        _process = null;
    }

    private static StreamWriter OpenDailyLog()
    {
        var file = Path.Combine(AppPaths.LogsDir, $"backend-{DateTime.Now:yyyy-MM-dd}.log");
        var writer = new StreamWriter(file, append: true) { AutoFlush = true };
        writer.WriteLine($"\n--- Fliks backend started at {DateTime.Now:O} ---");
        return writer;
    }

    private void WriteLog(string? line)
    {
        if (line is not null) _logWriter?.WriteLine(line);
    }

    private static async Task WaitForHttpReadyAsync(ushort port, TimeSpan timeout)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var url = $"http://127.0.0.1:{port}/api";
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var response = await http.GetAsync(url);
                if ((int)response.StatusCode < 500) return;
            }
            catch
            {
                // Connection refused — not up yet.
            }
            await Task.Delay(1000);
        }
        throw new TimeoutException("Backend did not become ready in time");
    }
}
