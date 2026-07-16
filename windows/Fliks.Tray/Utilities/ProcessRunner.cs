using System.Diagnostics;
using System.Text;

namespace Fliks.Tray.Utilities;

internal readonly record struct ProcessResult(int ExitCode, string Stdout, string Stderr)
{
    public bool Succeeded => ExitCode == 0;
}

/// <summary>Async wrapper around <see cref="Process"/> for the CLI tools
/// (initdb, pg_ctl, pg_isready, createdb, psql) with output capture and a
/// wall-clock timeout.</summary>
internal static class ProcessRunner
{
    public static async Task<ProcessResult> RunAsync(
        string executable,
        IEnumerable<string> arguments,
        IReadOnlyDictionary<string, string>? environment = null,
        string? workingDirectory = null,
        TimeSpan? timeout = null)
    {
        using var process = new Process();
        process.StartInfo.FileName = executable;
        foreach (var arg in arguments) process.StartInfo.ArgumentList.Add(arg);
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.CreateNoWindow = true;
        process.StartInfo.RedirectStandardOutput = true;
        process.StartInfo.RedirectStandardError = true;
        if (workingDirectory is not null) process.StartInfo.WorkingDirectory = workingDirectory;
        if (environment is not null)
            foreach (var (k, v) in environment) process.StartInfo.Environment[k] = v;

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var cts = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(30));
        try
        {
            await process.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
        }

        return new ProcessResult(
            process.HasExited ? process.ExitCode : -1,
            stdout.ToString().Trim(),
            stderr.ToString().Trim());
    }
}
