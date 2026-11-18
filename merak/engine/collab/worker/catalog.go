package worker

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
)

type ProductInfo struct {
	Kind      definition.Kind `json:"kind"`
	Name      string          `json:"name"`
	Binary    string          `json:"binary,omitempty"`
	Available bool            `json:"available"`
	Version   string          `json:"version,omitempty"`
	Caps      definition.Caps `json:"caps"`
}

func Catalog(ctx context.Context) []ProductInfo {
	items := []ProductInfo{
		{Kind: definition.KindBuiltin, Name: "MerakCode", Available: true, Caps: definition.Caps{Steer: true, Permission: true}},
		{Kind: definition.KindClaudeCode, Name: "Claude Code", Caps: definition.Caps{Steer: true, Permission: true, MCP: true}},
		{Kind: definition.KindCodex, Name: "Codex", Caps: definition.Caps{Steer: true, Permission: true, MCP: true}},
		{Kind: definition.KindOpenCode, Name: "OpenCode", Caps: definition.Caps{Permission: true, MCP: true}},
		{Kind: definition.KindPi, Name: "Pi", Caps: definition.Caps{Steer: true, MCP: true}},
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
			ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
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
