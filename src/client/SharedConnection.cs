using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Swgoh.Client;

internal sealed class SharedConnection : IDisposable
{
    private readonly ClientWebSocket socket = new();
    private readonly string clientId = Guid.NewGuid().ToString("N");
    private string instance = "";
    private long sequence;
    private readonly CancellationTokenSource lifetime = new();
    private readonly Channel<JsonElement> replies = Channel.CreateBounded<JsonElement>(1);
    private Task? receiver;
    private int disposed;
    internal int HostPid { get; private set; }
    internal int? GamePid { get; private set; }
    internal string SessionMode { get; private set; } = "normal";
    internal bool SupportsUpdateShutdown { get; private set; }

    internal static Uri ValidateEndpoint(string endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "ws" ||
            uri.Host != "127.0.0.1" || uri.Port <= 0 || uri.AbsolutePath != "/rpc" ||
            uri.Query != "" || uri.Fragment != "" || uri.UserInfo != "")
            throw new ArgumentException("本阶段只支持本机 ws://127.0.0.1:PORT/rpc。");
        return uri;
    }

    internal static async Task<SharedConnection> OpenAsync(string endpoint, string token,
        string? expectedInstance = null, int? expectedPid = null, CancellationToken cancellation = default)
    {
        var uri = ValidateEndpoint(endpoint);
        if (token.Length < 32 || token.Any(c => c > 127 || char.IsControl(c)))
            throw new ArgumentException("共享服务令牌缺失或无效。");
        var connection = new SharedConnection();
        try
        {
            connection.socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            connection.socket.Options.Proxy = null;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            deadline.CancelAfter(TimeSpan.FromSeconds(20));
            await connection.socket.ConnectAsync(uri, deadline.Token);
            connection.receiver = Task.Run(() => connection.ReceiveLoopAsync(connection.lifetime.Token));
            var info = await connection.ExchangeAsync("server.info", null).WaitAsync(deadline.Token);
            connection.instance = info.GetProperty("instance").GetString() ?? throw new IOException("缺少服务实例。");
            connection.HostPid = info.GetProperty("hostPid").GetInt32();
            if ((expectedInstance != null && connection.instance != expectedInstance) ||
                (expectedPid.HasValue && connection.HostPid != expectedPid))
                throw new IOException("共享服务身份已改变；未发送游戏操作，请重新连接。");
            if (info.TryGetProperty("gamePid", out var pid) && pid.ValueKind == JsonValueKind.Number)
                connection.GamePid = pid.GetInt32();
            if (info.TryGetProperty("sessionMode", out var mode)) connection.SessionMode = mode.GetString() ?? "normal";
            connection.SupportsUpdateShutdown =
                info.TryGetProperty("updateShutdownSupported", out var update) && update.ValueKind == JsonValueKind.True &&
                info.TryGetProperty("updateLeaseVersion", out var lease) && lease.TryGetInt32(out var leaseVersion) && leaseVersion == 2;
            return connection;
        }
        catch { connection.Dispose(); throw; }
    }

    internal Task<JsonElement> RequestAsync(string operation, object? payload) =>
        ExchangeAsync("runtime.call", new { instance, operation, payload });

    // Use a dedicated connection: a timeout has an unknown outcome and must not
    // be followed by another exchange or an unconditional shutdown fallback.
    internal async Task ShutdownForUpdateAsync()
    {
        if (!SupportsUpdateShutdown)
            throw new InvalidOperationException("当前运行服务不支持安全更新退出；请先正常关闭旧服务。");
        var result = await ExchangeAsync("server.shutdownForUpdate", new { instance });
        if (!result.TryGetProperty("stopped", out var stopped) || stopped.ValueKind != JsonValueKind.True ||
            !result.TryGetProperty("reason", out var reason) || reason.GetString() != "update")
            throw new IOException("服务未确认更新退出，未开始安装。");
    }

    private async Task<JsonElement> ExchangeAsync(string method, object? parameters)
    {
        var id = clientId + ":" + (++sequence);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { jsonrpc = "2.0", id, method, @params = parameters });
        if (bytes.Length > 16384) throw new ArgumentException("请求超过共享服务的大小限制。");
        await socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, CancellationToken.None);
        JsonElement root;
        try { root = await replies.Reader.ReadAsync(lifetime.Token); }
        catch (ChannelClosedException closed) { throw new IOException("共享服务连接中断；请求结果尚未确认。", closed); }
        if (root.GetProperty("jsonrpc").GetString() != "2.0" || root.GetProperty("id").GetString() != id ||
            root.TryGetProperty("result", out var result) == root.TryGetProperty("error", out var error))
            throw new IOException("共享服务回执不匹配，未重发命令。");
        if (error.ValueKind != JsonValueKind.Undefined)
            throw new RemoteCommandException(error.GetProperty("message").GetString() ?? "共享操作失败。");
        return result.Clone();
    }

    private async Task ReceiveLoopAsync(CancellationToken token)
    {
        Exception? failure = null;
        try {
            // Keep ReceiveAsync active while idle so ClientWebSocket can answer
            // protocol Ping frames. This sends no game queries or command retries.
            var chunk = new byte[8192];
            while (!token.IsCancellationRequested) {
                using var buffer = new MemoryStream();
                ValueWebSocketReceiveResult received;
                do {
                    received = await socket.ReceiveAsync(chunk.AsMemory(), token).ConfigureAwait(false);
                    if (received.MessageType != WebSocketMessageType.Text)
                        throw new IOException("共享服务连接中断或返回无效消息；请求结果尚未确认。");
                    if (buffer.Length + received.Count > 16 * 1024 * 1024)
                        throw new IOException("共享服务响应超过大小限制。");
                    buffer.Write(chunk, 0, received.Count);
                } while (!received.EndOfMessage);
                using var document = JsonDocument.Parse(buffer.ToArray());
                await replies.Writer.WriteAsync(document.RootElement.Clone(), token).ConfigureAwait(false);
            }
        } catch (Exception error) { failure = error; }
        finally { replies.Writer.TryComplete(failure); }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        lifetime.Cancel(); socket.Abort(); socket.Dispose();
        // The receive task observes cancellation and completes the response queue.
        if (receiver == null) lifetime.Dispose();
        else _ = receiver.ContinueWith(_ => lifetime.Dispose(), CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }
}
