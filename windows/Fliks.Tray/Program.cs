using Fliks.Tray.Services;
using Fliks.Tray.State;
using Fliks.Tray.Tray;

namespace Fliks.Tray;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var autostart = args.Contains(StartupRegistry.LaunchArg);
        // Single instance: a second launch only opens the browser on the running server.
        using var mutex = new Mutex(initiallyOwned: true, "Fliks.Tray.SingleInstance", out var isNew);
        if (!isNew)
        {
            if (!autostart) AppState.OpenInBrowser(new ConfigStore().Port);
            return;
        }
        // Rewrites an existing login entry with the current exe path and the autostart flag.
        if (StartupRegistry.IsEnabled) StartupRegistry.SetEnabled(true);

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext(openBrowserWhenReady: !autostart));
    }
}
