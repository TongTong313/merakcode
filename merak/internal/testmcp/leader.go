package testmcp

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type Leader struct {
	Server worker.MCPConfig
	child  string
}

var approvalID = regexp.MustCompile(`(?s)\(permission.routed\).*?"id":"([^"]+)"`)
var foreignTask = regexp.MustCompile(`Scope fixture ([a-zA-Z0-9_-]+)`)

func (l *Leader) Handle(text string) error {
	if strings.Contains(text, "Exit fixture") {
		return fmt.Errorf("requested fixture exit")
	}
	call := func(name string, input any) (tool.Result, error) {
		body, _ := json.Marshal(input)
		result, err := Call(l.Server, name, body)
		if err == nil && result.IsError {
			err = fmt.Errorf("MCP %s rejected", name)
		}
		return result, err
	}
	if match := foreignTask.FindStringSubmatch(text); len(match) == 2 {
		for _, tc := range []struct {
			name  string
			input any
		}{
			{"create_task", map[string]string{"title": "Escaped", "parent": match[1]}},
			{"assign_task", map[string]string{"task": match[1], "member": "worker"}},
		} {
			body, _ := json.Marshal(tc.input)
			result, err := Call(l.Server, tc.name, body)
			if err != nil || !result.IsError {
				return fmt.Errorf("leader escaped task subtree through %s: %v", tc.name, err)
			}
		}
	}
	if strings.Contains(text, "Create fixture child") {
		result, err := call("create_task", map[string]string{"title": "Fixture child", "workspace": "inplace"})
		if err != nil {
			return err
		}
		var card struct{ ID string }
		if len(result.Parts) == 0 || json.Unmarshal([]byte(result.Parts[0].Text), &card) != nil {
			return fmt.Errorf("invalid fixture task")
		}
		l.child = card.ID
	}
	if strings.Contains(text, "Assign fixture worker") {
		if _, err := call("assign_task", map[string]string{"task": l.child, "member": "worker"}); err != nil {
			return err
		}
	}
	if match := approvalID.FindStringSubmatch(text); len(match) == 2 {
		if _, err := call("approve", map[string]string{"request": match[1], "decision": "allow"}); err != nil {
			return err
		}
	}
	if strings.Contains(text, "Create fixture child") || strings.Contains(text, "Reply fixture") || foreignTask.MatchString(text) {
		if _, err := call("say", map[string]string{"text": fmt.Sprintf("Fixture PID %d", os.Getpid())}); err != nil {
			return err
		}
		body, _ := json.Marshal(map[string]string{"title": "Must not exist"})
		result, err := Call(l.Server, "create_task", body)
		if err != nil || !result.IsError {
			return fmt.Errorf("leader continued after finishing its turn")
		}
	}
	return nil
}
