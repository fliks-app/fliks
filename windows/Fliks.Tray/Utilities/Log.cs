namespace Fliks.Tray.Utilities;

/// <summary>Timestamped file log at logs/tray-yyyy-MM-dd.log — the orchestrator's
/// only on-disk trace, used to diagnose startup failures.</summary>
internal static class Log
{
    private static readonly object Gate = new();

    public static void Info(string message) => Write("INFO", message);
    public static void Error(string message) => Write("ERROR", message);

    private static void Write(string level, string message)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.LogsDir);
            var file = Path.Combine(AppPaths.LogsDir, $"tray-{DateTime.Now:yyyy-MM-dd}.log");
            lock (Gate)
            {
                File.AppendAllText(file,
                    $"{DateTime.Now:HH:mm:ss.fff} [{level}] {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never throw.
        }
    }
}
