using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Swgoh.Client;

internal record ProbeResult(string Protocol, int OperationCount);

// Deliberately read-only: this spike cannot connect or submit gameplay commands.
internal static class WorkerProbe
{
    public static async Task<ProbeResult> RunAsync(string executable)
    {
        if (!File.Exists(executable)) throw new FileNotFoundException("未找到本地工具。", executable);
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8 };
        start.ArgumentList.Add("--desktop-ipc");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("工具进程未启动。");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteLineAsync("{\"id\":\"shell-probe\",\"operation\":\"capabilities\"}");
        process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            // This specific child has never attached; killing a future live session is forbidden.
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            throw new TimeoutException("本地能力查询超时，未连接游戏。");
        }
        var error = await stderr;
        if (process.ExitCode != 0) throw new InvalidOperationException($"工具退出码 {process.ExitCode}: {error}");
        ProbeResult? result = null;
        bool cleanup = false;
        foreach (var line in (await stdout).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.TryGetProperty("id", out var id) && id.GetString() == "shell-probe")
            {
                if (!root.GetProperty("ok").GetBoolean()) throw new InvalidOperationException("工具拒绝能力查询。");
                var body = root.GetProperty("result");
                var protocol = body.GetProperty("protocol").GetString();
                if (protocol != "jsonl-v1") throw new InvalidOperationException("工具协议不匹配。");
                result = new ProbeResult(protocol, body.GetProperty("operations").GetArrayLength());
            }
            if (root.TryGetProperty("event", out var kind) && kind.GetString() == "closed")
                cleanup = root.GetProperty("cleanup").GetProperty("disconnected").GetBoolean();
        }
        return result != null && cleanup ? result : throw new InvalidOperationException("工具回执或退出确认不完整。");
    }
}
