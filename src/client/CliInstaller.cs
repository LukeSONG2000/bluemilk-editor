using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swgoh.Client;

internal record CliPackage(string ExeHash, string GuideHash)
{
    public string Version => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(ExeHash + GuideHash))).ToLowerInvariant();
}

// File installation only. No process execution, game connection, PATH or registry changes.
internal sealed class CliInstaller(string sourceDirectory, string installRoot)
{
    internal const string ExeName = "bluemilk.exe";
    internal const string GuideName = "CLI说明.txt";

    public CliPackage ReadPackage()
    {
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(sourceDirectory, "manifest.json")));
        var root = manifest.RootElement;
        if (root.GetProperty("schemaVersion").GetInt32() != 1) throw new IOException("CLI 分发包版本不支持。");
        var exeHash = root.GetProperty("exeSha256").GetString() ?? "";
        var guideHash = root.GetProperty("guideSha256").GetString() ?? "";
        if (!Regex.IsMatch(exeHash, "^[a-f0-9]{64}$") || !Regex.IsMatch(guideHash, "^[a-f0-9]{64}$"))
            throw new IOException("CLI 分发包校验信息无效。");
        return new CliPackage(exeHash, guideHash);
    }

    public string TargetDirectory(CliPackage package) => Path.Combine(Path.GetFullPath(installRoot), package.Version);
    public string ExecutablePath(CliPackage package) => Path.Combine(TargetDirectory(package), ExeName);
    public bool IsInstalled(CliPackage package)
    {
        var destination = TargetDirectory(package);
        if (!Directory.Exists(destination)) return false;
        VerifyDirectory(destination, package);
        return true;
    }

    public string Install()
    {
        var package = ReadPackage();
        VerifyDirectory(sourceDirectory, package);
        if (IsInstalled(package)) return ExecutablePath(package);
        Directory.CreateDirectory(installRoot);
        var staging = Path.Combine(Path.GetFullPath(installRoot), ".install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            File.Copy(Path.Combine(sourceDirectory, ExeName), Path.Combine(staging, ExeName));
            File.Copy(Path.Combine(sourceDirectory, GuideName), Path.Combine(staging, GuideName));
            VerifyDirectory(staging, package);
            try { Directory.Move(staging, TargetDirectory(package)); }
            catch (IOException) when (Directory.Exists(TargetDirectory(package)))
            {
                // A concurrent install can win; never overwrite an existing version.
                VerifyDirectory(TargetDirectory(package), package);
            }
            VerifyDirectory(TargetDirectory(package), package);
            return ExecutablePath(package);
        }
        finally
        {
            // Only these two files belong to this installation attempt.
            if (Directory.Exists(staging))
            {
                File.Delete(Path.Combine(staging, ExeName));
                File.Delete(Path.Combine(staging, GuideName));
                Directory.Delete(staging, recursive: false);
            }
        }
    }

    public string ReadGuide()
    {
        var package = ReadPackage();
        VerifyDirectory(sourceDirectory, package);
        return File.ReadAllText(Path.Combine(sourceDirectory, GuideName), Encoding.UTF8);
    }

    private static void VerifyDirectory(string directory, CliPackage package)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("CLI 目录不能是链接，请使用独立的工具目录。");
        VerifyFile(Path.Combine(directory, ExeName), package.ExeHash);
        VerifyFile(Path.Combine(directory, GuideName), package.GuideHash);
    }

    private static void VerifyFile(string path, string expected)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("CLI 文件不能是链接。");
        using var stream = File.OpenRead(path);
        var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (actual != expected) throw new IOException("CLI 文件完整性校验失败，未覆盖已安装版本。");
    }
}
