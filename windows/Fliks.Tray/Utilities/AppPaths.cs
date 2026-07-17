namespace Fliks.Tray.Utilities;

/// <summary>
/// Every filesystem location the tray touches. Bundled binaries resolve
/// next to the executable (install layout); a dev run climbs to the repo
/// root and falls back to PATH for node/ffmpeg.
/// </summary>
internal static class AppPaths
{
    private static readonly string BaseDir = AppContext.BaseDirectory;

    // %LOCALAPPDATA%\Fliks
    public static readonly string AppData = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Fliks");

    public static readonly string PgDataDir = Path.Combine(AppData, "postgresql", "data");
    public static readonly string PgLogFile = Path.Combine(AppData, "postgresql", "pg.log");
    public static readonly string ConfDir = Path.Combine(AppData, "conf");
    public static readonly string DataDir = Path.Combine(AppData, "data");
    public static readonly string LogsDir = Path.Combine(AppData, "logs");
    public static readonly string TranscodeDir = Path.Combine(AppData, "transcode");

    /// <summary>node.exe — bundled, else repo dev copy, else PATH.</summary>
    public static string NodeExe => ResolveBinary(
        Path.Combine(BaseDir, "node", "node.exe"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "windows", "Vendored", "node", "node.exe"),
        "node.exe");

    /// <summary>PostgreSQL bin dir (initdb.exe, pg_ctl.exe, …).</summary>
    public static string PgBinDir => ResolveDir(
        Path.Combine(BaseDir, "pgsql", "bin"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "windows", "Vendored", "pgsql", "bin"));

    /// <summary>FFmpeg bin dir (front of PATH for the backend's spawns).</summary>
    public static string FfmpegBinDir => ResolveDir(
        Path.Combine(BaseDir, "ffmpeg", "bin"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "windows", "Vendored", "ffmpeg", "bin"));

    /// <summary>Backend entry script (run by absolute path; node_modules
    /// resolves from its directory, so cwd stays on the writable data dir).</summary>
    public static string BackendMainJs => ResolveFile(
        Path.Combine(BaseDir, "backend", "dist", "main.js"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "backend", "dist", "main.js"));

    /// <summary>Built Angular client served via SERVE_STATIC_PATH.</summary>
    public static string ClientDir => ResolveDir(
        Path.Combine(BaseDir, "client"),
        RepoRoot is null ? null : Path.Combine(RepoRoot, "client", "dist", "client", "browser"));

    /// <summary>Repo root when running from a dev checkout (climb until a
    /// backend/package.json is found); null in an installed build.</summary>
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
            if (File.Exists(Path.Combine(dir.FullName, "backend", "package.json")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private static string ResolveBinary(string bundled, string? dev, string pathName)
    {
        if (File.Exists(bundled)) return bundled;
        if (dev is not null && File.Exists(dev)) return dev;
        return FindInPath(pathName) ?? bundled;
    }

    private static string ResolveDir(string bundled, string? dev)
    {
        if (Directory.Exists(bundled)) return bundled;
        if (dev is not null && Directory.Exists(dev)) return dev;
        return bundled;
    }

    private static string ResolveFile(string bundled, string? dev)
    {
        if (File.Exists(bundled)) return bundled;
        if (dev is not null && File.Exists(dev)) return dev;
        return bundled;
    }

    private static string? FindInPath(string name)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir, name);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}
