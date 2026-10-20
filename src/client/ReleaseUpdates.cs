using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swgoh.Client;

public enum UpdateChannel { Msix, Exe }
public sealed record ReleasePackage(Version Version, string Name, Uri AssetApi, long Size, string Sha256,
    UpdateChannel Channel = UpdateChannel.Msix);
public sealed record ReleaseCheck(string State, ReleasePackage? Package = null);

// Checking a release never installs it or changes the running version.
public sealed class ReleaseUpdates(HttpClient http, UpdateChannel channel = UpdateChannel.Msix)
{
    public const string Repository = "LukeSONG2000/bluemilk-editor";
    private const string Api = "https://api.github.com/repos/" + Repository;

    private async Task<HttpResponseMessage> Get(string url, string? token, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("BlueMilk-Editor/0.1");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        if (!string.IsNullOrWhiteSpace(token))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return await http.SendAsync(request, cancellation);
    }

    public async Task<ReleaseCheck> CheckAsync(Version current, string? token = null,
        CancellationToken cancellation = default)
    {
        using var response = await Get(Api + "/releases/latest", token, cancellation);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            // GitHub also returns 404 for an inaccessible private repository.
            using var repo = await Get(Api, token, cancellation);
            if (repo.IsSuccessStatusCode) return new("no-release");
            if (repo.StatusCode == HttpStatusCode.NotFound) return new("repository-unavailable");
            return Failure(repo.StatusCode);
        }
        if (!response.IsSuccessStatusCode) return Failure(response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
        return Parse(json.RootElement, current, channel);
    }

    private static ReleaseCheck Failure(HttpStatusCode status) => new(status switch
    {
        HttpStatusCode.Unauthorized => "authentication-required",
        HttpStatusCode.Forbidden => "access-denied-or-rate-limited",
        _ => "http-error-" + (int)status
    });

    public static string PackageName(Version version, UpdateChannel channel) => channel switch
    {
        UpdateChannel.Msix => $"BlueMilk.Editor_{version}_x64.msix",
        UpdateChannel.Exe => $"BlueMilk-Editor-{version.ToString(3)}-Setup.exe",
        _ => throw new InvalidDataException("Unknown update channel.")
    };

    public static ReleaseCheck Parse(JsonElement release, Version current, UpdateChannel channel = UpdateChannel.Msix)
    {
        if (release.GetProperty("draft").GetBoolean() || release.GetProperty("prerelease").GetBoolean())
            throw new InvalidDataException("A stable update must be a published, non-prerelease release.");
        var tag = release.GetProperty("tag_name").GetString() ?? "";
        if (!Regex.IsMatch(tag, @"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$") ||
            !Version.TryParse(tag[1..], out var parsed))
            throw new InvalidDataException("Release tag must be vMAJOR.MINOR.PATCH.");
        var version = new Version(parsed.Major, parsed.Minor, parsed.Build, 0);
        if (version.Major > 65535 || version.Minor > 65535 || version.Build > 65535)
            throw new InvalidDataException("Release version exceeds MSIX component limits.");
        var installed = new Version(current.Major, current.Minor, Math.Max(current.Build, 0),
            Math.Max(current.Revision, 0));
        if (version <= installed) return new("up-to-date");
        var expected = PackageName(version, channel);
        var assets = release.GetProperty("assets").EnumerateArray()
            .Where(a => a.GetProperty("name").GetString() == expected).ToArray();
        if (assets.Length != 1) throw new InvalidDataException("Release must contain exactly one matching installer for this channel.");
        var asset = assets[0];
        var size = asset.GetProperty("size").GetInt64();
        var id = asset.GetProperty("id").GetInt64();
        var digest = asset.GetProperty("digest").GetString() ?? "";
        if (asset.GetProperty("state").GetString() != "uploaded" || size <= 0 || id <= 0 ||
            !Regex.IsMatch(digest, "^sha256:[a-fA-F0-9]{64}$"))
            throw new InvalidDataException("Release asset is incomplete or lacks a SHA-256 digest.");
        // Construct the authenticated endpoint ourselves, never from untrusted release text.
        return new("update-available", new(version, expected,
            new Uri($"{Api}/releases/assets/{id}"), size, digest[7..].ToLowerInvariant(), channel));
    }
}
