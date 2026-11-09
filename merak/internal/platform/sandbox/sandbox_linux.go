package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

const helperArgument = "--merak-sandbox-exec"
const networkProbeArgument = "--merak-sandbox-probe-network"
const landlockNetworkRule = 2

func (l *Launcher) platformStatus(ctx context.Context, _ Profile) Status {
	status := Status{Backend: "landlock", Network: "none"}
	if ctx.Err() != nil {
		status.Reason = "MRK-5004"
		return status
	}
	version, err := landlockVersion()
	if err != nil {
		status.Reason = "MRK-5004"
		return status
	}
	status.Available = true
	if networkNamespaces(ctx) {
		status.Network = "namespace"
		return status
	}
	if version >= 4 {
		status.Network = "ports"
		status.Limits = []string{"port-only", "udp-open"}
	} else {
		status.Reason = "MRK-5008"
	}
	return status
}

func init() {
	if len(os.Args) == 2 && os.Args[1] == networkProbeArgument {
		os.Exit(0)
	}
	if len(os.Args) >= 2 && os.Args[1] == proxyBrokerArgument {
		code, err := runLinuxBroker(os.Args[2:])
		finishLinuxHelper(code, err)
	}
	if len(os.Args) >= 2 && os.Args[1] == proxyChildArgument {
		code, err := runLinuxProxyChild(os.Args[2:])
		finishLinuxHelper(code, err)
	}
	if len(os.Args) < 2 || os.Args[1] != helperArgument {
		return
	}
	if err := runLinuxChild(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "MRK-5001")
		os.Exit(125)
	}
}

func (l *Launcher) platformCommand(ctx context.Context, p Profile, name string, args ...string) (*exec.Cmd, error) {
	if _, err := landlockVersion(); err != nil {
		return nil, err
	}
	target, err := exec.LookPath(name)
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	role := helperArgument
	if p.Network.Mode == "allowlist" || p.Network.Mode == "on" || len(p.Network.LocalPorts) > 0 {
		role = proxyBrokerArgument
	}
	if role == proxyBrokerArgument && l.ApproveNetwork != nil {
		return l.linuxProxyCommand(ctx, p, executable, string(body), target, args...)
	}
	command := process.Command(ctx, "", executable, append([]string{role, string(body), target}, args...)...)
	command.Env = p.Environment(command.Environ())
	if role == helperArgument && networkNamespaces(ctx) {
		configureNetworkNamespace(command)
	}
	return command, nil
}

func networkNamespaces(ctx context.Context) bool {
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	probe := process.Command(ctx, "", executable, networkProbeArgument)
	configureNetworkNamespace(probe)
	return probe.Run() == nil
}

func configureNetworkNamespace(command *exec.Cmd) {
	command.SysProcAttr.Cloneflags = syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET
	command.SysProcAttr.UidMappings = []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}}
	command.SysProcAttr.GidMappings = []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}}
	command.SysProcAttr.GidMappingsEnableSetgroups = false
}

func landlockVersion() (int, error) {
	version, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, unix.LANDLOCK_CREATE_RULESET_VERSION)
	if errno != 0 {
		return 0, errno
	}
	return int(version), nil
}

func runLinuxChild(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("missing sandbox child arguments")
	}
	var p Profile
	if err := json.Unmarshal([]byte(args[0]), &p); err != nil {
		return err
	}
	if err := p.Validate(); err != nil {
		return err
	}
	// Landlock restricts the calling thread; exec replaces every other Go thread.
	runtime.LockOSThread()
	if err := restrictLinuxFiles(p, 0); err != nil {
		return err
	}
	return unix.Exec(args[1], args[1:], p.Environment(os.Environ()))
}

func restrictLinuxFiles(p Profile, proxyPort int) error {
	version, err := landlockVersion()
	if err != nil {
		return err
	}
	nodes := []landlockNode{{Path: "/dev/null"}}
	if len(p.ReadDeny) > 0 {
		if err := collectLinuxReads("/", p.ReadDeny, &nodes); err != nil {
			return err
		}
	}
	for _, path := range p.WriteAllow {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		nodes = append(nodes, landlockNode{path, info.IsDir()})
	}
	plan := planLandlock(p, version, proxyPort, nodes)
	attr := struct {
		AccessFS  uint64
		AccessNet uint64
	}{AccessFS: plan.HandledFS, AccessNet: plan.HandledNet}
	size := uintptr(8)
	if plan.HandledNet != 0 {
		size = unsafe.Sizeof(attr)
	}
	ruleset, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, uintptr(unsafe.Pointer(&attr)), size, 0)
	if errno != 0 {
		return errno
	}
	defer unix.Close(int(ruleset))
	for _, port := range plan.ConnectPorts {
		network := struct {
			Access uint64
			Port   uint64
		}{unix.LANDLOCK_ACCESS_NET_CONNECT_TCP, uint64(port)}
		_, _, errno := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE, ruleset, landlockNetworkRule, uintptr(unsafe.Pointer(&network)), 0, 0, 0)
		if errno != 0 {
			return errno
		}
	}
	for _, rule := range plan.Paths {
		if err := addLinuxPath(int(ruleset), rule.Path, rule.Access); err != nil {
			return fmt.Errorf("landlock path %s: %w", rule.Path, err)
		}
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	_, _, errno = unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func addLinuxPath(ruleset int, path string, access uint64) error {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil {
		return err
	}
	if info.Mode&unix.S_IFMT != unix.S_IFDIR {
		access &= unix.LANDLOCK_ACCESS_FS_WRITE_FILE | unix.LANDLOCK_ACCESS_FS_TRUNCATE | unix.LANDLOCK_ACCESS_FS_READ_FILE | unix.LANDLOCK_ACCESS_FS_EXECUTE
	}
	attr := unix.LandlockPathBeneathAttr{Allowed_access: access, Parent_fd: int32(fd)}
	_, _, errno := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE, uintptr(ruleset), unix.LANDLOCK_RULE_PATH_BENEATH, uintptr(unsafe.Pointer(&attr)), 0, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func collectLinuxReads(path string, denied []string, nodes *[]landlockNode) error {
	switch landlockReadSelection(path, denied) {
	case "deny":
		return nil
	case "allow":
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		*nodes = append(*nodes, landlockNode{path, info.IsDir()})
		return nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		// Grant the real hierarchy, never an alias that could lead into ReadDeny.
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if err := collectLinuxReads(filepath.Join(path, entry.Name()), denied, nodes); err != nil {
			return err
		}
	}
	return nil
}
