using System.Net;
using System.Text;
using System.Text.Json;
using Swgoh.Client;

static class ReleaseUpdateTests
{
    public static async Task Run(Action<bool, string> check)
    {
        var valid = """
        {"tag_name":"v0.2.0","draft":false,"prerelease":false,"assets":[
          {"name":"BlueMilk.Editor_0.2.0.0_x64.msix","state":"uploaded","size":12,"id":45,
           "digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
           "url":"https://untrusted.invalid/package"}
        ]}
        """;
        ReleaseCheck Parse(string text, Version? version = null)
        {
            using var doc = JsonDocument.Parse(text);
            return ReleaseUpdates.Parse(doc.RootElement, version ?? new Version(0, 1, 0));
        }
        var result = Parse(valid);
        var exe = valid.Replace("BlueMilk.Editor_0.2.0.0_x64.msix", "BlueMilk-Editor-0.2.0-Setup.exe");
        using (var doc = JsonDocument.Parse(exe))
        {
            var selected = ReleaseUpdates.Parse(doc.RootElement, new Version(0, 1, 0), UpdateChannel.Exe);
            check(selected.Package!.Channel == UpdateChannel.Exe &&
                selected.Package.Name == "BlueMilk-Editor-0.2.0-Setup.exe", "EXE channel selects Setup asset");
            bool rejected = false;
            try { ReleaseUpdates.Parse(doc.RootElement, new Version(0, 1, 0), UpdateChannel.Msix); }
            catch (InvalidDataException) { rejected = true; }
            check(rejected, "MSIX channel does not fall back to EXE");
        }
        using (var doc = JsonDocument.Parse(valid))
        {
            bool rejected = false;
            try { ReleaseUpdates.Parse(doc.RootElement, new Version(0, 1, 0), UpdateChannel.Exe); }
            catch (InvalidDataException) { rejected = true; }
            check(rejected, "EXE channel does not fall back to MSIX");
        }
        check(result.State == "update-available" &&
              result.Package!.AssetApi.Host == "api.github.com", "release uses fixed asset API");
        check(Parse(valid, new Version(0, 2, 0)).State == "up-to-date", "three-part version equality");
        check(Parse(valid, new Version(0, 3, 0)).State == "up-to-date", "no downgrade");
        foreach (var broken in new[] {
            valid.Replace("\"draft\":false", "\"draft\":true"),
            valid.Replace("\"prerelease\":false", "\"prerelease\":true"),
            valid.Replace("v0.2.0", "v0.2.0-beta"),
            valid.Replace("_x64.msix", "_arm64.msix"),
            valid.Replace("sha256:", "sha512:"),
            valid.Replace("\"size\":12", "\"size\":0")
        })
        {
            bool rejected = false;
            try { Parse(broken); } catch (InvalidDataException) { rejected = true; }
            check(rejected, "reject invalid or incompatible release");
        }
        foreach (var scenario in new[] {
            (HttpStatusCode.NotFound, HttpStatusCode.OK, "no-release"),
            (HttpStatusCode.NotFound, HttpStatusCode.NotFound, "repository-unavailable"),
            (HttpStatusCode.Unauthorized, HttpStatusCode.OK, "authentication-required"),
            (HttpStatusCode.Forbidden, HttpStatusCode.OK, "access-denied-or-rate-limited")
        })
        {
            var handler = new Responses(scenario.Item1, scenario.Item2);
            using var http = new HttpClient(handler);
            var status = await new ReleaseUpdates(http).CheckAsync(new Version(0, 1), "test-only-token");
            check(status.State == scenario.Item3, "HTTP failure classification");
            check(handler.Paths.All(p => p.StartsWith("/repos/" + ReleaseUpdates.Repository)),
                "credentials only sent to fixed repository API");
        }
    }

    sealed class Responses(params HttpStatusCode[] statuses) : HttpMessageHandler
    {
        private int index;
        public List<string> Paths { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.RequestUri!.Host != "api.github.com") throw new Exception("Wrong API host");
            Paths.Add(request.RequestUri.AbsolutePath);
            return Task.FromResult(new HttpResponseMessage(statuses[index++])
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            });
        }
    }
}
