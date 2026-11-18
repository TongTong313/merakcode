if (-not ('MerakSandboxAccess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class MerakSandboxAccess {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint SetNamedSecurityInfo(string path, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    public static void Remove(string path, byte[] descriptor, string identity) {
        var security = new RawSecurityDescriptor(descriptor, 0);
        var sid = new SecurityIdentifier(identity);
        var acl = security.DiscretionaryAcl;
        if (acl == null) throw new InvalidOperationException("The directory has no discretionary access list.");
        bool changed = false;
        for (int i = acl.Count - 1; i >= 0; i--) {
            var ace = acl[i] as KnownAce;
            if (ace != null && ace.SecurityIdentifier.Equals(sid)) {
                acl.RemoveAce(i);
                changed = true;
            }
        }
        if (!changed) return;
        var bytes = new byte[acl.BinaryLength];
        acl.GetBinaryForm(bytes, 0);
        IntPtr native = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, native, bytes.Length);
            uint error = SetNamedSecurityInfo(path, 1, 4, IntPtr.Zero, IntPtr.Zero, native, IntPtr.Zero);
            if (error != 0) throw new System.ComponentModel.Win32Exception((int)error);
        } finally { Marshal.FreeHGlobal(native); }
    }
}
'@
}
