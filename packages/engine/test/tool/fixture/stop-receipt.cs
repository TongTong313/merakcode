// Makes only this fixture's process query temporarily unavailable. The job must retain its confirmation handle.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;

class StopReceipt
{
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, int version, out IntPtr pointer, out int length);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, IntPtr descriptor);

    static void Security(string text)
    {
        IntPtr descriptor; int length;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, 1, out descriptor, out length))
            throw new Exception("Fixture descriptor failed");
        try
        {
            if (!SetKernelObjectSecurity(GetCurrentProcess(), 4, descriptor))
                throw new Exception("Fixture process security failed");
        }
        finally { LocalFree(descriptor); }
    }

    static void Main(string[] args)
    {
        Process.Start(new ProcessStartInfo(args[0], "-e \"const fs=require('fs');fs.writeFileSync('stop-child.pid',String(process.pid));setInterval(()=>fs.appendFileSync('stop-heartbeat','x'),10)\"")
        { UseShellExecute = false, CreateNoWindow = true });
        string owner = WindowsIdentity.GetCurrent().User.Value;
        Security("D:P(D;;0x101000;;;" + owner + ")(A;;GA;;;" + owner + ")");
        File.WriteAllText("ready", "ready");
        while (!File.Exists("release-stop")) Thread.Sleep(10);
        Security("D:P(A;;GA;;;" + owner + ")");
    }
}
