// MerakCode sandbox helper: runs a command as the sandbox account inside a kill-on-close job object, and copies
// its output byte for byte. Compiled on the user's machine with the csc.exe that ships with Windows, so C# 5 only.
//
//   helper protect <out>     reads a password from stdin, saves it encrypted for the current user (DPAPI)
//   helper run <request>     request file: user NUL passwordFile NUL cwd NUL file NUL arguments NUL KEY=VALUE ...
//                            the request file is deleted as soon as it is read
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

static class Helper
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "protect") return Protect(args[1]);
            if (args.Length == 2 && args[0] == "run") return Run(args[1]);
            Console.Error.WriteLine("usage: helper protect <out> | helper run <request>");
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[MRK-5003] sandbox helper: " + e.GetType().Name + ": " + e.Message);
            return 125;
        }
    }

    static int Protect(string output)
    {
        string password = Console.In.ReadLine();
        byte[] data = ProtectedData.Protect(Encoding.UTF8.GetBytes(password), null, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(output, data);
        return 0;
    }

    static IntPtr Job()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception("CreateJobObject");
        ExtendedLimit limit = new ExtendedLimit();
        limit.Basic.LimitFlags = KillOnJobClose;
        int size = Marshal.SizeOf(typeof(ExtendedLimit));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limit, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
                throw new Win32Exception("SetInformationJobObject");
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return job;
    }

    static int Run(string request)
    {
        string[] fields = File.ReadAllText(request, Encoding.UTF8).Split('\0');
        File.Delete(request);
        byte[] secret = ProtectedData.Unprotect(File.ReadAllBytes(fields[1]), null, DataProtectionScope.CurrentUser);
        SecureString password = new SecureString();
        foreach (char c in Encoding.UTF8.GetString(secret)) password.AppendChar(c);
        Array.Clear(secret, 0, secret.Length);
        password.MakeReadOnly();

        IntPtr job = Job();
        ProcessStartInfo info = new ProcessStartInfo(fields[3], fields[4]);
        info.UserName = fields[0];
        info.Password = password;
        info.Domain = ".";
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.LoadUserProfile = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.WorkingDirectory = fields[2];
        info.EnvironmentVariables.Clear();
        for (int i = 5; i < fields.Length; i++)
        {
            int equals = fields[i].IndexOf('=', 1);
            if (equals > 0) info.EnvironmentVariables[fields[i].Substring(0, equals)] = fields[i].Substring(equals + 1);
        }

        Process child = Process.Start(info);
        if (!AssignProcessToJobObject(job, child.Handle)) throw new Win32Exception("AssignProcessToJobObject");
        Stream stdout = Console.OpenStandardOutput();
        Stream stderr = Console.OpenStandardError();
        Thread outThread = new Thread(() => Copy(child.StandardOutput.BaseStream, stdout));
        Thread errThread = new Thread(() => Copy(child.StandardError.BaseStream, stderr));
        outThread.Start();
        errThread.Start();
        child.WaitForExit();
        outThread.Join();
        errThread.Join();
        return child.ExitCode;
    }

    static void Copy(Stream from, Stream to)
    {
        byte[] buffer = new byte[65536];
        int read;
        while ((read = from.Read(buffer, 0, buffer.Length)) > 0)
        {
            to.Write(buffer, 0, read);
            to.Flush();
        }
    }

    class Win32Exception : Exception
    {
        public Win32Exception(string call) : base(call + " failed with error " + Marshal.GetLastWin32Error()) { }
    }
}
