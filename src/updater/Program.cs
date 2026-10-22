using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Swgoh.Client;

if(args.Length>0&&args[0] is "--query-install" or "--prepare-install")return await InstallationPreparation.RunAsync(args);
if (args.Length != 1) return 2;
var jobPath = Path.GetFullPath(args[0]);
var root = Path.GetDirectoryName(jobPath)!;
var receipt = Path.Combine(root, "receipt.json");
FileStream reserved;
try { reserved = new FileStream(Path.Combine(root, "job.lock"), FileMode.OpenOrCreate,
    FileAccess.ReadWrite, FileShare.None); }
catch (IOException) { return 4; }
catch (UnauthorizedAccessException) { return 4; }
using var ownership = reserved;
// Unknown or completed attempts are never replayed by launching the same job.
if (File.Exists(receipt)) return 3;
string phase = "validating";
bool installed = false;
void Save(string state, string? failure = null)
{
    var temporary = receipt + ".partial";
    using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
    {
        JsonSerializer.Serialize(stream, new { schemaVersion = 1,
            state, phase, installed, failure, utc = DateTimeOffset.UtcNow });
        stream.Flush(true);
    }
    File.Move(temporary, receipt, true);
}
try
{
    Save("running");
    if (new FileInfo(jobPath).Length > 16384) throw new InvalidDataException("Job too large");
    var job = JsonSerializer.Deserialize<Job>(File.ReadAllText(jobPath)) ?? throw new InvalidDataException();
    var version = Version.Parse(job.Version);
    if (job.SchemaVersion != 1 || version.Build < 0 || version.Revision != 0 ||
        job.Channel is not ("exe" or "msix") || job.ParentPid <= 0 || job.ParentStartedUtcTicks <= 0 ||
        !Path.IsPathFullyQualified(job.PackagePath) || !Path.IsPathFullyQualified(job.InstallDirectory) ||
        !Path.IsPathFullyQualified(job.ServerDirectory)) throw new InvalidDataException("Invalid job");
    var channel = job.Channel == "exe" ? UpdateChannel.Exe : UpdateChannel.Msix;
    var installRoot = Path.GetFullPath(job.InstallDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    if (AppContext.BaseDirectory.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("Updater must be staged outside the installation");
    var package = new ReleasePackage(version, ReleaseUpdates.PackageName(version, channel),
        new Uri("https://api.github.com/repos/" + ReleaseUpdates.Repository + "/releases/assets/1"),
        job.Size, job.Sha256, channel);
    // Hold the verified bytes stable until deployment has returned.
    using var packageHandle = new FileStream(job.PackagePath, FileMode.Open, FileAccess.Read, FileShare.Read);
    await PackageDownloads.VerifyAsync(job.PackagePath, package);
    if (channel == UpdateChannel.Msix) MsixIdentity.ReadAndValidate(job.PackagePath, version, "CN=BlueMilk Editor");
    phase = "waiting-client"; Save("running");
    using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
    Process? parent = null;
    try { parent = Process.GetProcessById(job.ParentPid); }
    catch (ArgumentException) { /* Originating client already exited. */ }
    using (parent)
    {
        if (parent != null)
        {
            _ = parent.Handle;
            if (parent.StartTime.ToUniversalTime().Ticks != job.ParentStartedUtcTicks)
                throw new IOException("Originating process identity changed");
            await parent.WaitForExitAsync(deadline.Token);
        }
    }
    phase = "preparing-runtime"; Save("running");
    using (var lease = await UpdatePreparation.AcquireAsync(job.ServerDirectory, deadline.Token))
    {
        // Includes the outer PyInstaller bootstrapper and alternate-endpoint
        // hosts using this installation. Never terminate these processes.
        await WaitForInstallationProcesses(installRoot, deadline.Token);
        phase = "installing"; Save("running");
        if (channel == UpdateChannel.Exe)
        {
            var start = new ProcessStartInfo(job.PackagePath) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var arg in new[] { "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-",
                "/BLUEMILKUPDATER=1", "/DIR=" + job.InstallDirectory, "/LOG=" + Path.Combine(root, "installer.log") }) start.ArgumentList.Add(arg);
            using var installer = Process.Start(start) ?? throw new IOException("Installer did not start");
            // Do not timeout and release the lease while an installer is still writing.
            await installer.WaitForExitAsync();
            if (installer.ExitCode != 0) throw new IOException("Installer failed: " + installer.ExitCode);
            var exe = Path.Combine(job.InstallDirectory, "BlueMilk.Editor.exe");
            if (Version.Parse(FileVersionInfo.GetVersionInfo(exe).FileVersion!) != version)
                throw new IOException("Installed executable version mismatch");
        }
        else
        {
            await PowerShell(job, "Add-AppxPackage -Path $j.PackagePath -ErrorAction Stop; " +
                "$p=@(Get-AppxPackage -Name BlueMilk.Editor | Where-Object {$_.Publisher -eq 'CN=BlueMilk Editor'}); " +
                "if($p.Count -ne 1 -or $p[0].Version.ToString() -ne $j.Version){throw 'Installed package version mismatch'}", root);
        }
        installed = true; phase = "installed"; Save("installed");
    }
    phase = "restarting"; Save("installed");
    if (channel == UpdateChannel.Exe)
    {
        using var launched = Process.Start(new ProcessStartInfo(Path.Combine(job.InstallDirectory, "BlueMilk.Editor.exe"))
            { UseShellExecute = true, WorkingDirectory = job.InstallDirectory });
        if (launched == null) throw new IOException("Restart did not launch");
    }
    else
    {
        await PowerShell(job, "$p=@(Get-AppxPackage -Name BlueMilk.Editor | Where-Object {$_.Publisher -eq 'CN=BlueMilk Editor'}); " +
            "if($p.Count -ne 1){throw 'Package not found'}; " +
            "Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$p[0].PackageFamilyName+'!Editor')", root);
    }
    Save("installed-restart-requested");
    return 0;
}
catch (Exception error)
{
    Save("failed", error.GetType().Name);
    return 1;
}

static async Task WaitForInstallationProcesses(string root, CancellationToken cancellation)
{
    while (true)
    {
        var busy = false;
        foreach (var name in new[] { "BlueMilk.Editor", "SWGoH-Runtime", "bluemilk" })
        foreach (var process in Process.GetProcessesByName(name))
        using (process)
        {
            try
            {
                if (process.MainModule?.FileName is string path && path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) busy = true;
            }
            catch (InvalidOperationException) { if (!process.HasExited) throw; }
            catch (System.ComponentModel.Win32Exception) { if (!process.HasExited) throw; }
        }
        if (!busy) return;
        await Task.Delay(200, cancellation);
    }
}

static async Task PowerShell(Job job, string action, string root)
{
    // The job is data, never interpolated into PowerShell source syntax.
    var data = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(job));
    var script = "$ErrorActionPreference='Stop'; try { $j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + data +
        "')) | ConvertFrom-Json; " + action + "; exit 0 } catch { exit 1 }";
    var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
        "WindowsPowerShell", "v1.0", "powershell.exe")) { UseShellExecute = false, CreateNoWindow = true };
    foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) })
        start.ArgumentList.Add(arg);
    using var process = Process.Start(start) ?? throw new IOException("Deployment process did not start");
    await process.WaitForExitAsync();
    if (process.ExitCode != 0) throw new IOException("Package deployment or restart failed");
}

internal sealed record Job(int SchemaVersion, string Channel, string Version, string PackagePath,
    long Size, string Sha256, string InstallDirectory, string ServerDirectory, int ParentPid, long ParentStartedUtcTicks);
