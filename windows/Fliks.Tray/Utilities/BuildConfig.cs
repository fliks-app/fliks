using System.Reflection;

namespace Fliks.Tray.Utilities;

/// <summary>Metadata API keys baked at publish time via
/// <c>AssemblyMetadata</c> (the csproj forwards the <c>TmdbApiKey</c> /
/// <c>TvdbApiKey</c> MSBuild properties the CI passes to
/// <c>dotnet publish</c>). Empty in a local build — the setup wizard
/// prompts for them instead.</summary>
internal static class BuildConfig
{
    public static string TmdbApiKey => Meta("TmdbApiKey");
    public static string TvdbApiKey => Meta("TvdbApiKey");

    private static string Meta(string key) =>
        Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == key)?.Value ?? "";
}
