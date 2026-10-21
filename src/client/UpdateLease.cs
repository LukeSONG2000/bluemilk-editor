namespace Swgoh.Client;

// Same Windows sharing contract as runtime/update_lease.py. Hold across the
// complete installer lifetime; dispose before restarting the updated host.
// This does not shut down a host or establish that a downloaded package is valid.
internal sealed class UpdateLease : IDisposable
{
    private readonly FileStream handle;
    internal UpdateLease(string serverDirectory)
    {
        Directory.CreateDirectory(serverDirectory);
        handle = new FileStream(Path.Combine(Path.GetFullPath(serverDirectory), "update.lock"),
            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
    public void Dispose() => handle.Dispose();
}
