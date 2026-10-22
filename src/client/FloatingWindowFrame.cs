using Microsoft.UI.Xaml;
using System.Runtime.InteropServices;
using Microsoft.UI.Input;
using Windows.Graphics;

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
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint h,out Rect rect);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint h);
    [DllImport("user32.dll")] private static extern int FillRect(nint dc,ref Rect rect,nint brush);
    [DllImport("gdi32.dll")] private static extern nint GetStockObject(int id);
    [DllImport("gdi32.dll")] private static extern nint CreateRectRgn(int l,int t,int r,int b);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint obj);
    [DllImport("dwmapi.dll")] private static extern int DwmEnableBlurBehindWindow(nint h,ref Blur blur);
    [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(nint h,ref Margins margins);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(nint h,uint attr,ref uint value,int size);
    private readonly nint hwnd;
    private readonly Subclass callback;
    private readonly InputNonClientPointerSource input;
    private bool resizable;
    internal FloatingWindowFrame(Window window) {
        hwnd=WinRT.Interop.WindowNative.GetWindowHandle(window);callback=Message;
        input=InputNonClientPointerSource.GetForWindowId(window.AppWindow.Id);
        if(!SetWindowSubclass(hwnd,callback,1,0))throw new InvalidOperationException("无法初始化悬浮窗边框。");
        SetWindowLong(hwnd,-16,GetWindowLong(hwnd,-16)&~0x00C40000); // caption + thick frame
        uint corner=1,border=0xFFFFFFFE;
        DwmSetWindowAttribute(hwnd,33,ref corner,4);DwmSetWindowAttribute(hwnd,34,ref border,4);
        Configure();SetWindowPos(hwnd,0,0,0,0,0,0x0037); // frame changed; no move/size/z-order/activation
    }
    internal void SetResizable(bool value){
        resizable=value;
        var style=GetWindowLong(hwnd,-16)&~0x00C40000;
        SetWindowLong(hwnd,-16,value?style|0x00040000:style);
        SetWindowPos(hwnd,0,0,0,0,0,0x0037);
        UpdateResizeRegions();
    }
    internal void UpdateResizeRegions(){
        if(!resizable){foreach(var kind in new[]{NonClientRegionKind.TopBorder,NonClientRegionKind.LeftBorder,NonClientRegionKind.BottomBorder,NonClientRegionKind.RightBorder})input.ClearRegionRects(kind);return;}
        if(!GetClientRect(hwnd,out var rect))return;
        var edge=(int)Math.Ceiling(6*GetDpiForWindow(hwnd)/96d);var width=rect.R;var height=rect.B;
        input.SetRegionRects(NonClientRegionKind.TopBorder,[new RectInt32(0,0,width,edge)]);
        input.SetRegionRects(NonClientRegionKind.BottomBorder,[new RectInt32(0,Math.Max(0,height-edge),width,edge)]);
        input.SetRegionRects(NonClientRegionKind.LeftBorder,[new RectInt32(0,0,edge,height)]);
        input.SetRegionRects(NonClientRegionKind.RightBorder,[new RectInt32(Math.Max(0,width-edge),0,edge,height)]);
    }
    private void Configure(){
        var margins=new Margins();DwmExtendFrameIntoClientArea(hwnd,ref margins);
        var region=CreateRectRgn(-2,-2,-1,-1);
        try{var blur=new Blur {Flags=3,Enabled=1,Region=region};DwmEnableBlurBehindWindow(hwnd,ref blur);}
        finally{DeleteObject(region);}
    }
    private nint Message(nint h,uint m,nint w,nint l,nuint id,nuint data){
        if(m==0x0083)return 0; // no nonclient pixels above the app's original border
        if(resizable&&m==0x0084&&GetWindowRect(h,out var bounds)){
            // Screen coordinates are signed, including displays left of the primary.
            var x=(short)((long)l&0xffff);var y=(short)(((long)l>>16)&0xffff);
            var edge=(int)Math.Ceiling(6*GetDpiForWindow(h)/96d);
            if(x>=bounds.L&&x<bounds.R&&y>=bounds.T&&y<bounds.B){
                var left=x<bounds.L+edge;var right=x>=bounds.R-edge;
                var top=y<bounds.T+edge;var bottom=y>=bounds.B-edge;
                if(top&&left)return 13;if(top&&right)return 14;
                if(bottom&&left)return 16;if(bottom&&right)return 17;
                if(left)return 10;if(right)return 11;if(top)return 12;if(bottom)return 15;
            }
        }
        if(resizable&&m==0x0024){
            var scale=GetDpiForWindow(h)/96d;
            // MINMAXINFO.ptMinTrackSize; compact mode uses its own fixed icon size.
            Marshal.WriteInt32(l,24,(int)Math.Ceiling(360*scale));Marshal.WriteInt32(l,28,(int)Math.Ceiling(240*scale));return 0;
        }
        if(m==0x0014&&GetClientRect(h,out var rect)){FillRect(w,ref rect,GetStockObject(4));return 1;}
        if(m==0x031E)Configure();
        return DefSubclassProc(h,m,w,l);
    }
    public void Dispose()=>RemoveWindowSubclass(hwnd,callback,1);
}
