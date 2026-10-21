using Microsoft.Windows.AppLifecycle;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Windows.ApplicationModel.Activation;

namespace Swgoh.Client;

internal static class PackageActivation
{
    private static readonly object gate = new();
    private static readonly Queue<string[]> pending = new();
    private static Action<string[]>? receive;
    private static AppInstance? instance;

    [DllImport("ole32.dll")]
    private static extern int CoWaitForMultipleHandles(uint flags, uint milliseconds,
        uint count, nint[] handles, out uint index);
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(uint pid);

    internal static bool RedirectIfNeeded()
    {
        var arguments = Environment.GetCommandLineArgs().Skip(1).ToArray();
        if (arguments.Any(arg => arg.StartsWith("--smoke"))) return false;
        var scope = Environment.GetEnvironmentVariable("BLUEMILK_SERVER_DIRECTORY") ?? SharedPaths.Root;
        var key = "BlueMilk.Editor." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scope.ToUpperInvariant())));
        instance = AppInstance.FindOrRegisterForKey(key);
        if (instance.IsCurrent) {
            instance.Activated += (_, activation) => {
                var args = activation.Data is ILaunchActivatedEventArgs launch
                    ? PackageOpenArguments.FromCommandLine(launch.Arguments)
                    : activation.Data is IFileActivatedEventArgs file
                    ? file.Files.Select(item => item.Path).ToArray() : [];
                Enqueue(args);
            };
            Enqueue(arguments);
            return false;
        }
        AllowSetForegroundWindow(instance.ProcessId);
        var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        using var completed = new ManualResetEvent(false);
        var redirect = Task.Run(async () => {
            try { await instance.RedirectActivationToAsync(activation); }
            finally { completed.Set(); }
        });
        // Pump COM on this STA while the redirected activation is delivered.
        var result = CoWaitForMultipleHandles(0, 30000, 1, [completed.SafeWaitHandle.DangerousGetHandle()], out _);
        if (result != 0) throw new IOException("已有客户端暂未响应文件打开请求，请稍后重试。");
        redirect.GetAwaiter().GetResult();
        return true;
    }

    private static void Enqueue(string[] arguments)
    {
        Action<string[]>? target;
        lock (gate) { target = receive; if (target == null) pending.Enqueue(arguments); }
        target?.Invoke(arguments);
    }
    internal static void Ready(Action<string[]> handler)
    {
        string[][] queued;
        lock (gate) { receive = handler; queued = pending.ToArray(); pending.Clear(); }
        foreach (var args in queued) handler(args);
    }
}
