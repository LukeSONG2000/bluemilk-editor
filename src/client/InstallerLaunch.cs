using System.Diagnostics;

namespace Swgoh.Client;

public static class InstallerLaunch
{
    // Use the normal installer, including UAC and its accepted close-running-app
    // confirmation. It owns shutdown, installation and the finish-page restart.
    public static ProcessStartInfo Create(string packagePath, string installDirectory, UpdateChannel channel)
    {
        if (!Path.IsPathFullyQualified(packagePath) || !File.Exists(packagePath) ||
            !Path.IsPathFullyQualified(installDirectory)) throw new IOException("安装文件或目录无效。");
        var extension = channel == UpdateChannel.Exe ? ".exe" : ".msix";
        if (!Path.GetExtension(packagePath).Equals(extension, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("安装包类型不符。");
        var start = new ProcessStartInfo(Path.GetFullPath(packagePath)) { UseShellExecute = true };
        if (channel == UpdateChannel.Exe)
        {
            start.ArgumentList.Add("/DIR=" + Path.GetFullPath(installDirectory).TrimEnd(Path.DirectorySeparatorChar));
            start.ArgumentList.Add("/NORESTART");
        }
        return start;
    }
}
