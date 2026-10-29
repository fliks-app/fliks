namespace Fliks.Tray.Utilities;

/// <summary>
/// Every filesystem location the tray touches. Bundled binaries resolve
/// next to the executable (install layout); a dev run climbs to the repo
/// root for the vendored PostgreSQL/FFmpeg and the client build.
/// </summary>
internal static class AppPaths
{
    private static readonly string BaseDir = AppContext.BaseDirectory;

    // %LOCALAPPDATA%\Fliks Server
    public static readonly string AppData = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Fliks Server");

    public static readonly string PgDataDir = Path.Combine(AppData, "postgresql", "data");
    public static readonly string PgLogFile = Path.Combine(AppData, "postgresql", "pg.log");
    public static readonly string ConfDir = Path.Combine(AppData, "conf");
    public static readonly string DataDir = Path.Combine(AppData, "data");
    public static readonly string LogsDir = Path.Combine(AppData, "logs");
    public static readonly string TranscodeDir = Path.Combine(AppData, "transcode");

    /// <summary>fliks-engine.exe and fliks-server.exe (install layout only).</summary>
    public static readonly string BinDir = Path.Combine(BaseDir, "bin");

    /// <summary>Supervisor beside fliks-server.exe (null only when it is missing).</summary>
    public static string? EngineExe
    {
        get
        {
            var p = Path.Combine(BinDir, "fliks-engine.exe");
            return File.Exists(p) ? p : null;
        }
    }

    /// <summary>PostgreSQL bin dir (initdb.exe, pg_ctl.exe, …).</summary>
    public static string PgBinDir => ResolveDir(
        Path.Combine(BaseDir, "pgsql", "bin"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "windows", "Vendored", "pgsql", "bin"));

    /// <summary>FFmpeg bin dir (front of PATH for the engine's spawns).</summary>
    public static string FfmpegBinDir => ResolveDir(
        Path.Combine(BaseDir, "ffmpeg", "bin"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "windows", "Vendored", "ffmpeg", "bin"));

    /// <summary>Built Angular client served via SERVE_STATIC_PATH.</summary>
    public static string ClientDir => ResolveDir(
        Path.Combine(BaseDir, "client"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "client", "dist", "client", "browser"));

    /// <summary>Public assets (emoji), FLIKS_CAST_DIR.</summary>
    public static string CastDir => ResolveDir(
        Path.Combine(BaseDir, "cast"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "server", "public"));

    /// <summary>Repo root when running from a dev checkout (climb until a
    /// server\Cargo.toml is found); null in an installed build.</summary>
    public static readonly string? RepoRoot = FindRepoRoot();

    public static void EnsureStructure()
    {
        foreach (var dir in new[]
                 {
                     AppData, Path.GetDirectoryName(PgDataDir)!, ConfDir, DataDir,
                     LogsDir, TranscodeDir,
                 })
        {
            Directory.CreateDirectory(dir);
        }
    }

    private static string? FindRepoRoot()
    {
        var dir = new DirectoryInfo(BaseDir);
        for (var i = 0; i < 10 && dir is not null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "server", "Cargo.toml")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private static string ResolveDir(string bundled, string? dev)
    {
        if (Directory.Exists(bundled)) return bundled;
        if (dev is not null && Directory.Exists(dev)) return dev;
        return bundled;
    }
}
