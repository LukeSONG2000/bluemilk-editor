using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;

namespace Swgoh.Client;

public sealed record MsixIdentity(string Name, string Publisher, Version Version, string Architecture)
{
    // Metadata preflight only. Windows deployment must still validate the signature,
    // certificate trust, block map and payload before registering the update.
    public static MsixIdentity ReadAndValidate(string path, Version expectedVersion, string expectedPublisher)
    {
        using var file = File.OpenRead(path);
        using var zip = new ZipArchive(file, ZipArchiveMode.Read);
        var manifests = zip.Entries.Where(e => e.FullName == "AppxManifest.xml").ToArray();
        var signatures = zip.Entries.Where(e => e.FullName == "AppxSignature.p7x").ToArray();
        if (manifests.Length != 1 || manifests[0].Length > 1024 * 1024 ||
            signatures.Length != 1 || signatures[0].Length < 5)
            throw new InvalidDataException("A single manifest and package signature are required.");
        using (var signature = signatures[0].Open())
        {
            Span<byte> header = stackalloc byte[4];
            signature.ReadExactly(header);
            if (!header.SequenceEqual("PKCX"u8)) throw new InvalidDataException("Invalid package signature header.");
        }
        using var stream = manifests[0].Open();
        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1024 * 1024
        });
        var doc = XDocument.Load(reader);
        XNamespace ns = "http://schemas.microsoft.com/appx/manifest/foundation/windows10";
        var identities = doc.Root?.Name == ns + "Package" ? doc.Root.Elements(ns + "Identity").ToArray() : [];
        if (identities.Length != 1) throw new InvalidDataException("Package identity is missing or ambiguous.");
        var identity = identities[0];
        if (!Version.TryParse((string?)identity.Attribute("Version"), out var version) || version != expectedVersion ||
            (string?)identity.Attribute("Name") != "BlueMilk.Editor" ||
            (string?)identity.Attribute("Publisher") != expectedPublisher ||
            (string?)identity.Attribute("ProcessorArchitecture") != "x64" ||
            !string.IsNullOrEmpty((string?)identity.Attribute("ResourceId")))
            throw new InvalidDataException("Update package identity, publisher, architecture or version does not match.");
        return new("BlueMilk.Editor", expectedPublisher, version, "x64");
    }
}
