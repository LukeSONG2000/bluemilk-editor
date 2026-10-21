namespace Swgoh.Client;

// Same Windows sharing contract as runtime/update_lease.py. Hold across the
// complete installer lifetime; dispose before restarting the updated host.
// This does not shut down a host or establish that a downloaded package is valid.
internal sealed class UpdateLease : IDisposable
{
    private readonly FileStream handle;
    private UpdateLease? global;
    internal static string GlobalDirectory => Path.Combine(SharedPaths.Root, "runtime-update");
    internal static UpdateLease AcquireInstallation(string serverDirectory)
    {
        var local = new UpdateLease(serverDirectory);
        try { local.global = new UpdateLease(GlobalDirectory); return local; }
        catch { local.Dispose(); throw; }
    }
    internal UpdateLease(string serverDirectory)
    {
        Directory.CreateDirectory(serverDirectory);
        handle = new FileStream(Path.Combine(Path.GetFullPath(serverDirectory), "update.lock"),
            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
    public void Dispose() { global?.Dispose(); global = null; handle.Dispose(); }
}
