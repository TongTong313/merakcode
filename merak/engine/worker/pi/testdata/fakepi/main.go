package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
)

func main() {
	args := os.Args[1:]
	fixture := ""
	tools := ""
	for i, arg := range args {
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
	var prompt struct{ Type, Message string }
	if json.Unmarshal(scan.Bytes(), &prompt) != nil || prompt.Type != "prompt" || prompt.Message == "" {
		os.Exit(3)
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
