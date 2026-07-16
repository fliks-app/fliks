using Fliks.Tray.Utilities;

namespace Fliks.Tray.Services;

/// <summary>Embedded PostgreSQL 18 lifecycle (EDB Windows binaries): init,
/// start, health check, database creation, stop. The EDB layout ships its
/// DLLs alongside the executables, so no library-path env is needed.
/// postgres.exe refuses to run elevated, so the tray must stay unelevated.</summary>
internal sealed class PostgresManager(ushort port = 5433)
{
    private readonly string _binDir = AppPaths.PgBinDir;
    private readonly string _dataDir = AppPaths.PgDataDir;
    private readonly string _logFile = AppPaths.PgLogFile;

    private string Tool(string name) => Path.Combine(_binDir, name + ".exe");

    private static void LogResult(string tool, ProcessResult r) =>
        Log.Info($"pg {tool}: exit={r.ExitCode}" +
                 (r.Stdout.Length > 0 ? $" stdout={r.Stdout}" : "") +
                 (r.Stderr.Length > 0 ? $" stderr={r.Stderr}" : ""));

    private IReadOnlyDictionary<string, string> PgEnv => new Dictionary<string, string>
    {
        ["PGDATA"] = _dataDir,
    };

    /// <summary>Run initdb on first launch (no PG_VERSION file yet).</summary>
    public async Task InitializeAsync()
    {
        if (File.Exists(Path.Combine(_dataDir, "PG_VERSION"))) return;

        Directory.CreateDirectory(_dataDir);
        var result = await ProcessRunner.RunAsync(
            Tool("initdb"),
            new[]
            {
                "-D", _dataDir,
                "--auth=trust",
                "--username=fliks",
                "--encoding=UTF-8",
                "--locale=C",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(120));

        LogResult("initdb", result);
        if (!result.Succeeded)
            throw new InvalidOperationException($"initdb failed: {result.Stderr}");

        TweakConfig();
    }

    /// <summary>Start the server and wait until it accepts connections.</summary>
    public async Task StartAsync()
    {
        var result = await ProcessRunner.RunAsync(
            Tool("pg_ctl"),
            new[]
            {
                "-D", _dataDir,
                "-l", _logFile,
                "-o", $"-p {port}",
                "-w",
                "start",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(60));

        LogResult("pg_ctl start", result);
        if (!result.Succeeded)
            throw new InvalidOperationException($"pg_ctl start failed: {result.Stderr}");

        await WaitForReadyAsync(TimeSpan.FromSeconds(30));
    }

    /// <summary>Create the <c>fliks</c> database and pg_trgm extension if absent.</summary>
    public async Task CreateDatabaseIfNeededAsync()
    {
        var check = await ProcessRunner.RunAsync(
            Tool("psql"),
            new[]
            {
                "-h", "localhost", "-p", port.ToString(), "-U", "fliks", "-d", "postgres",
                "-tAc", "SELECT 1 FROM pg_database WHERE datname = 'fliks'",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(10));

        LogResult("psql exists-check", check);
        if (check.Stdout.Trim() != "1")
        {
            var created = await ProcessRunner.RunAsync(
                Tool("createdb"),
                new[] { "-h", "localhost", "-p", port.ToString(), "-U", "fliks", "fliks" },
                PgEnv,
                timeout: TimeSpan.FromSeconds(10));
            LogResult("createdb", created);
            if (!created.Succeeded && !created.Stderr.Contains("already exists"))
                throw new InvalidOperationException($"createdb failed: {created.Stderr}");
        }

        var ext = await ProcessRunner.RunAsync(
            Tool("psql"),
            new[]
            {
                "-h", "localhost", "-p", port.ToString(), "-U", "fliks", "-d", "fliks",
                "-c", "CREATE EXTENSION IF NOT EXISTS pg_trgm",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(10));
        LogResult("psql pg_trgm", ext);
    }

    public async Task<bool> IsReadyAsync()
    {
        var result = await ProcessRunner.RunAsync(
            Tool("pg_isready"),
            new[] { "-h", "localhost", "-p", port.ToString(), "-U", "fliks" },
            PgEnv,
            timeout: TimeSpan.FromSeconds(5));
        return result.Succeeded;
    }

    public async Task StopAsync()
    {
        await ProcessRunner.RunAsync(
            Tool("pg_ctl"),
            new[] { "-D", _dataDir, "-m", "fast", "-w", "stop" },
            PgEnv,
            timeout: TimeSpan.FromSeconds(20));
    }

    private async Task WaitForReadyAsync(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (await IsReadyAsync()) return;
            await Task.Delay(500);
        }
        throw new TimeoutException("PostgreSQL did not become ready in time");
    }

    private void TweakConfig()
    {
        var configFile = Path.Combine(_dataDir, "postgresql.conf");
        // Postgres accepts forward slashes on Windows and requires them here.
        var logDir = AppPaths.LogsDir.Replace('\\', '/');
        var tweaks = $"""

            # --- Fliks embedded settings ---
            listen_addresses = 'localhost'
            shared_buffers = '128MB'
            max_connections = 50
            logging_collector = on
            log_directory = '{logDir}'
            """;
        File.AppendAllText(configFile, tweaks);
    }
}
