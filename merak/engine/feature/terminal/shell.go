package terminal

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

func shell(command string, args []string) (string, []string, []string, error) {
	if command == "" {
		switch runtime.GOOS {
		case "windows":
			candidates := []string{os.Getenv("MERAKCODE_GIT_BASH_PATH")}
			if git, err := exec.LookPath("git.exe"); err == nil {
				dir := filepath.Dir(git)
				candidates = append(candidates, filepath.Join(dir, "bash.exe"), filepath.Join(dir, "..", "bin", "bash.exe"), filepath.Join(dir, "..", "..", "bin", "bash.exe"))
			}
			for _, candidate := range candidates {
				if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
					command = candidate
					break
				}
			}
			if command == "" {
				command = os.Getenv("COMSPEC")
			}
		case "darwin":
			command = "/bin/zsh"
		default:
			command = os.Getenv("SHELL")
			if command == "" {
				var err error
				command, err = exec.LookPath("bash")
				if err != nil {
					return "", nil, nil, err
				}
			}
		}
		switch strings.TrimSuffix(strings.ToLower(filepath.Base(command)), ".exe") {
		case "sh", "bash", "zsh", "ksh", "dash":
			args = append([]string{"-l"}, args...)
		}
	}
	values := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		name := strings.ToUpper(key)
		if strings.HasPrefix(name, "MERAKCODE_") && (strings.Contains(name, "TOKEN") || strings.Contains(name, "SECRET") || strings.Contains(name, "PASSWORD") || strings.Contains(name, "API_KEY")) {
			continue
		}
		if runtime.GOOS == "windows" {
			key = name
		}
		values[key] = value
	}
	values["TERM"] = "xterm-256color"
	values["MERAKCODE_TERMINAL"] = "1"
	if runtime.GOOS == "windows" {
		values["LANG"] = "en_US.UTF-8"
		values["LC_ALL"] = "en_US.UTF-8"
	}
	env := make([]string, 0, len(values))
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	sort.Strings(env)
	return command, args, env, nil
}
