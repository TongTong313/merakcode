package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/testmcp"
)

func main() {
	args := os.Args[1:]
	fixture := ""
	tools := ""
	extension := ""
	for i, arg := range args {
		if arg == "--extension" && i+1 < len(args) {
			extension = args[i+1]
		}
		if arg == "--tools" && i+1 < len(args) {
			tools = args[i+1]
		}
		if arg == "--fixture" && i+1 < len(args) {
			fixture = args[i+1]
		}
	}
	if os.Getenv("MERAKCODE_FIXTURE_READONLY") == "1" && tools != "read,grep,find,ls" {
		os.Exit(7)
	}
	scan := bufio.NewScanner(os.Stdin)
	if !scan.Scan() {
		os.Exit(2)
	}
	var prompt struct{ ID, Type, Message string }
	if json.Unmarshal(scan.Bytes(), &prompt) != nil || prompt.Type != "prompt" || prompt.Message == "" {
		os.Exit(3)
	}
	ack := func(id string) {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"id": id, "type": "response", "success": true, "data": map[string]string{"disposition": "started"}})
	}
	if mode := os.Getenv("MERAKCODE_FIXTURE_MODE"); mode == "budget" || mode == "budget-rework" {
		ack(prompt.ID)
		_, _ = io.WriteString(os.Stdout, `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Continuing"}],"usage":{"input":20,"output":5,"cost":{"total":0.02}}}}`+"\n")
		if mode == "budget-rework" && !strings.Contains(prompt.Message, "Rework") {
			_, _ = io.WriteString(os.Stdout, "{\"type\":\"agent_settled\",\"aborted\":false}\n")
		}
		for scan.Scan() {
		}
		return
	}
	if os.Getenv("MERAKCODE_FIXTURE_MODE") == "leader-boundary" {
		ack(prompt.ID)
		if !scan.Scan() || json.Unmarshal(scan.Bytes(), &prompt) != nil {
			os.Exit(30)
		}
		_, _ = io.WriteString(os.Stdout, "{\"type\":\"agent_settled\"}\n")
		ack(prompt.ID)
		_, _ = io.WriteString(os.Stdout, "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Second\"}],\"stopReason\":\"stop\"}}\n{\"type\":\"agent_settled\"}\n")
		for scan.Scan() {
		}
		return
	}
	if os.Getenv("MERAKCODE_FIXTURE_MCP") == "1" {
		if extension == "" {
			os.Exit(20)
		}
		body, err := exec.Command("node", "--input-type=module", "-e", `import {pathToFileURL} from "node:url"; const mod=await import(pathToFileURL(process.argv[1]).href); await mod.default({registerMcpServer:(name,config)=>process.stdout.write(JSON.stringify({name,config}))});`, extension).Output()
		if err != nil {
			os.Exit(21)
		}
		var configured struct {
			Name   string
			Config worker.MCPConfig
		}
		if json.Unmarshal(body, &configured) != nil || configured.Name != "merak" {
			os.Exit(22)
		}
		if os.Getenv("MERAKCODE_FIXTURE_LEADER") == "1" {
			leader := &testmcp.Leader{Server: configured.Config}
			for {
				ack(prompt.ID)
				if leader.Handle(prompt.Message) != nil {
					os.Exit(24)
				}
				_, _ = io.WriteString(os.Stdout, "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Turn complete\"}]}}\n")
				_, _ = io.WriteString(os.Stdout, "{\"type\":\"agent_settled\",\"aborted\":false}\n")
				if !scan.Scan() {
					return
				}
				if json.Unmarshal(scan.Bytes(), &prompt) != nil {
					os.Exit(25)
				}
			}
		}
		if err := testmcp.Report(configured.Config); err != nil {
			os.Exit(23)
		}
		_, _ = io.WriteString(os.Stdout, "{\"type\":\"agent_settled\",\"aborted\":false}\n")
		for scan.Scan() {
		}
		return
	}
	if mode := os.Getenv("MERAKCODE_FIXTURE_MODE"); mode != "" {
		if mode == "history" {
			text := "First report"
			if strings.Contains(prompt.Message, "Rework") {
				if !strings.Contains(prompt.Message, "Original brief") || !strings.Contains(prompt.Message, "First report") {
					os.Exit(12)
				}
				text = "Preserved original context"
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": []map[string]string{{"type": "text", "text": text}}, "stopReason": "stop"}})
			_, _ = io.WriteString(os.Stdout, "{\"type\":\"agent_settled\",\"aborted\":false}\n")
			for scan.Scan() {
			}
			return
		}
		_, _ = io.WriteString(os.Stdout, "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Waiting\"}}\n")
		for scan.Scan() {
			if mode != "steer" {
				continue
			}
			var next struct{ Type, Message, StreamingBehavior string }
			if json.Unmarshal(scan.Bytes(), &next) != nil || next.StreamingBehavior != "steer" {
				os.Exit(6)
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": []map[string]string{{"type": "text", "text": next.Message}}, "stopReason": "stop"}})
			_, _ = io.WriteString(os.Stdout, "{\"type\":\"agent_settled\",\"aborted\":false}\n")
		}
		return
	}
	body, err := os.ReadFile(fixture)
	if err != nil {
		os.Exit(4)
	}
	_, _ = io.WriteString(os.Stdout, strings.ReplaceAll(string(body), `\u2028`, "\u2028"))
	for scan.Scan() {
	}
}
