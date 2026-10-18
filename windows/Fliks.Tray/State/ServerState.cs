namespace Fliks.Tray.State;

internal enum ServerPhase
{
    Stopped,
    StartingPostgres,
    StartingServer,
    Running,
    Stopping,
    Error,
}

/// <summary>Lifecycle state of the server stack (Postgres + engine + fliks-server).</summary>
internal readonly record struct ServerState(ServerPhase Phase, string? Message = null)
{
    public static readonly ServerState Stopped = new(ServerPhase.Stopped);
    public static readonly ServerState StartingPostgres = new(ServerPhase.StartingPostgres);
    public static readonly ServerState StartingServer = new(ServerPhase.StartingServer);
    public static readonly ServerState Running = new(ServerPhase.Running);
    public static readonly ServerState Stopping = new(ServerPhase.Stopping);
    public static ServerState Errored(string message) => new(ServerPhase.Error, message);

    public bool IsStarting =>
        Phase is ServerPhase.StartingPostgres or ServerPhase.StartingServer;

    public string DisplayText => Phase switch
    {
        ServerPhase.Stopped => "Fliks is stopped",
        ServerPhase.StartingPostgres => "Starting database…",
        ServerPhase.StartingServer => "Starting server…",
        ServerPhase.Running => "Fliks is running",
        ServerPhase.Stopping => "Stopping…",
        ServerPhase.Error => $"Error: {Message}",
        _ => "",
    };
}
