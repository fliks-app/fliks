using System.Text.Json;
using Fliks.Tray.Utilities;

namespace Fliks.Tray.Services;

/// <summary>Persisted tray preferences, stored as JSON under the conf dir so
/// they survive app moves and reinstalls.</summary>
internal sealed class ConfigStore
{
    private sealed class Model
    {
        public ushort Port { get; set; } = 4848;
        public ushort PgPort { get; set; } = 5433;
        public bool HasCompletedFirstLaunch { get; set; }
    }

    private static readonly string FilePath =
        Path.Combine(AppPaths.ConfDir, "tray-settings.json");

    private readonly Model _model;

    public ConfigStore()
    {
        try
        {
            _model = File.Exists(FilePath)
                ? JsonSerializer.Deserialize<Model>(File.ReadAllText(FilePath)) ?? new Model()
                : new Model();
        }
        catch
        {
            _model = new Model();
        }
    }

    public ushort Port => _model.Port;
    public ushort PgPort => _model.PgPort;

    public bool HasCompletedFirstLaunch
    {
        get => _model.HasCompletedFirstLaunch;
        set { _model.HasCompletedFirstLaunch = value; Save(); }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.ConfDir);
            File.WriteAllText(FilePath,
                JsonSerializer.Serialize(_model, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch
        {
            // Non-fatal — settings just won't persist this run.
        }
    }
}
