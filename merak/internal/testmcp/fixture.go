// Package testmcp drives a real MCP command from product fixtures.
package testmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func Call(server worker.MCPConfig, name string, input json.RawMessage) (tool.Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, server.Command, server.Args...)
	command.Env = os.Environ()
	for key, value := range server.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		return tool.Result{}, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return tool.Result{}, err
	}
	if err := command.Start(); err != nil {
		return tool.Result{}, err
	}
	defer func() { stdin.Close(); _ = command.Wait() }()
	client, err := mcp.Connect(ctx, "merak", stdout, stdin)
	if err != nil {
		return tool.Result{}, err
	}
	defer client.Close()
	operations, err := client.Tools(ctx)
	if err != nil {
		return tool.Result{}, err
	}
	for _, operation := range operations {
		if operation.Spec().Name == "mcp__merak__"+name {
			return operation.Run(ctx, tool.Call{Input: input})
		}
	}
	return tool.Result{}, fmt.Errorf("missing MCP tool %s", name)
}

func Report(server worker.MCPConfig) error {
	result, err := Call(server, "submit_report", json.RawMessage(`{"verdict":"done","summary":"Report submitted through MCP."}`))
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("MCP report rejected: %+v", result)
	}
	return nil
}

// Claim takes a task through the claim_task tool of a Worker's MCP server.
func Claim(server worker.MCPConfig, task string) error {
	input, err := json.Marshal(map[string]string{"task": task})
	if err != nil {
		return err
	}
	result, err := Call(server, "claim_task", input)
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("MCP claim rejected: %+v", result)
	}
	return nil
}
