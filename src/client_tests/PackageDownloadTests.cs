using System.Net;
using System.Security.Cryptography;
using Swgoh.Client;

static class PackageDownloadTests
{
    public static async Task Run(string root, Action<bool, string> check)
    {
        byte[] payload = [1, 2, 3, 4];
        var package = new ReleasePackage(new Version(0, 2, 0, 0), "BlueMilk.Editor_0.2.0.0_x64.msix",
            new Uri("https://api.github.com/repos/" + ReleaseUpdates.Repository + "/releases/assets/45"),
            payload.Length, Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant());
        var redirect = new Uri("https://release-assets.githubusercontent.com/example?signature=test");
        var handler = new Handler((request, index) =>
        {
            check(index == 0 ? request.Headers.Authorization?.Parameter == "test-token" :
                request.Headers.Authorization == null, "token sent only to GitHub API, not CDN");
            return index == 0 ? Redirect(redirect) : Content(payload);
        });
        var cache = Path.Combine(root, "downloads");
        var exe = package with { Name = "BlueMilk-Editor-0.2.0-Setup.exe", Channel = UpdateChannel.Exe };
        using (var download = new PackageDownloads(new Handler((request, _) =>
        {
            check(request.Headers.Authorization == null, "public EXE download requires no token");
            return Content(payload);
        })))
        {
            var path = await download.DownloadAsync(exe, Path.Combine(root, "exe-download"));
            check(Path.GetExtension(path) == ".exe" && File.ReadAllBytes(path).SequenceEqual(payload),
                "EXE retains extension and is hash verified");
        }
        using (var download = new PackageDownloads(new Handler((_, _) => throw new Exception("Must not connect"))))
        {
            bool rejected = false;
            try { await download.DownloadAsync(exe with { Channel = UpdateChannel.Msix }, cache); }
            catch (InvalidDataException) { rejected = true; }
            check(rejected, "mismatched channel metadata rejected before download");
        }
        using (var download = new PackageDownloads(handler))
        {
            var path = await download.DownloadAsync(package, cache, "test-token");
            check(File.ReadAllBytes(path).SequenceEqual(payload), "downloaded bytes verified and committed");
            check(await download.DownloadAsync(package, cache) == path && handler.Calls == 2,
                "verified cache reuse needs no network");
            File.WriteAllBytes(path, [0, 0, 0, 0]);
            bool rejected = false;
            try { await download.DownloadAsync(package, cache); } catch (InvalidDataException) { rejected = true; }
            check(rejected && handler.Calls == 2, "corrupt existing cache rejected without overwrite");
        }
        foreach (var scenario in new[] { "hash", "size", "redirect", "auth", "cancel" })
        {
            var isolated = Path.Combine(root, "download-" + scenario);
            using var cancel = new CancellationTokenSource();
            var fake = new Handler((_, _) =>
            {
                if (scenario == "cancel") cancel.Cancel();
                return scenario switch
                {
                    "hash" => Content([9, 9, 9, 9]),
                    "size" => Content([1, 2]),
                    "redirect" => Redirect(new Uri("https://untrusted.invalid/file")),
                    "auth" => new(HttpStatusCode.Unauthorized),
                    _ => Content(payload)
                };
            });
            using var download = new PackageDownloads(fake);
            bool refused = false;
            try { await download.DownloadAsync(package, isolated, "test-token", cancel.Token); }
            catch (Exception e) when (e is IOException or InvalidDataException or OperationCanceledException) { refused = true; }
            check(refused && !Directory.EnumerateFiles(isolated).Any(), scenario + " leaves no staged or committed package");
            check(fake.Calls == 1, scenario + " is not automatically retried");
        }
        using (var download = new PackageDownloads(new Handler((_, _) => throw new Exception("Must not connect"))))
        {
            bool refused = false;
            try { await download.DownloadAsync(package with { AssetApi = new Uri("https://evil.invalid/45") }, cache); }
            catch (InvalidDataException) { refused = true; }
            check(refused, "forged asset endpoint rejected before sending token");
        }
    }
    static HttpResponseMessage Redirect(Uri target) => new(HttpStatusCode.Redirect) { Headers = { Location = target } };
    static HttpResponseMessage Content(byte[] bytes) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
    sealed class Handler(Func<HttpRequestMessage, int, HttpResponseMessage> run) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) =>
            Task.FromResult(run(request, Calls++));
    }
}
