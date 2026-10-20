using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class RemoteCommandException(string message) : Exception(message);

// One command in flight. A timeout retains the original task: never replay an unknown operation.
internal sealed class RuntimeConnection
{
    private readonly Process? process;
    private readonly SharedConnection? shared;
    private readonly SemaphoreSlim gate = new(1, 1);
    private Task<JsonElement>? pending;
    private Task? closeTask;
    private long sequence;
    private bool uncertain;
    private bool closed;
    private readonly Task<string> errors;
    private readonly bool prepared;
    internal int WorkerPid => shared?.HostPid ?? process!.Id;
    internal bool IsShared => shared != null;
    internal int? SharedGamePid => shared?.GamePid;
    internal bool IsClosed => closed;

    private RuntimeConnection(Process child, bool prepared)
    {
        process = child;
        this.prepared = prepared;
        errors = child.StandardError.ReadToEndAsync();
    }

    private RuntimeConnection(SharedConnection connection)
    {
        shared = connection;
        errors = Task.FromResult("");
    }

    internal static async Task<RuntimeConnection> AttachAsync(string endpoint, string token,
        string? expectedInstance = null, int? expectedPid = null) =>
        new(await SharedConnection.OpenAsync(endpoint, token, expectedInstance, expectedPid));

    internal async Task DetachAsync()
    {
        if (shared == null) { await CloseAsync(); return; }
        await gate.WaitAsync();
        try { shared.Dispose(); closed = true; }
        finally { gate.Release(); }
    }

    internal static RuntimeConnection Start(string executable, bool prepared = false)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8 };
        start.ArgumentList.Add(prepared ? "--prepared-ipc" : "--desktop-ipc");
        start.Environment["LOCALAPPDATA"] = SharedPaths.LocalAppData;
        return new RuntimeConnection(Process.Start(start) ?? throw new IOException("运行组件未启动。"), prepared);
    }

    internal async Task<JsonElement> RequestAsync(string operation, object? payload = null, TimeSpan? timeout = null)
    {
        await gate.WaitAsync();
        try
        {
            if (closed || closeTask != null || uncertain) throw new InvalidOperationException("连接状态尚未确认，请先断开并恢复。");
            // Explicitly exposed client operations; battle entry remains separate.
            if (prepared ? operation is not ("capabilities" or "prepare" or "start" or "snapshot" or "status" or "control")
                : operation is not ("capabilities" or "connect" or "snapshot" or "trial-connect" or "arm" or "configure" or "disarm"
                or "capture-start" or "capture-status" or "capture-stop" or "mods-list" or "mods-enable" or "mods-disable"
                or "mods-package-inspect" or "mods-package-install" or "mods-package-list" or "mods-package-register"
                or "mods-package-uninstall" or "mods-config-read" or "mods-config-write"
                or "mods-profile-read" or "mods-profile-write" or "mods-command"))
                throw new ArgumentException("此客户端阶段未开放该操作。");
            pending = ExchangeAsync(operation, payload);
            try
            {
                var result = await pending.WaitAsync(timeout ?? TimeSpan.FromSeconds(30));
                pending = null;
                return result;
            }
            catch (RemoteCommandException) { pending = null; throw; }
            catch { uncertain = true; throw; }
        }
        finally { gate.Release(); }
    }

    private async Task<JsonElement> ExchangeAsync(string operation, object? payload)
    {
        if (shared != null) return await shared.RequestAsync(operation, payload);
        var id = (++sequence).ToString();
        await process!.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { id, operation, payload }));
        await process.StandardInput.FlushAsync();
        var line = await process.StandardOutput.ReadLineAsync()
            ?? throw new IOException("运行组件已退出，尚未确认恢复状态。");
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (!root.TryGetProperty("id", out var replyId) || replyId.GetString() != id)
            throw new IOException("运行组件回执不匹配，未继续发送命令。");
        if (!root.GetProperty("ok").GetBoolean())
            throw new RemoteCommandException(root.GetProperty("error").GetString() ?? "操作未完成。");
        return root.GetProperty("result").Clone();
    }

    internal async Task CloseAsync(TimeSpan? timeout = null)
    {
        await gate.WaitAsync();
        try
        {
            if (closed) return;
            // A timed-out close continues in the background; subsequent calls await the same cleanup.
            if (closeTask == null || closeTask.IsFaulted)
                closeTask = CloseCoreAsync();
            await closeTask.WaitAsync(timeout ?? TimeSpan.FromSeconds(30));
        }
        finally { gate.Release(); }
    }

    private async Task CloseCoreAsync()
    {
        if (pending != null)
        {
            try { await pending; }
            catch (RemoteCommandException) { /* The operation was rejected; cleanup is still possible. */ }
            pending = null;
        }
        var result = await ExchangeAsync("disconnect", null);
        if (!result.TryGetProperty("disconnected", out var done) || !done.GetBoolean())
            throw new IOException("运行组件未确认断开。");
        if (shared != null) { shared.Dispose(); closed = true; return; }
        process!.StandardInput.Close();
        var line = await process.StandardOutput.ReadLineAsync() ?? throw new IOException("缺少退出清理回执。");
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (root.GetProperty("event").GetString() != "closed" || !root.GetProperty("cleanup").GetProperty("disconnected").GetBoolean())
            throw new IOException("退出清理未成功。");
        await process.WaitForExitAsync();
        var stderr = await errors;
        if (process.ExitCode != 0) throw new IOException($"运行组件异常退出：{process.ExitCode}。{stderr}");
        closed = true;
        process.Dispose();
    }
}
