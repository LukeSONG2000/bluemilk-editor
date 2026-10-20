using System.Runtime.InteropServices;

namespace Swgoh.Client;

internal static class SharedPaths
{
    internal static string Root => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bluemilk");
    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);

    internal static string LocalAppData
    {
        get
        {
            // Both installed and portable entry points use the user's real folder.
            // MSIX must also disable filesystem write virtualization in its manifest.
            var folder = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
            Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref folder, 0x00010000, IntPtr.Zero, out var path));
            try { return Marshal.PtrToStringUni(path) ?? throw new IOException("无法定位共享用户目录。"); }
            finally { Marshal.FreeCoTaskMem(path); }
        }
    }
}
