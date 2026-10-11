using System;
using System.Windows.Forms;

namespace Fliks.Setup;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(SetupConfig.Load()));
    }
}
