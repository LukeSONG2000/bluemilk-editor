using System.Diagnostics;

namespace Swgoh.Client;

internal static class ServerLauncher
{
    internal static async Task<ServerEndpoint> EnsureAsync(string executable)
    {
        var endpoint = ServerEndpoint.Read();
        if (endpoint != null) return endpoint;
        var start = new ProcessStartInfo(executable, "--app-server")
        {
            // Shell activation avoids inheriting the launching agent's pipe
            // handles, which otherwise prevent its stdout/stderr reaching EOF.
            UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden
        };
        using var process = Process.Start(start) ?? throw new IOException("共享服务未启动。");
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromSeconds(25))
        {
            endpoint = ServerEndpoint.Read();
            if (endpoint != null) return endpoint;
            await Task.Delay(100);
        }
        throw new IOException($"共享服务启动尚未确认（进程 {process.Id}）；未发送游戏操作。请检查服务状态后重连。");
    }
}
