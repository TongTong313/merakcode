package worker

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type ProductInfo struct {
	Kind      Kind   `json:"kind"`
	Name      string `json:"name"`
	Binary    string `json:"binary,omitempty"`
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`
	Caps      Caps   `json:"caps"`
}

func Catalog(ctx context.Context) []ProductInfo {
	items := []ProductInfo{
		{Kind: KindBuiltin, Name: "MerakCode", Available: true, Caps: Caps{Steer: true, Permission: true}},
		{Kind: KindClaudeCode, Name: "Claude Code", Caps: Caps{Steer: true, Permission: true}},
		{Kind: KindCodex, Name: "Codex", Caps: Caps{Steer: true, Permission: true}},
		{Kind: KindOpenCode, Name: "OpenCode", Caps: Caps{Permission: true}},
		{Kind: KindPi, Name: "Pi", Caps: Caps{Steer: true}},
	}
	var probes sync.WaitGroup
	for index, name := range []string{"claude", "codex", "opencode", "pi"} {
		binary, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		item := &items[index+1]
		item.Binary, item.Available = binary, true
		probes.Go(func() {
			ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			command := process.Command(ctx, "", binary, "--version")
			var output versionOutput
			command.Stdout = &output
			if command.Run() == nil {
				line, _, _ := strings.Cut(output.String(), "\n")
				item.Version = strings.TrimSpace(line)
			}
		})
	}
	probes.Wait()
	return items
}

type versionOutput struct{ bytes.Buffer }

func (b *versionOutput) Write(body []byte) (int, error) {
	count := min(len(body), 1024-b.Len())
	if count > 0 {
		_, _ = b.Buffer.Write(body[:count])
	}
	return len(body), nil
}
