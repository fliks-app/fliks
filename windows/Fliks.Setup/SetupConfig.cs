using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;

namespace Fliks.Setup;

/// <summary>The product this build installs, baked in by the csproj's AssemblyMetadata.</summary>
internal sealed class SetupConfig
{
    public string PackId { get; private set; } = "";
    public string MainExe { get; private set; } = "";
    public string Title { get; private set; } = "";
    public long InstalledBytes { get; private set; }
    /// <summary>Set for the server: the installer waits for it to answer before finishing.</summary>
    public int? ServerPort { get; private set; }

    public string InstallDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), PackId);

    public static SetupConfig Load()
    {
        var meta = Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .ToDictionary(a => a.Key, a => a.Value ?? "");
        string Get(string key) => meta.TryGetValue(key, out var v) ? v : "";

        var config = new SetupConfig
        {
            PackId = Get("PackId"),
            MainExe = Get("MainExe"),
            Title = Get("ProductTitle"),
            InstalledBytes = long.TryParse(Get("InstalledBytes"), out var bytes) ? bytes : 0,
        };
        if (int.TryParse(Get("ServerPort"), out var port)) config.ServerPort = ConfiguredPort() ?? port;
        return config;
    }

    // A reinstall keeps the port the tray was configured with.
    private static int? ConfiguredPort()
    {
        try
        {
            var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Fliks Server", "conf", "tray-settings.json");
            var match = Regex.Match(File.ReadAllText(file), "\"Port\"\\s*:\\s*(\\d+)");
            return match.Success ? int.Parse(match.Groups[1].Value) : null;
        }
        catch
        {
            return null;
        }
    }
}
