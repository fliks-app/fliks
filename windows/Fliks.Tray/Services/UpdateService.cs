using Fliks.Tray.Utilities;
using Velopack;
using Velopack.Sources;

namespace Fliks.Tray.Services;

/// <summary>Velopack updates from the GitHub releases; inert outside a Velopack install
/// (dev run from the repo).</summary>
internal sealed class UpdateService
{
    private readonly UpdateManager _manager =
        new(new GithubSource("https://github.com/fliks-app/fliks", null, false));
    private UpdateInfo? _available;

    public string? AvailableVersion => _available?.TargetFullRelease.Version.ToString();

    public async Task<bool> CheckAsync()
    {
        if (!_manager.IsInstalled) return false;
        try
        {
            _available = await _manager.CheckForUpdatesAsync();
            if (_available is not null) Log.Info($"update available: {AvailableVersion}");
            return _available is not null;
        }
        catch (Exception ex)
        {
            Log.Error($"update check failed: {ex.Message}");
            return false;
        }
    }

    public Task DownloadAsync(Action<int> progress) =>
        _manager.DownloadUpdatesAsync(_available!, progress);

    /// <summary>Exits the process; postgres and node must already be stopped, since Velopack
    /// kills whatever still holds files in the install folder.</summary>
    public void ApplyAndRestart() => _manager.ApplyUpdatesAndRestart(_available!.TargetFullRelease);
}
