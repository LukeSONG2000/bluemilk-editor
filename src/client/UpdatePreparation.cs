using System.Diagnostics;

namespace Swgoh.Client;

// Called by the updater after its originating frontend detached. Does not close
// a game session, kill a process, start a server, install, or replay a command.
internal static class UpdatePreparation
{
    internal static async Task<UpdateLease> AcquireAsync(string serverDirectory,
        CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var endpoint = ServerEndpoint.Read(serverDirectory);
        if (endpoint != null)
        {
            using var host = Process.GetProcessById(endpoint.Pid);
            // Hold a Windows process handle before requesting shutdown. PID reuse
            // after exit must not redirect our wait onto an unrelated process.
            _ = host.Handle;
            if (ServerEndpoint.Read(serverDirectory) != endpoint)
                throw new IOException("服务身份已变化，未开始安装；请重新检查更新。");
            using var connection = await SharedConnection.OpenAsync(endpoint.Uri, endpoint.Token,
                endpoint.Instance, endpoint.Pid, cancellation);
            await connection.ShutdownForUpdateAsync().WaitAsync(cancellation);
            await host.WaitForExitAsync(cancellation);
            if (host.ExitCode != 0)
                throw new IOException("共享服务未正常退出，未开始安装。");
        }
        cancellation.ThrowIfCancellationRequested();
        // Do not retry: a newly started host or another updater wins this race.
        var lease = new UpdateLease(serverDirectory);
        try
        {
            if (ServerEndpoint.Read(serverDirectory) != null)
                throw new IOException("仍有共享服务运行，未开始安装。");
            cancellation.ThrowIfCancellationRequested();
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }
}
