package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type deviceOutput struct{ bytes.Buffer }

func (b *deviceOutput) Write(data []byte) (int, error) {
	if b.Len()+len(data) > 8<<20 {
		return 0, errors.New("device tool output limit exceeded")
	}
	return b.Buffer.Write(data)
}

func (e *Engine) startDeviceTool(request protocol.DeviceToolCall) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return
	}
	e.cloudMu.Lock()
	if e.cloudWorkCtx == nil || e.cloudWorkCtx.Err() != nil {
		e.cloudMu.Unlock()
		return
	}
	work, jobs := e.cloudWorkCtx, e.cloudJobs
	jobs.Add(1)
	e.cloudMu.Unlock()
	e.workers.Go(func() {
		defer jobs.Done()
		ctx, cancel := context.WithTimeout(work, time.Minute)
		defer cancel()
		if !e.currentCloudGroup(ctx, request.Scope.Group) || request.Call.ID == "" {
			return
		}
		stream := e.deviceStream(event.Event{Stream: event.Stream("group:" + request.Scope.Group), Scope: request.Scope})
		if err := e.ownCloudStream(ctx, stream); err != nil {
			return
		}
		body, _ := json.Marshal(model.ToolCall{ID: request.Call.ID, Name: request.Call.Name, Input: request.Call.Input})
		called, err := e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: request.Scope, Type: tool.Called, Actor: event.Actor{Kind: event.ActorAgent, ID: request.Member}, Payload: body})
		if err != nil {
			return
		}
		result := e.runDeviceTool(ctx, request)
		body, _ = json.Marshal(tool.Completion{CallID: request.Call.ID, Name: request.Call.Name, Result: result})
		ending, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		_, _ = e.Bus.Publish(ending, event.Event{Stream: stream, Scope: request.Scope, Type: tool.Completed, Actor: event.Actor{Kind: event.ActorAgent, ID: request.Member}, Cause: called.ID, Payload: body})
		select {
		case e.cloudWake <- struct{}{}:
		default:
		}
	})
}

func (e *Engine) runDeviceTool(ctx context.Context, request protocol.DeviceToolCall) tool.Result {
	failure := func(code string) tool.Result {
		return tool.Result{IsError: true, Code: code, Parts: []model.Part{{Text: code}}}
	}
	switch request.Call.Name {
	case "read_file", "grep", "glob", "list_dir":
	default:
		return failure("MRK-5002")
	}
	source, err := e.Groups.Get(ctx, request.SourceGroup)
	if err != nil || source.Group.Kind != group.KindLocal {
		return failure("MRK-5002")
	}
	member, err := e.groupMember(ctx, request.SourceGroup, request.Member)
	if err != nil || member.Kind != group.MemberAgent {
		return failure("MRK-5002")
	}
	configuration, err := e.memberSandboxProfile(ctx, source.Group.Project.Directory, sandbox.Profile{Network: sandbox.Network{Mode: "off"}})
	if err != nil {
		return failure("MRK-5004")
	}
	configuration.WriteAllow = nil
	configuration, err = denyProductState(configuration)
	if err != nil {
		return failure("MRK-5004")
	}
	launcher := &sandbox.Launcher{StateDir: e.sandboxStateDir, MemberName: member.Name, Unavailable: func(context.Context, sandbox.Status) error { return errors.New("MRK-5004") }}
	defer launcher.Close()
	if !launcher.Status(ctx, configuration).Available {
		return failure("MRK-5004")
	}
	binary := e.mcpCommand
	if binary == "" {
		binary, err = os.Executable()
		if err != nil {
			return failure("MRK-5001")
		}
	}
	command, err := launcher.Command(ctx, configuration, binary, "internal-read-tool")
	if err != nil {
		return failure("MRK-5004")
	}
	body, _ := json.Marshal(request.Call)
	var output deviceOutput
	command.Dir = source.Group.Project.Directory
	command.Stdin = bytes.NewReader(body)
	command.Stdout = &output
	command.Stderr = io.Discard
	if err = launcher.Start(command, configuration); err != nil {
		return failure("MRK-5004")
	}
	if err = launcher.Wait(command); err != nil {
		return failure("MRK-5001")
	}
	var result tool.Result
	if err = json.Unmarshal(output.Bytes(), &result); err != nil {
		return failure("MRK-5001")
	}
	return result
}
