// Command fakeclaude exercises the adapter over real process pipes without a model service.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/testmcp"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		if os.Getenv("MERAKCODE_FIXTURE_SLOW_VERSION") == "1" {
			time.Sleep(2500 * time.Millisecond)
		}
		if os.Getenv("MERAKCODE_FIXTURE_SLOW_VERSION") == "6s" {
			time.Sleep(6 * time.Second)
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
	fixtureHold := flag.Bool("fixture-hold", false, "")
	hold := flag.Bool("hold", false, "")
	echo := flag.Bool("echo", false, "")
	history := flag.Bool("history", false, "")
	resume := flag.String("resume", "", "")
	tools := flag.String("tools", "", "")
	permissionPrompt := flag.String("permission-prompt-tool", "", "")
	permissionMode := flag.String("permission-mode", "", "")
	settings := flag.String("settings", "", "")
	requestPermission := flag.Bool("request-permission", false, "")
	mcpConfig := flag.String("mcp-config", "", "")
	mcpReport := flag.Bool("mcp-report", false, "")
	mcpClaimFile := flag.String("mcp-claim-file", "", "")
	mcpLeader := flag.Bool("mcp-leader", false, "")
	leaderBoundary := flag.Bool("leader-boundary", false, "")
	recovery := flag.String("recovery-phase", "", "")
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
	leader := new(testmcp.Leader)
	var inputIDs []string
	initialized := false
	for reader.Scan() {
		var input struct {
			UUID      string `json:"uuid"`
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype string `json:"subtype"`
			} `json:"request"`
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(reader.Bytes(), &input) != nil {
			os.Exit(3)
		}
		if input.Type == "control_request" && input.Request.Subtype == "initialize" {
			if *recovery == "initialize-failure" {
				os.Exit(31)
			}
			initialized = true
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": input.RequestID, "response": map[string]any{}}})
			continue
		}
		if input.Type != "user" || input.Message.Role != "user" {
			os.Exit(3)
		}
		inputs = append(inputs, append(json.RawMessage(nil), reader.Bytes()...))
		inputIDs = append(inputIDs, input.UUID)
		if *recovery != "" {
			fmt.Println(`{"type":"system","subtype":"init","session_id":"recovery-session"}`)
			if *recovery == "unacknowledged" {
				os.Exit(32)
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "assistant", "message": map[string]any{"content": []map[string]string{{"type": "text", "text": input.Message.Content}}}})
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "user_message_uuids": []string{input.UUID}})
			continue
		}
		if strings.Contains(input.Message.Content, "Write a short handover summary") {
			fmt.Println(`{"type":"assistant","message":{"content":[{"type":"text","text":"Fixture handover"}]}}`)
			fmt.Println(`{"type":"result","subtype":"success","result":"Fixture handover"}`)
			return
		}
		if *leaderBoundary {
			if len(inputIDs) < 2 {
				continue
			}
			for index, id := range inputIDs {
				_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "assistant", "message": map[string]any{"content": []map[string]string{{"type": "text", "text": fmt.Sprint(index)}}}})
				_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "user_message_uuids": []string{id}})
			}
			continue
		}
		if *mcpLeader {
			var configuration struct {
				Servers map[string]worker.MCPConfig `json:"mcpServers"`
			}
			if json.Unmarshal([]byte(*mcpConfig), &configuration) != nil {
				os.Exit(20)
			}
			leader.Server = configuration.Servers["merak"]
			if err := leader.Handle(input.Message.Content); err != nil {
				os.Exit(21)
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "result": "Waiting for events.", "user_message_uuids": []string{input.UUID}})
			continue
		}
		body, _ := json.Marshal(inputs)
		if err := os.WriteFile("inputs.json", body, 0600); err != nil {
			os.Exit(4)
		}
		if *hold && len(inputs) < 2 {
			continue
		}
		if *requestPermission {
			var configured struct {
				Permissions struct {
					Ask []string `json:"ask"`
				} `json:"permissions"`
				Sandbox struct {
					AutoAllow *bool `json:"autoAllowBashIfSandboxed"`
				} `json:"sandbox"`
			}
			if !initialized || *permissionPrompt != "stdio" || *permissionMode != "default" || json.Unmarshal([]byte(*settings), &configured) != nil || len(configured.Permissions.Ask) != 1 || configured.Permissions.Ask[0] != "*" || configured.Sandbox.AutoAllow == nil || *configured.Sandbox.AutoAllow {
				os.Exit(10)
			}
			fmt.Println(`{"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"Write","tool_use_id":"write-1","input":{"file_path":"approved.txt","content":"approved"}}}`)
			if !reader.Scan() {
				os.Exit(11)
			}
			var response struct {
				Type     string `json:"type"`
				Response struct {
					Subtype   string `json:"subtype"`
					RequestID string `json:"request_id"`
					Response  struct {
						Behavior string            `json:"behavior"`
						Input    map[string]string `json:"updatedInput"`
					} `json:"response"`
				} `json:"response"`
			}
			if json.Unmarshal(reader.Bytes(), &response) != nil || response.Type != "control_response" || response.Response.Subtype != "success" || response.Response.RequestID != "permission-1" {
				os.Exit(12)
			}
			text := "Denied"
			if response.Response.Response.Behavior == "allow" {
				if response.Response.Response.Input["file_path"] != "approved.txt" || response.Response.Response.Input["content"] != "approved" {
					os.Exit(13)
				}
				if err := os.WriteFile("approved.txt", []byte("approved"), 0600); err != nil {
					os.Exit(14)
				}
				text = "Allowed"
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "result": text})
			return
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
		if *mcpReport {
			fmt.Println(`{"type":"control_request","request_id":"mcp-permission","request":{"subtype":"can_use_tool","tool_name":"mcp__merak__submit_report","tool_use_id":"mcp-report","input":{"verdict":"done","summary":"Report submitted through MCP."}}}`)
			if !reader.Scan() {
				os.Exit(16)
			}
			var approval struct {
				Response struct{ Response struct{ Behavior string } }
			}
			if json.Unmarshal(reader.Bytes(), &approval) != nil || approval.Response.Response.Behavior != "allow" {
				os.Exit(17)
			}
			if *mcpClaimFile != "" {
				id, err := os.ReadFile(*mcpClaimFile)
				if err != nil {
					os.Exit(18)
				}
				if err := claimMCPTask(*mcpConfig, strings.TrimSpace(string(id))); err != nil {
					fmt.Fprintln(os.Stderr, err)
					os.Exit(19)
				}
			}
			if err := submitMCPReport(*mcpConfig); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(15)
			}
			fmt.Println(`{"type":"result","subtype":"success","result":"MCP finished."}`)
			return
		}
		if *echo {
			// Answers with the message it was given, so a conversation shows which message each answer belongs to.
			text := "External reply: " + input.Message.Content
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "assistant", "message": map[string]any{"content": []map[string]string{{"type": "text", "text": text}}}})
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "result": text})
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
		if *fixtureHold {
			for {
				time.Sleep(time.Second)
			}
		}
		return
	}
}

func submitMCPReport(configuration string) error {
	var config struct {
		Servers map[string]worker.MCPConfig `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(configuration), &config); err != nil {
		return err
	}
	server, ok := config.Servers["merak"]
	if !ok {
		return fmt.Errorf("missing merak MCP server")
	}
	return testmcp.Report(server)
}

func claimMCPTask(configuration, task string) error {
	var config struct {
		Servers map[string]worker.MCPConfig `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(configuration), &config); err != nil {
		return err
	}
	server, ok := config.Servers["merak"]
	if !ok {
		return fmt.Errorf("missing merak MCP server")
	}
	return testmcp.Claim(server, task)
}
