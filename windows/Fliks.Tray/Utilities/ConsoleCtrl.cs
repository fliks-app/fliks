using System.Runtime.InteropServices;

namespace Fliks.Tray.Utilities;

/// <summary>Sends Ctrl-C to the console of a windowless child. The tray has no console, so it attaches
/// to the child's for the length of the call; its own handler swallows the event.</summary>
internal static class ConsoleCtrl
{
    private delegate bool HandlerRoutine(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    private const uint CtrlCEvent = 0;
    private static readonly object Gate = new();

    // A registered routine, unlike an ignore flag, is not inherited by children, and it
    // answers the event whenever the tray's handler thread runs, even after FreeConsole.
    private static readonly HandlerRoutine SwallowCtrlC = ctrlType => ctrlType == CtrlCEvent;

    static ConsoleCtrl() => SetConsoleCtrlHandler(SwallowCtrlC, true);

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
                return GenerateConsoleCtrlEvent(CtrlCEvent, 0);
            }
            finally
            {
                FreeConsole();
            }
        }
    }
}
