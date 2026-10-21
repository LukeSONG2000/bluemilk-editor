using System.Runtime.InteropServices;

namespace Swgoh.Client;

internal static class PackageOpenArguments
{
    internal static string[] Parse(string[] arguments)
    {
        if (arguments.Length == 0) return [];
        var paths = arguments[0] == "--install-mod" ? arguments.Skip(1).ToArray() : arguments;
        if (paths.Length == 0 || paths.Any(path => !Path.IsPathFullyQualified(path) ||
                !string.Equals(Path.GetExtension(path), ".bluemilk", StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException("请选择有效的 .bluemilk 文件。");
        return paths.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint memory);

    internal static string[] FromCommandLine(string command)
    {
        if (string.IsNullOrWhiteSpace(command)) return [];
        var pointer = CommandLineToArgvW(command, out var count);
        if (pointer == 0) throw new IOException("无法读取文件打开参数。");
        try {
            var args = Enumerable.Range(0, count).Select(i =>
                Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * nint.Size)) ?? "").ToArray();
            // App SDK launch arguments can include the Win32 executable name.
            return args.Length > 0 && args[0].EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? args.Skip(1).ToArray() : args;
        } finally { LocalFree(pointer); }
    }
}
