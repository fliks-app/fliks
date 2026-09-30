using Microsoft.Win32;

namespace Fliks.Tray.Services;

/// <summary>Start-at-login via the per-user <c>HKCU\…\Run</c> key — no admin
/// rights, no scheduled task.</summary>
internal static class StartupRegistry
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Fliks";
    /// <summary>Marks a login launch, which stays in the tray instead of opening the browser.</summary>
    public const string LaunchArg = "--autostart";

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(ValueName) is not null;
        }
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true)
                        ?? Registry.CurrentUser.CreateSubKey(RunKey);
        if (key is null) return;
        if (enabled)
            key.SetValue(ValueName, $"\"{Environment.ProcessPath}\" {LaunchArg}");
        else
            key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
