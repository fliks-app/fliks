using System.Runtime.InteropServices;

namespace Fliks.Tray.Utilities;

/// <summary>Sends Ctrl-C to the console of a windowless child. The tray has no console, so it attaches
/// to the child's for the length of the call and ignores the event itself meanwhile.</summary>
internal static class ConsoleCtrl
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    private const uint CtrlCEvent = 0;
    private static readonly object Gate = new();

    public static bool SendCtrlC(int processId)
    {
        lock (Gate)
        {
            if (!AttachConsole((uint)processId))
            {
                Log.Error($"AttachConsole({processId}) failed: {Marshal.GetLastWin32Error()}");
                return false;
            }
            try
            {
                // Inherited by every child spawned while set, so it is reset right after.
                SetConsoleCtrlHandler(IntPtr.Zero, true);
                var sent = GenerateConsoleCtrlEvent(CtrlCEvent, 0);
                // The event is delivered asynchronously; the tray must still ignore it until then.
                Thread.Sleep(200);
                return sent;
            }
            finally
            {
                FreeConsole();
                SetConsoleCtrlHandler(IntPtr.Zero, false);
            }
        }
    }
}
