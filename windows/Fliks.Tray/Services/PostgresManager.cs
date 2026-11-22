using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
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
    // Password of the fliks superuser, kept in the tray-private AppPaths.DbAdminPasswordFile.
    private string _password = "";
    private bool _passwordUnsaved;
    private static readonly System.Text.RegularExpressions.Regex PasswordFormat = new("^[0-9a-f]{64}$");
    private string HbaFile => Path.Combine(_dataDir, "pg_hba.conf");

    /// <summary>Password of the <c>fliks_app</c> role the server connects with (<see cref="AppPaths.DbPasswordFile"/>), set by <see cref="CreateDatabaseIfNeededAsync"/>.</summary>
    public string DbPassword { get; private set; } = "";
    // Held for the tray's lifetime so postgres dies with it. pg_ctl joins it before
    // spawning postgres, which then inherits it instead of pg_ctl's own UI-limited job.
    private readonly JobObject _job = new();

    private string Tool(string name) => Path.Combine(_binDir, name + ".exe");

    private static void LogResult(string tool, ProcessResult r) =>
        Log.Info($"pg {tool}: exit={r.ExitCode}" +
                 (r.Stdout.Length > 0 ? $" stdout={r.Stdout}" : "") +
                 (r.Stderr.Length > 0 ? $" stderr={r.Stderr}" : ""));

    // LC_ALL=C forces the PostgreSQL tools to emit English (they otherwise
    // localise to the Windows UI language). Doesn't affect the cluster locale,
    // which initdb pins to C.
    private IReadOnlyDictionary<string, string> PgEnv => new Dictionary<string, string>
    {
        ["PGDATA"] = _dataDir,
        ["LC_ALL"] = "C",
        ["PGPASSWORD"] = _password,
    };

    public bool IsInitialized => File.Exists(Path.Combine(_dataDir, "PG_VERSION"));

    /// <summary>Run initdb on first launch (no PG_VERSION file yet).</summary>
    public async Task InitializeAsync()
    {
        LoadPassword();
        if (IsInitialized)
        {
            // A cluster already on scram lost its admin password file: only single-user mode can reset it.
            if (_passwordUnsaved && !HbaTrusts())
            {
                await ResetPasswordSingleUserAsync();
                SavePassword();
            }
            return;
        }

        // initdb reads the role password from the file.
        SavePassword();
        Directory.CreateDirectory(_dataDir);
        var result = await ProcessRunner.RunAsync(
            Tool("initdb"),
            new[]
            {
                "-D", _dataDir,
                "--auth=scram-sha-256",
                $"--pwfile={AppPaths.DbAdminPasswordFile}",
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
        WriteHba();
    }

    /// <summary>Start the server and wait until it accepts connections.</summary>
    public async Task StartAsync(CancellationToken ct)
    {
        if (await IsPostmasterRunningAsync())
            Log.Info("pg: postmaster already running");
        else
            await StartPostmasterAsync();

        await WaitForReadyAsync(TimeSpan.FromSeconds(30), ct);
        // A postmaster that outlived the tray may still trust connections in memory
        // while pg_hba.conf already says scram.
        await ReloadAsync();
        if (HbaTrusts()) await MigrateToScramAsync();
    }

    private async Task StartPostmasterAsync()
    {
        // -W (pg_ctl waits by default) and no output capture: pg_ctl returns at once and
        // WaitForReadyAsync covers crash recovery; capturing hangs on the inherited pipe.
        var result = await ProcessRunner.RunAsync(
            Tool("pg_ctl"),
            new[]
            {
                "-W",
                "-D", _dataDir,
                "-l", _logFile,
                "-o", $"-p {port}",
                "start",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(15),
            captureOutput: false,
            job: _job);

        LogResult("pg_ctl start", result);
        if (!result.Succeeded)
            throw new InvalidOperationException($"pg_ctl start failed: {result.Stderr}");
    }

    private async Task<bool> IsPostmasterRunningAsync()
    {
        var r = await ProcessRunner.RunAsync(
            Tool("pg_ctl"), new[] { "-D", _dataDir, "status" }, PgEnv, timeout: TimeSpan.FromSeconds(10));
        return r.Succeeded;
    }

    private async Task ReloadAsync()
    {
        var r = await ProcessRunner.RunAsync(
            Tool("pg_ctl"), new[] { "-D", _dataDir, "reload" }, PgEnv, timeout: TimeSpan.FromSeconds(10));
        LogResult("pg_ctl reload", r);
        if (!r.Succeeded)
            throw new InvalidOperationException($"pg_ctl reload failed: {r.Stderr}");
    }

    /// <summary>Read the admin password file, or generate a password in memory (64 hex characters): the file is
    /// written by <see cref="SavePassword"/> once the role has it, so a failed reset is retried at the next launch.</summary>
    private void LoadPassword()
    {
        var stored = ReadPassword(AppPaths.DbAdminPasswordFile);
        if (stored is not null)
        {
            _password = stored;
            _passwordUnsaved = false;
            return;
        }

        // A cluster from before the app role: .db-password still holds the superuser password.
        var legacy = ReadPassword(AppPaths.DbPasswordFile);
        if (IsInitialized && !File.Exists(AppPaths.DbPasswordNextFile) && legacy is not null)
        {
            WriteSecret(legacy, AppPaths.DbAdminPasswordFile);
            _password = legacy;
            _passwordUnsaved = false;
            return;
        }

        _password = RandomPassword();
        _passwordUnsaved = true;
    }

    /// <summary>Writes the admin password file when <see cref="LoadPassword"/> generated it.</summary>
    private void SavePassword()
    {
        if (!_passwordUnsaved) return;
        WriteSecret(_password, AppPaths.DbAdminPasswordFile);
        _passwordUnsaved = false;
    }

    /// <summary>Temp file + rename.</summary>
    private static void WriteSecret(string value, string file)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, value);
        File.Move(temp, file, overwrite: true);
    }

    private static string? ReadPassword(string file)
    {
        if (!File.Exists(file)) return null;
        var text = File.ReadAllText(file).Trim();
        return PasswordFormat.IsMatch(text) ? text : null;
    }

    private static string RandomPassword() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    /// <summary>Runs the bundled <c>fliks-server db-role</c> so the server connects as <c>fliks_app</c>, never as the
    /// superuser. <c>.db-password</c> is replaced only by the final move of <c>.db-password.next</c>, so a crash redoes the steps.</summary>
    private async Task ProvisionAppRoleAsync()
    {
        var next = AppPaths.DbPasswordNextFile;
        var current = ReadPassword(AppPaths.DbPasswordFile);
        var pending = ReadPassword(next);
        var pendingMove = pending is not null || current is null || current == _password;
        var candidate = pending ?? (pendingMove ? RandomPassword() : current!);
        if (pending is null && pendingMove) WriteSecret(candidate, next);

        var r = await ProcessRunner.RunAsync(
            AppPaths.ServerExe,
            new[] { "db-role" },
            new Dictionary<string, string>
            {
                ["DB_HOST"] = "127.0.0.1",
                ["DB_PORT"] = port.ToString(),
                ["DB_NAME"] = "fliks",
                ["DB_USERNAME"] = "fliks_app",
                ["DB_PASSWORD"] = candidate,
                ["DB_ADMIN_USERNAME"] = "fliks",
                ["DB_ADMIN_PASSWORD"] = _password,
            },
            timeout: TimeSpan.FromSeconds(90));
        Log.Info($"fliks-server db-role: exit={r.ExitCode}" + (r.Stderr.Length > 0 ? $" stderr={r.Stderr}" : ""));
        if (!r.Succeeded)
            throw new InvalidOperationException($"database role setup failed: {r.Stderr}");

        if (pendingMove) File.Move(next, AppPaths.DbPasswordFile, overwrite: true);
        DbPassword = candidate;
    }

    /// <summary>Whether any line of <c>pg_hba.conf</c> still uses the <c>trust</c> method.</summary>
    private bool HbaTrusts()
    {
        if (!File.Exists(HbaFile)) return false;
        return File.ReadLines(HbaFile).Any(line =>
            line.Split('#')[0].Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Contains("trust"));
    }

    /// <summary>TCP loopback only, scram everywhere: the same file a fresh cluster ends up with.</summary>
    private void WriteHba()
    {
        var temp = HbaFile + ".tmp";
        File.WriteAllText(temp,
            "# TYPE  DATABASE  USER  ADDRESS       METHOD\n" +
            "host    all       all   127.0.0.1/32  scram-sha-256\n" +
            "host    all       all   ::1/128       scram-sha-256\n");
        File.Move(temp, HbaFile, overwrite: true);
    }

    /// <summary>Live repair of a trust cluster: set the role password while trust still lets us in,
    /// then close <c>pg_hba.conf</c>. A crash in between leaves <c>trust</c>, so the next launch retries.</summary>
    private async Task MigrateToScramAsync()
    {
        Log.Info("pg: switching the cluster from trust to scram-sha-256");
        // The statement goes through stdin: argv is visible to other processes, and the result
        // is not logged because an error echoes the statement.
        var r = await ProcessRunner.RunAsync(
            Tool("psql"),
            new[]
            {
                "-w", "-h", "127.0.0.1", "-p", port.ToString(), "-U", "fliks", "-d", "postgres",
                "-v", "ON_ERROR_STOP=1",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(10),
            stdin: $"SET log_min_error_statement = 'panic';\nALTER ROLE fliks PASSWORD '{_password}';\n");
        if (!r.Succeeded)
            throw new InvalidOperationException($"setting the database password failed (psql exit {r.ExitCode})");
        SavePassword();
        WriteHba();
        await ReloadAsync();
    }

    /// <summary>The admin password file is gone while the cluster is already on scram: stop, reset the role
    /// password in single-user mode (statement on stdin, never logged); the caller starts again.</summary>
    private async Task ResetPasswordSingleUserAsync()
    {
        Log.Info("pg: the database password file is missing, resetting the role password");
        if (await IsPostmasterRunningAsync()) await StopAsync();
        var r = await ProcessRunner.RunAsync(
            Tool("postgres"),
            new[] { "--single", "-D", _dataDir, "postgres" },
            PgEnv,
            timeout: TimeSpan.FromSeconds(30),
            stdin: $"ALTER ROLE fliks PASSWORD '{_password}'\n");
        if (r.Succeeded) return;
        // postgres.exe refuses an administrator token; pg_ctl avoids it with a restricted one.
        var elevated = r.Stderr.Contains("administrative", StringComparison.OrdinalIgnoreCase);
        throw new InvalidOperationException(elevated
            ? "The database password file is missing and postgres.exe refuses to run with administrator rights: start Fliks as a normal user"
            : $"resetting the database password failed (postgres exit {r.ExitCode})");
    }

    /// <summary>Create the <c>fliks</c> database if absent, then hand it to the <c>fliks_app</c> role.</summary>
    public async Task CreateDatabaseIfNeededAsync()
    {
        var check = await ProcessRunner.RunAsync(
            Tool("psql"),
            new[]
            {
                "-w", "-h", "127.0.0.1", "-p", port.ToString(), "-U", "fliks", "-d", "postgres",
                "-tAc", "SELECT 1 FROM pg_database WHERE datname = 'fliks'",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(10));

        LogResult("psql exists-check", check);
        if (check.Stdout.Trim() != "1")
        {
            var created = await ProcessRunner.RunAsync(
                Tool("createdb"),
                new[] { "-w", "-h", "127.0.0.1", "-p", port.ToString(), "-U", "fliks", "fliks" },
                PgEnv,
                timeout: TimeSpan.FromSeconds(10));
            LogResult("createdb", created);
            if (!created.Succeeded && !created.Stderr.Contains("already exists"))
                throw new InvalidOperationException($"createdb failed: {created.Stderr}");
        }

        await ProvisionAppRoleAsync();
    }

    public async Task<bool> IsReadyAsync()
    {
        // A real psql connection to the always-present `postgres` DB, not
        // pg_isready: it verifies the exact capability the server needs and
        // logs why it failed. 127.0.0.1 sidesteps the Windows localhost -> ::1
        // resolution that made the old pg_isready check time out.
        var r = await ProcessRunner.RunAsync(
            Tool("psql"),
            new[]
            {
                "-w", "-h", "127.0.0.1", "-p", port.ToString(), "-U", "fliks",
                "-d", "postgres", "-tAc", "SELECT 1",
            },
            PgEnv,
            timeout: TimeSpan.FromSeconds(5));
        if (!r.Succeeded)
            Log.Info($"pg readiness: exit={r.ExitCode}" +
                     (r.Stderr.Length > 0 ? $" stderr={r.Stderr}" : ""));
        return r.Succeeded && r.Stdout.Trim() == "1";
    }

    /// <summary>Fast shutdown sent straight to the postmaster's signal pipe, as pg_ctl does:
    /// Windows refuses to start pg_ctl.exe once the session is logging off.</summary>
    public async Task StopAsync()
    {
        var pidFile = Path.Combine(_dataDir, "postmaster.pid");
        if (!File.Exists(pidFile) ||
            !int.TryParse(File.ReadLines(pidFile).FirstOrDefault(), out var pid)) return;

        try
        {
            using var pipe = new NamedPipeClientStream(".", $"pgsignal_{pid}", PipeDirection.InOut);
            pipe.Connect(1000);
            pipe.Write([SigInt]);
            pipe.ReadByte();
        }
        catch (Exception ex) when (ex is IOException or TimeoutException)
        {
            Log.Info($"pg stop: no signal pipe for pid {pid} ({ex.Message})");
            return;
        }

        try
        {
            using var postmaster = Process.GetProcessById(pid);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            await postmaster.WaitForExitAsync(timeout.Token);
            Log.Info("pg stop: postmaster exited");
        }
        catch (ArgumentException) { /* already gone */ }
        catch (OperationCanceledException) { Log.Info("pg stop: postmaster still running after 20s"); }
    }

    // PostgreSQL's Windows signal emulation uses the CRT numbers; SIGINT = fast shutdown.
    private const byte SigInt = 2;

    private async Task WaitForReadyAsync(TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (await IsReadyAsync()) return;
            await Task.Delay(500, ct);
        }
        throw new TimeoutException("PostgreSQL did not become ready in time");
    }

    private void TweakConfig()
    {
        var configFile = Path.Combine(_dataDir, "postgresql.conf");
        // Postgres accepts forward slashes on Windows and requires them here.
        var logDir = AppPaths.LogsDir.Replace('\\', '/');
        // Shared with the macOS shell: scripts/embedded-postgres.conf, embedded in the assembly.
        using var stream = typeof(PostgresManager).Assembly.GetManifestResourceStream("embedded-postgres.conf")
            ?? throw new InvalidOperationException("embedded-postgres.conf is not embedded in the assembly");
        using var reader = new StreamReader(stream);
        var tweaks = reader.ReadToEnd().Replace("@LOG_DIR@", logDir);
        File.AppendAllText(configFile, tweaks);
    }
}
