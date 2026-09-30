using System.Runtime.InteropServices;

namespace Fliks.Tray.Tray;

/// <summary>The tray menu as a Win32 popup menu, which Windows draws in its own current style
/// (rounded and themed on Windows 11) where a ContextMenuStrip draws its fixed 2003-era one.</summary>
internal sealed class NativeMenu : NativeWindow, IDisposable
{
    internal sealed class Item
    {
        public string Text { get; set; } = "";
        public bool Enabled { get; set; } = true;
        public bool Checked { get; set; }
        public bool Visible { get; set; } = true;
        public bool IsSeparator { get; init; }
        public Action? Click { get; init; }
    }

    private readonly List<Item> _items = new();

    // A hidden top-level window: the menu needs a foreground owner to dismiss on an outside click.
    public NativeMenu() => CreateHandle(new CreateParams());

    public Item Add(string text, Action? click = null)
    {
        var item = new Item { Text = text, Click = click };
        _items.Add(item);
        return item;
    }

    public void AddSeparator() => _items.Add(new Item { IsSeparator = true });

    /// <summary>Opts Win32 menus into the system dark theme (uxtheme ordinals 135/136, the
    /// undocumented pair every dark-mode Win32 app uses); a no-op before Windows 10 1903.</summary>
    public static void FollowSystemTheme()
    {
        try
        {
            _ = SetPreferredAppMode(AllowDark);
            FlushMenuThemes();
        }
        catch (EntryPointNotFoundException)
        {
            // Older Windows: light menus.
        }
    }

    public void ShowAtCursor()
    {
        var menu = CreatePopupMenu();
        try
        {
            var lastWasSeparator = true;
            for (var i = 0; i < _items.Count; i++)
            {
                var item = _items[i];
                if (!item.Visible) continue;
                if (item.IsSeparator)
                {
                    if (!lastWasSeparator) AppendMenu(menu, MfSeparator, UIntPtr.Zero, null);
                    lastWasSeparator = true;
                    continue;
                }
                var flags = MfString | (item.Enabled ? 0u : MfGrayed) | (item.Checked ? MfChecked : 0u);
                AppendMenu(menu, flags, (UIntPtr)(i + 1), item.Text);
                lastWasSeparator = false;
            }

            GetCursorPos(out var cursor);
            SetForegroundWindow(Handle);
            var chosen = TrackPopupMenuEx(menu, TpmReturnCmd | TpmRightButton | TpmBottomAlign,
                cursor.X, cursor.Y, Handle, IntPtr.Zero);
            // Documented TrackPopupMenu quirk: without it the next open can close at once.
            PostMessage(Handle, WmNull, IntPtr.Zero, IntPtr.Zero);
            if (chosen > 0) _items[chosen - 1].Click?.Invoke();
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    public void Dispose() => DestroyHandle();

    private const uint MfString = 0x0000;
    private const uint MfGrayed = 0x0001;
    private const uint MfChecked = 0x0008;
    private const uint MfSeparator = 0x0800;
    private const uint TpmRightButton = 0x0002;
    private const uint TpmBottomAlign = 0x0020;
    private const uint TpmReturnCmd = 0x0100;
    private const int WmNull = 0x0000;
    private const int AllowDark = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr id, string? text);
    [DllImport("user32.dll")]
    private static extern int TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr hwnd, IntPtr tpm);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr w, IntPtr l);
    [DllImport("uxtheme.dll", EntryPoint = "#135")] private static extern int SetPreferredAppMode(int mode);
    [DllImport("uxtheme.dll", EntryPoint = "#136")] private static extern void FlushMenuThemes();
}
