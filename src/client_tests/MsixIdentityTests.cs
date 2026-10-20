using System.IO.Compression;
using System.Text;
using System.Xml;
using Swgoh.Client;

static class MsixIdentityTests
{
    public static void Run(string root, Action<bool, string> check)
    {
        const string manifest = """
        <Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
          <Identity Name="BlueMilk.Editor" Publisher="CN=BlueMilk Editor" Version="0.2.0.0" ProcessorArchitecture="x64"/>
        </Package>
        """;
        var version = new Version(0, 2, 0, 0);
        string Fixture(string xml, bool signed = true, bool duplicate = false)
        {
            var path = Path.Combine(root, Guid.NewGuid() + ".msix");
            using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
            void Write(string name, string content)
            {
                using var entry = zip.CreateEntry(name).Open();
                entry.Write(Encoding.UTF8.GetBytes(content));
            }
            Write("AppxManifest.xml", xml);
            if (duplicate) Write("AppxManifest.xml", xml);
            if (signed) Write("AppxSignature.p7x", "PKCXfixture-not-a-real-signature");
            return path;
        }
        var identity = MsixIdentity.ReadAndValidate(Fixture(manifest), version, "CN=BlueMilk Editor");
        check(identity.Name == "BlueMilk.Editor" && identity.Version == version, "matching MSIX metadata accepted (not trust validation)");
        foreach (var bad in new[]
        {
            Fixture(manifest.Replace("Name=\"BlueMilk.Editor\"", "Name=\"Other.App\"")),
            Fixture(manifest.Replace("CN=BlueMilk Editor", "CN=Other Publisher")),
            Fixture(manifest.Replace("0.2.0.0", "0.1.0.0")),
            Fixture(manifest.Replace("x64", "arm64")),
            Fixture(manifest.Replace("ProcessorArchitecture=", "ResourceId=\"resource-only\" ProcessorArchitecture=")),
            Fixture(manifest, signed: false),
            Fixture(manifest, duplicate: true),
            Fixture("<!DOCTYPE Package [<!ENTITY x SYSTEM \"file:///private\">]>" + manifest)
        })
        {
            bool rejected = false;
            try { MsixIdentity.ReadAndValidate(bad, version, "CN=BlueMilk Editor"); }
            catch (Exception e) when (e is InvalidDataException or XmlException) { rejected = true; }
            check(rejected, "reject wrong, unsigned or malformed package identity");
        }
    }
}
