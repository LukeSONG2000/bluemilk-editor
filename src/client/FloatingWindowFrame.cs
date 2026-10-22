using Microsoft.UI.Xaml;
using System.Runtime.InteropServices;

namespace Swgoh.Client;

// Per-window frame and DWM setup; no process-wide styles or theme changes.
internal sealed class FloatingWindowFrame : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int L,T,R,B; }
    [StructLayout(LayoutKind.Sequential)] private struct Margins { public int L,R,T,B; }
    [StructLayout(LayoutKind.Sequential)] private struct Blur { public uint Flags;public int Enabled;public nint Region;public int Transition; }
    private delegate nint Subclass(nint h,uint m,nint w,nint l,nuint id,nuint data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(nint h,Subclass callback,nuint id,nuint data);
    [DllImport("comctl32.dll")] private static extern bool RemoveWindowSubclass(nint h,Subclass callback,nuint id);
    [DllImport("comctl32.dll")] private static extern nint DefSubclassProc(nint h,uint m,nint w,nint l);
    [DllImport("user32.dll")] private static extern int GetWindowLong(nint h,int index);
    [DllImport("user32.dll")] private static extern int SetWindowLong(nint h,int index,int value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(nint h,nint after,int x,int y,int w,int hgt,uint flags);
    [DllImport("user32.dll")] private static extern bool GetClientRect(nint h,out Rect rect);
    [DllImport("user32.dll")] private static extern int FillRect(nint dc,ref Rect rect,nint brush);
    [DllImport("gdi32.dll")] private static extern nint GetStockObject(int id);
    [DllImport("gdi32.dll")] private static extern nint CreateRectRgn(int l,int t,int r,int b);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint obj);
    [DllImport("dwmapi.dll")] private static extern int DwmEnableBlurBehindWindow(nint h,ref Blur blur);
    [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(nint h,ref Margins margins);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(nint h,uint attr,ref uint value,int size);
    private readonly nint hwnd;
    private readonly Subclass callback;
    internal FloatingWindowFrame(Window window) {
        hwnd=WinRT.Interop.WindowNative.GetWindowHandle(window);callback=Message;
        if(!SetWindowSubclass(hwnd,callback,1,0))throw new InvalidOperationException("无法初始化悬浮窗边框。");
        SetWindowLong(hwnd,-16,GetWindowLong(hwnd,-16)&~0x00C40000); // caption + thick frame
        uint corner=1,border=0xFFFFFFFE;
        DwmSetWindowAttribute(hwnd,33,ref corner,4);DwmSetWindowAttribute(hwnd,34,ref border,4);
        Configure();SetWindowPos(hwnd,0,0,0,0,0,0x0037); // frame changed; no move/size/z-order/activation
    }
    private void Configure(){
        var margins=new Margins();DwmExtendFrameIntoClientArea(hwnd,ref margins);
        var region=CreateRectRgn(-2,-2,-1,-1);
        try{var blur=new Blur {Flags=3,Enabled=1,Region=region};DwmEnableBlurBehindWindow(hwnd,ref blur);}
        finally{DeleteObject(region);}
    }
    private nint Message(nint h,uint m,nint w,nint l,nuint id,nuint data){
        if(m==0x0083)return 0; // no nonclient pixels above the app's original border
        if(m==0x0014&&GetClientRect(h,out var rect)){FillRect(w,ref rect,GetStockObject(4));return 1;}
        if(m==0x031E)Configure();
        return DefSubclassProc(h,m,w,l);
    }
    public void Dispose()=>RemoveWindowSubclass(hwnd,callback,1);
}
