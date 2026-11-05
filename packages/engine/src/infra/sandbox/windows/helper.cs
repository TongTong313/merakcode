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
using System.Security.Principal;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;

static class Helper
{
    [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
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
        SetErrorMode(0x8003);
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 2 && args[0] == "protect") return Protect(args[1]);
            if (args.Length == 3 && (args[0] == "grant" || args[0] == "revoke")) return Access(args[0], args[1], args[2]);
            if (args.Length == 2 && args[0] == "run") return Run(args[1]);
            if (args.Length == 1 && args[0] == "worker") return Worker();
            Console.Error.WriteLine("usage: helper protect <out> | helper run <request>");
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[MRK-5003] sandbox helper: " + e.GetType().Name + ": " + e.Message);
            return 125;
        }
    }

    static int Access(string action, string sidText, string target)
    {
        SecurityIdentifier sid = new SecurityIdentifier(sidText);
        string canonical = Path.GetFullPath(target).ToUpperInvariant();
        byte[] hash = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(canonical));
        string name = "Local\\MerakCodeAcl-" + BitConverter.ToString(hash).Replace("-", "");
        using (Mutex gate = new Mutex(false, name))
        {
            try { if (!gate.WaitOne(5000)) throw new TimeoutException("The sandbox ACL is busy"); }
            catch (AbandonedMutexException) { }
            try
            {
                bool directory = Directory.Exists(target);
                FileSystemSecurity security = directory
                    ? (FileSystemSecurity)new DirectoryInfo(target).GetAccessControl(AccessControlSections.Access)
                    : new FileInfo(target).GetAccessControl(AccessControlSections.Access);
                if (action == "revoke") security.PurgeAccessRules(sid);
                else
                {
                    foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                        if (rule.IdentityReference == sid && rule.AccessControlType == AccessControlType.Allow &&
                            (rule.FileSystemRights & FileSystemRights.Modify) == FileSystemRights.Modify &&
                            (!directory || rule.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)))
                            return 0;
                    security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.Modify,
                        directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                        PropagationFlags.None, AccessControlType.Allow));
                }
                if (directory) new DirectoryInfo(target).SetAccessControl((DirectorySecurity)security);
                else new FileInfo(target).SetAccessControl((FileSecurity)security);
                return 0;
            }
            finally { gate.ReleaseMutex(); }
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

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int Size; public string Reserved; public string Desktop; public string Title;
        public int X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct SidAttributes { public IntPtr Sid; public uint Attributes; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithLogonW(string user, string domain, IntPtr password, int logon,
        string application, StringBuilder command, int flags, IntPtr environment, string cwd,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command,
        IntPtr processSecurity, IntPtr threadSecurity, bool inherit, int flags, IntPtr environment,
        string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr token, uint flags, int disabled, IntPtr disable,
        int deleted, IntPtr delete, int restricted, [In] SidAttributes[] sids, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, int revision,
        out IntPtr descriptor, out int size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, IntPtr descriptor);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [StructLayout(LayoutKind.Sequential)]
    struct TokenGroups { public uint Count; public SidAttributes First; }
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr data, int size);
    static void DefaultDacl(IntPtr token, string text)
    {
        IntPtr descriptor; int size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, 1, out descriptor, out size))
            throw new Win32Exception("ConvertStringSecurityDescriptor");
        IntPtr data = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            bool present, defaulted; IntPtr acl;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out acl, out defaulted) || !present)
                throw new Win32Exception("GetSecurityDescriptorDacl");
            Marshal.WriteIntPtr(data, acl);
            if (!SetTokenInformation(token, 6, data, IntPtr.Size)) throw new Win32Exception("SetTokenInformation");
        }
        finally { Marshal.FreeHGlobal(data); LocalFree(descriptor); }
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out int code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetUserObjectSecurity(IntPtr handle, ref uint information, IntPtr descriptor);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int kind, StringBuilder data, int size, out int length);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);

    const int Suspended = 4, UnicodeEnvironment = 0x400, NoWindow = 0x08000000;
    static StartupInfo Startup(IntPtr input, IntPtr output, IntPtr error)
    {
        StartupInfo info = new StartupInfo();
        info.Size = Marshal.SizeOf(typeof(StartupInfo));
        info.Flags = 0x101;
        info.Input = input; info.Output = output; info.Error = error;
        return info;
    }
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    static IntPtr EnvironmentBlock(string[] fields)
    {
        string[] sorted = (string[])fields.Clone();
        Array.Sort(sorted, StringComparer.OrdinalIgnoreCase);
        return Marshal.StringToHGlobalUni(String.Join("\0", sorted) + "\0\0");
    }
    static void ProtectProcess(IntPtr handle, string descriptor, bool owner)
    {
        IntPtr security;
        int size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, 1, out security, out size))
            throw new Win32Exception("ConvertStringSecurityDescriptor");
        try
        {
            if (!SetKernelObjectSecurity(handle, owner ? 5u : 4u, security))
                throw new Win32Exception("SetKernelObjectSecurity");
        }
        finally { LocalFree(security); }
    }
    static int ExitCode(IntPtr process)
    {
        WaitForSingleObject(process, 0xffffffff);
        int code;
        if (!GetExitCodeProcess(process, out code)) throw new Win32Exception("GetExitCodeProcess");
        return code;
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
        IntPtr passwordPointer = Marshal.SecureStringToGlobalAllocUnicode(password);
        IntPtr job = Job();
        ProcessInfo child = new ProcessInfo();
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
        IntPtr errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        try
        {
            SecurityAttributes attributes = new SecurityAttributes();
            attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Inherit = 1;
            if (!CreatePipe(out inputRead, out inputWrite, ref attributes, 0) ||
                !CreatePipe(out outputRead, out outputWrite, ref attributes, 0) ||
                !CreatePipe(out errorRead, out errorWrite, ref attributes, 0)) throw new Win32Exception("CreatePipe");
            foreach (IntPtr handle in new IntPtr[] { inputWrite, outputRead, errorRead })
                if (!SetHandleInformation(handle, 1, 0)) throw new Win32Exception("SetHandleInformation");
            StartupInfo startup = Startup(inputRead, outputWrite, errorWrite);
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            string host = WindowsIdentity.GetCurrent().User.Value;
            // The bootstrap must not load code or DLLs from the task's environment or working directory.
            string system = Environment.GetEnvironmentVariable("SystemRoot");
            environment = EnvironmentBlock(new string[] { "SystemRoot=" + system, "WINDIR=" + system });
            if (!CreateProcessWithLogonW(fields[0], ".", passwordPointer, 1, executable,
                new StringBuilder(Quote(executable) + " worker"), Suspended | UnicodeEnvironment | NoWindow,
                environment, system, ref startup, out child)) throw new Win32Exception("CreateProcessWithLogonW");
            // Protect the unrestricted bootstrap before it can execute or be opened by another sandbox process.
            string security = "O:" + host + "D:P(A;;GA;;;" + host + ")(A;;GA;;;SY)";
            ProtectProcess(child.Process, security, true);
            ProtectProcess(child.Thread, security, true);
            if (!AssignProcessToJobObject(job, child.Process)) throw new Win32Exception("AssignProcessToJobObject");
            CloseHandle(inputRead); inputRead = IntPtr.Zero;
            CloseHandle(outputWrite); outputWrite = IntPtr.Zero;
            CloseHandle(errorWrite); errorWrite = IntPtr.Zero;
            if (ResumeThread(child.Thread) == 0xffffffff) throw new Win32Exception("ResumeThread");
            using (FileStream input = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write))
            {
                inputWrite = IntPtr.Zero;
                byte[] payload = Encoding.UTF8.GetBytes(host + "\0" + request + ".started\0" + String.Join("\0", fields));
                input.Write(payload, 0, payload.Length);
            }
            using (FileStream output = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read))
            using (FileStream error = new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read))
            {
                outputRead = errorRead = IntPtr.Zero;
                Thread stdout = new Thread(() => Copy(output, Console.OpenStandardOutput()));
                Thread stderr = new Thread(() => Copy(error, Console.OpenStandardError()));
                stdout.Start(); stderr.Start();
                int code = ExitCode(child.Process);
                // Descendants cannot keep inherited output pipes or the job alive after the command ends.
                if (!TerminateJobObject(job, 1)) throw new Win32Exception("TerminateJobObject");
                stdout.Join(); stderr.Join();
                return code;
            }
        }
        finally
        {
            if (child.Process != IntPtr.Zero) TerminateProcess(child.Process, 125);
            CloseHandle(job);
            foreach (IntPtr handle in new IntPtr[] { child.Process, child.Thread, inputRead, inputWrite,
                outputRead, outputWrite, errorRead, errorWrite })
                if (handle != IntPtr.Zero) CloseHandle(handle);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Marshal.ZeroFreeGlobalAllocUnicode(passwordPointer);
            password.Dispose();
        }
    }

    static int Worker()
    {
        string[] fields = Console.In.ReadToEnd().Split('\0');
        string host = fields[0], marker = fields[1];
        string cwd = fields[4], file = fields[5], args = fields[6];
        string[] writeSids = null;
        bool probe = false;
        System.Collections.Generic.List<string> environmentFields = new System.Collections.Generic.List<string>();
        for (int i = 7; i < fields.Length; i++)
        {
            if (fields[i].StartsWith("MERAKCODE_SANDBOX_WRITE_SIDS=", StringComparison.OrdinalIgnoreCase))
                writeSids = fields[i].Substring("MERAKCODE_SANDBOX_WRITE_SIDS=".Length).Split(',');
            else if (fields[i] == "MERAKCODE_SANDBOX_PROBE=1") probe = true;
            else environmentFields.Add(fields[i]);
        }
        if (writeSids == null || writeSids.Length == 0) throw new InvalidOperationException("Missing command restriction");
        string sidText = writeSids[0];
        System.Collections.Generic.List<IntPtr> sidPointers = new System.Collections.Generic.List<IntPtr>();
        IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero, environment = IntPtr.Zero;
        IntPtr originalStation = GetProcessWindowStation(), station = IntPtr.Zero, desktop = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), 0xf01ff, out token)) throw new Win32Exception("OpenProcessToken");
            int needed;
            GetTokenInformation(token, 28, IntPtr.Zero, 0, out needed);
            IntPtr groups = Marshal.AllocHGlobal(needed);
            string logon;
            try
            {
                if (!GetTokenInformation(token, 28, groups, needed, out needed)) throw new Win32Exception("GetTokenInformation");
                if (Marshal.ReadInt32(groups) != 1) throw new InvalidOperationException("Missing sandbox logon identity");
                IntPtr pointer = Marshal.ReadIntPtr(groups, (int)Marshal.OffsetOf(typeof(TokenGroups), "First"));
                logon = new SecurityIdentifier(pointer).Value;
            }
            finally { Marshal.FreeHGlobal(groups); }
            // Windows runtime objects need Everyone; report the resulting ambient-write limit to the caller.
            System.Collections.Generic.List<SidAttributes> restrictions = new System.Collections.Generic.List<SidAttributes>();
            foreach (string text in writeSids)
            {
                SecurityIdentifier sid = new SecurityIdentifier(text);
                byte[] binary = new byte[sid.BinaryLength]; sid.GetBinaryForm(binary, 0);
                IntPtr pointer = Marshal.AllocHGlobal(binary.Length);
                sidPointers.Add(pointer); Marshal.Copy(binary, 0, pointer, binary.Length);
                restrictions.Add(new SidAttributes { Sid = pointer });
            }
            SecurityIdentifier everyone = new SecurityIdentifier("S-1-1-0");
            byte[] everyoneBinary = new byte[everyone.BinaryLength]; everyone.GetBinaryForm(everyoneBinary, 0);
            IntPtr everyonePointer = Marshal.AllocHGlobal(everyoneBinary.Length);
            sidPointers.Add(everyonePointer); Marshal.Copy(everyoneBinary, 0, everyonePointer, everyoneBinary.Length);
            restrictions.Add(new SidAttributes { Sid = everyonePointer });
            if (!CreateRestrictedToken(token, 13, 0, IntPtr.Zero, 0, IntPtr.Zero,
                restrictions.Count, restrictions.ToArray(), out restricted))
                throw new Win32Exception("CreateRestrictedToken");
            IntPtr descriptor;
            int descriptorSize;
            string desktopSecurity = "D:P(A;;GA;;;" + logon + ")(A;;GA;;;" + sidText + ")(A;;GA;;;" + host + ")";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(desktopSecurity, 1, out descriptor, out descriptorSize))
                throw new Win32Exception("ConvertStringSecurityDescriptor");
            string stationName;
            try
            {
                SecurityAttributes attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Descriptor = descriptor;
                // An unnamed station is scoped to this fresh logon and needs no administrator privilege.
                station = CreateWindowStationW(null, 0, 0xf037f, ref attributes);
                if (station == IntPtr.Zero) throw new Win32Exception("CreateWindowStation");
                uint information = 4;
                if (!SetUserObjectSecurity(station, ref information, descriptor)) throw new Win32Exception("SetUserObjectSecurity");
                if (!SetProcessWindowStation(station)) throw new Win32Exception("SetProcessWindowStation");
                StringBuilder name = new StringBuilder(256);
                int length;
                if (!GetUserObjectInformationW(station, 2, name, name.Capacity * 2, out length))
                    throw new Win32Exception("GetUserObjectInformation");
                stationName = name.ToString();
                desktop = CreateDesktopW("default", IntPtr.Zero, IntPtr.Zero, 0, 0xf01ff, ref attributes);
                if (desktop == IntPtr.Zero) throw new Win32Exception("CreateDesktop");
            }
            finally { LocalFree(descriptor); }
            string tokenSecurity = "D:P(A;;RC;;;OW)(A;;GA;;;SY)(A;;GA;;;" + host + ")(A;;GA;;;" + logon + ")(A;;GA;;;" + sidText + ")";
            DefaultDacl(restricted, tokenSecurity);
            foreach (int kind in new int[] { -10, -11, -12 })
                if (!SetHandleInformation(GetStdHandle(kind), 1, 1)) throw new Win32Exception("SetHandleInformation");
            StartupInfo startup = Startup(GetStdHandle(-10), GetStdHandle(-11), GetStdHandle(-12));
            startup.Desktop = stationName + "\\default";
            environment = EnvironmentBlock(environmentFields.ToArray());
            if (!CreateProcessAsUserW(restricted, file, new StringBuilder(Quote(file) + " " + args), IntPtr.Zero,
                IntPtr.Zero, true, Suspended | UnicodeEnvironment | NoWindow, environment, cwd, ref startup, out child))
                throw new Win32Exception("CreateProcessAsUserW");
            // Owner rights must not let another login of the shared account rewrite this process's DACL.
            ProtectProcess(restricted, tokenSecurity, false);
            ProtectProcess(child.Process, tokenSecurity, false);
            ProtectProcess(child.Thread, tokenSecurity, false);
            if (probe)
            {
                IntPtr actual;
                if (!OpenProcessToken(child.Process, 8, out actual)) throw new Win32Exception("OpenProcessToken");
                try { Console.WriteLine(new WindowsIdentity(actual).User.Value); }
                finally { CloseHandle(actual); }
            }
            File.WriteAllText(marker, "started");
            if (ResumeThread(child.Thread) == 0xffffffff) throw new Win32Exception("ResumeThread");
            return ExitCode(child.Process);
        }
        finally
        {
            foreach (IntPtr handle in new IntPtr[] { child.Process, child.Thread, token, restricted })
                if (handle != IntPtr.Zero) CloseHandle(handle);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            SetProcessWindowStation(originalStation);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
            if (station != IntPtr.Zero) CloseWindowStation(station);
            foreach (IntPtr pointer in sidPointers) Marshal.FreeHGlobal(pointer);
        }
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
