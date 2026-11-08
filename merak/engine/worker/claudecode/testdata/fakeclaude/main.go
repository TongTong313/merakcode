// Command fakeclaude exercises the adapter over real process pipes without a model service.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		if os.Getenv("MERAKCODE_FIXTURE_SLOW_VERSION") == "1" {
			time.Sleep(2500 * time.Millisecond)
		}
		fmt.Println("2.1.0 (Claude Code fixture)")
		return
	}
	printMode := flag.Bool("p", false, "")
	inputFormat := flag.String("input-format", "", "")
	outputFormat := flag.String("output-format", "", "")
	flag.Bool("verbose", false, "")
	flag.Bool("include-partial-messages", false, "")
	flag.String("model", "", "")
	system := flag.String("append-system-prompt", "", "")
	fixture := flag.String("fixture", "", "")
	hold := flag.Bool("hold", false, "")
	history := flag.Bool("history", false, "")
	resume := flag.String("resume", "", "")
	tools := flag.String("tools", "", "")
	flag.Parse()
	if err := os.WriteFile("tools.txt", []byte(*tools), 0600); err != nil {
		os.Exit(9)
	}
	if err := os.WriteFile("system.txt", []byte(*system), 0600); err != nil {
		os.Exit(4)
	}
	if !*printMode || *inputFormat != "stream-json" || *outputFormat != "stream-json" {
		os.Exit(2)
	}
	reader := bufio.NewScanner(os.Stdin)
	var inputs []json.RawMessage
	for reader.Scan() {
		var input struct {
			Type    string `json:"type"`
			Message struct {
				Role string `json:"role"`
			} `json:"message"`
		}
		if json.Unmarshal(reader.Bytes(), &input) != nil || input.Type != "user" || input.Message.Role != "user" {
			os.Exit(3)
		}
		inputs = append(inputs, append(json.RawMessage(nil), reader.Bytes()...))
		body, _ := json.Marshal(inputs)
		if err := os.WriteFile("inputs.json", body, 0600); err != nil {
			os.Exit(4)
		}
		if *hold && len(inputs) < 2 {
			continue
		}
		if *history {
			const id = "550e8400-e29b-41d4-a716-446655440000"
			var previous string
			if *resume != "" {
				if *resume != id {
					os.Exit(6)
				}
				body, err := os.ReadFile("history.json")
				if err != nil {
					os.Exit(7)
				}
				previous = string(body)
			}
			text := previous + string(reader.Bytes())
			if err := os.WriteFile("history.json", []byte(text), 0600); err != nil {
				os.Exit(8)
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "system", "subtype": "init", "session_id": id})
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "structured_output": map[string]string{"verdict": "done", "summary": text}})
			return
		}
		if *fixture == "" {
			fmt.Println(`{"type":"assistant","message":{"content":[{"type":"text","text":"Checked README."}]}}`)
			fmt.Println(`{"type":"result","subtype":"success","result":"Checked README."}`)
			return
		}
		output, err := os.ReadFile(*fixture)
		if err != nil {
			os.Exit(5)
		}
		_, _ = os.Stdout.Write(output)
		return
	}
}
