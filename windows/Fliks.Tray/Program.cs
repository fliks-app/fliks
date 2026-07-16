using Fliks.Tray.Tray;

namespace Fliks.Tray;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // Single instance: a second launch just exits (the tray is already up).
        using var mutex = new Mutex(initiallyOwned: true, "Fliks.Tray.SingleInstance", out var isNew);
        if (!isNew) return;

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext());
    }
}
