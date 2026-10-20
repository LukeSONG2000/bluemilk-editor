using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed record ServerEndpoint(string Uri, string Token, string Instance, int Pid)
{
    public override string ToString() => $"ServerEndpoint {{ Uri = {Uri}, Instance = {Instance}, Pid = {Pid}, Token = [redacted] }}";
    [StructLayout(LayoutKind.Sequential)]
    private struct Blob { public int Size; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, uint flags, out Blob output);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    internal static ServerEndpoint? Read(string? directory = null)
    {
        directory ??= Environment.GetEnvironmentVariable("BLUEMILK_SERVER_DIRECTORY");
        directory ??= Path.Combine(SharedPaths.Root, "server");
        var file = Path.Combine(directory, "endpoint.json");
        byte[] bytes;
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length > 16384) throw new IOException("共享服务登记文件过大。");
            bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        using var document = JsonDocument.Parse(bytes);
        var data = document.RootElement;
        if (data.GetProperty("schemaVersion").GetInt32() != 1)
            throw new IOException("共享服务登记版本不兼容。");
        var uri = data.GetProperty("uri").GetString() ?? "";
        SharedConnection.ValidateEndpoint(uri);
        var instance = data.GetProperty("instance").GetString() ?? "";
        if (!Guid.TryParseExact(instance, "D", out var id) || id.ToString("D") != instance)
            throw new IOException("共享服务实例标识无效。");
        var pid = data.GetProperty("pid").GetInt32();
        var created = data.GetProperty("created").GetDouble();
        if (pid <= 0 || !double.IsFinite(created) || created <= 0)
            throw new IOException("共享服务进程标识无效。");
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited || Math.Abs((process.StartTime.ToUniversalTime() - DateTime.UnixEpoch).TotalSeconds - created) > 0.001)
                return null;
        }
        catch (ArgumentException) { return null; }
        var protectedToken = Convert.FromBase64String(data.GetProperty("protectedToken").GetString() ?? "");
        var pin = GCHandle.Alloc(protectedToken, GCHandleType.Pinned);
        var input = new Blob { Size = protectedToken.Length, Data = pin.AddrOfPinnedObject() };
        Blob output = default;
        try
        {
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法读取当前用户的共享服务凭据。");
            if (output.Size < 32 || output.Size > 4096) throw new IOException("共享服务凭据无效。");
            var tokenBytes = new byte[output.Size];
            Marshal.Copy(output.Data, tokenBytes, 0, tokenBytes.Length);
            try
            {
                if (tokenBytes.Any(b => b < 33 || b > 126)) throw new IOException("共享服务凭据无效。");
                return new(uri, Encoding.ASCII.GetString(tokenBytes), instance, pid);
            }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(tokenBytes); }
        }
        finally
        {
            if (output.Data != IntPtr.Zero)
            {
                for (var i = 0; i < output.Size; i++) Marshal.WriteByte(output.Data, i, 0);
                LocalFree(output.Data);
            }
            pin.Free();
        }
    }
}
