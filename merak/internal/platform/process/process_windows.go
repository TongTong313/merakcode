package process

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

var npmEntry = regexp.MustCompile(`"%dp0%\\([^"\r\n]+\.(?:m?js|cjs))"\s+%\*`)

// npm's command shim expands shell metacharacters. Invoke its Node entry directly.
func resolveLauncher(executable string, args []string) (string, []string) {
	path, err := exec.LookPath(executable)
	if err != nil || !strings.EqualFold(filepath.Ext(path), ".cmd") {
		return executable, args
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() > 64<<10 {
		return executable, args
	}
	body, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(body), `SET "_prog=node"`) {
		return executable, args
	}
	match := npmEntry.FindSubmatch(body)
	if len(match) != 2 {
		return executable, args
	}
	node := filepath.Join(filepath.Dir(path), "node.exe")
	if _, err := os.Stat(node); err != nil {
		node = "node"
	}
	entry := filepath.Join(filepath.Dir(path), string(match[1]))
	return node, append([]string{entry}, args...)
}

func bashPath() (string, error) {
	var candidates []string
	if git, err := exec.LookPath("git"); err == nil {
		dir := filepath.Dir(git)
		candidates = append(candidates, filepath.Join(dir, "bash.exe"), filepath.Join(dir, "..", "bin", "bash.exe"))
	}
	candidates = append(candidates, filepath.Join(os.Getenv("ProgramFiles"), "Git", "bin", "bash.exe"))
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, nil
		}
	}
	return "", errors.New("Git Bash is required to run shell commands on Windows")
}

func configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000200}
	cmd.Cancel = func() error {
		kill := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"), "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
		kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := kill.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
