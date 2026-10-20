using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Swgoh.Client;

// Integrity verification is not publisher signature verification.
public sealed class PackageDownloads : IDisposable
{
    private readonly HttpClient http;
    public PackageDownloads() : this(new HttpClientHandler { AllowAutoRedirect = false }) { }
    internal PackageDownloads(HttpMessageHandler handler)
    {
        http = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(15) };
    }
    public void Dispose() => http.Dispose();

    public async Task<string> DownloadAsync(ReleasePackage package, string cacheDirectory,
        string? token = null, CancellationToken cancellation = default)
    {
        var prefix = "https://api.github.com/repos/" + ReleaseUpdates.Repository + "/releases/assets/";
        if (!Regex.IsMatch(package.Sha256, "^[a-fA-F0-9]{64}$") ||
            package.Name != ReleaseUpdates.PackageName(package.Version, package.Channel) ||
            package.Size <= 0 || package.Size > 4L * 1024 * 1024 * 1024 ||
            !package.AssetApi.AbsoluteUri.StartsWith(prefix, StringComparison.Ordinal) ||
            !long.TryParse(package.AssetApi.AbsoluteUri[prefix.Length..], out var assetId) || assetId <= 0)
            throw new InvalidDataException("Invalid release package metadata.");
        var cache = Path.GetFullPath(cacheDirectory);
        Directory.CreateDirectory(cache);
        var destination = Path.Combine(cache, package.Sha256.ToLowerInvariant() + Path.GetExtension(package.Name));
        if (File.Exists(destination))
        {
            await VerifyAsync(destination, package, cancellation);
            return destination;
        }
        var temporary = Path.Combine(cache, Guid.NewGuid().ToString("N") + ".partial");
        try
        {
            using var response = await OpenAsync(package.AssetApi, token, cancellation);
            if (response.Content.Headers.ContentLength is long length && length != package.Size)
                throw new InvalidDataException("Update Content-Length differs from release metadata.");
            await using (var input = await response.Content.ReadAsStreamAsync(cancellation))
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 81920, FileOptions.Asynchronous))
            {
                var buffer = new byte[81920];
                long total = 0;
                int count;
                while ((count = await input.ReadAsync(buffer, cancellation)) != 0)
                {
                    total += count;
                    if (total > package.Size) throw new InvalidDataException("Update exceeds declared size.");
                    await output.WriteAsync(buffer.AsMemory(0, count), cancellation);
                }
                await output.FlushAsync(cancellation);
                output.Flush(true);
            }
            await VerifyAsync(temporary, package, cancellation);
            cancellation.ThrowIfCancellationRequested();
            try { File.Move(temporary, destination); }
            catch (IOException) when (File.Exists(destination))
            {
                // A second frontend may have downloaded the same package concurrently.
                await VerifyAsync(destination, package, cancellation);
            }
            return destination;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private async Task<HttpResponseMessage> OpenAsync(Uri source, string? token, CancellationToken cancellation)
    {
        var uri = source;
        for (int hop = 0; hop < 5; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.UserAgent.ParseAdd("BlueMilk-Editor/0.1");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            if (hop == 0)
            {
                request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
                if (!string.IsNullOrWhiteSpace(token))
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }
            var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
            if (response.StatusCode == HttpStatusCode.OK) return response;
            var status = response.StatusCode;
            var next = response.Headers.Location;
            response.Dispose();
            if (status is not (HttpStatusCode.MovedPermanently or HttpStatusCode.Redirect or
                HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect))
                throw new IOException($"Update download failed (HTTP {(int)status}).");
            if (next == null || !next.IsAbsoluteUri || next.Scheme != "https" || !next.IsDefaultPort ||
                next.UserInfo.Length != 0 ||
                next.Host is not ("release-assets.githubusercontent.com" or "github-releases.githubusercontent.com"))
                throw new IOException("Update redirected outside supported GitHub release asset hosts.");
            uri = next;
        }
        throw new IOException("Too many update redirects.");
    }

    public static async Task VerifyAsync(string path, ReleasePackage package, CancellationToken cancellation = default)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            81920, FileOptions.Asynchronous);
        if (stream.Length != package.Size) throw new InvalidDataException("Update file size mismatch.");
        var digest = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellation));
        if (!digest.Equals(package.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Update SHA-256 mismatch.");
    }
}
