package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/execution"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

type deviceOutput struct{ bytes.Buffer }

func (b *deviceOutput) Write(data []byte) (int, error) {
	if b.Len()+len(data) > 8<<20 {
		return 0, errors.New("device tool output limit exceeded")
	}
	return b.Buffer.Write(data)
}

func (domain *Remote) startDeviceTool(request wire.DeviceToolCall) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return
	}
	domain.cloudMu.Lock()
	if domain.cloudWorkCtx == nil || domain.cloudWorkCtx.Err() != nil {
		domain.cloudMu.Unlock()
		return
	}
	work, jobs := domain.cloudWorkCtx, domain.cloudJobs
	jobs.Add(1)
	domain.cloudMu.Unlock()
	domain.core.Workers.Go(func() {
		defer jobs.Done()
		ctx, cancel := context.WithTimeout(work, time.Minute)
		defer cancel()
		if !domain.CurrentCloudGroup(ctx, request.Scope.Group) || request.Call.ID == "" {
			return
		}
		stream := domain.DeviceStream(event.Event{Stream: event.Stream("group:" + request.Scope.Group), Scope: request.Scope})
		if err := domain.ownCloudStream(ctx, stream); err != nil {
			return
		}
		body, _ := json.Marshal(model.ToolCall{ID: request.Call.ID, Name: request.Call.Name, Input: request.Call.Input})
		called, err := domain.core.Bus.Publish(ctx, event.Event{Stream: stream, Scope: request.Scope, Type: tool.Called, Actor: event.Actor{Kind: event.ActorAgent, ID: request.Member}, Payload: body})
		if err != nil {
			return
		}
		result := domain.runDeviceTool(ctx, request)
		body, _ = json.Marshal(tool.Completion{CallID: request.Call.ID, Name: request.Call.Name, Result: result})
		ending, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		_, _ = domain.core.Bus.Publish(ending, event.Event{Stream: stream, Scope: request.Scope, Type: tool.Completed, Actor: event.Actor{Kind: event.ActorAgent, ID: request.Member}, Cause: called.ID, Payload: body})
		select {
		case domain.cloudWake <- struct{}{}:
		default:
		}
	})
}

func (domain *Remote) runDeviceTool(ctx context.Context, request wire.DeviceToolCall) tool.Result {
	failure := func(code string) tool.Result {
		return tool.Result{IsError: true, Code: code, Parts: []model.Part{{Text: code}}}
	}
	switch request.Call.Name {
	case "read_file", "grep", "glob", "list_dir":
	default:
		return failure("MRK-5002")
	}
	source, err := domain.groups.Get(ctx, request.SourceGroup)
	if err != nil || source.Group.Kind != group.KindLocal {
		return failure("MRK-5002")
	}
	member, err := domain.roster.GroupMember(ctx, request.SourceGroup, request.Member)
	if err != nil || member.Kind != group.MemberAgent {
		return failure("MRK-5002")
	}
	configuration, err := domain.execution.MemberSandboxProfile(ctx, source.Group.Project.Directory, sandbox.Profile{Network: sandbox.Network{Mode: "off"}})
	if err != nil {
		return failure("MRK-5004")
	}
	configuration.WriteAllow = nil
	configuration, err = execution.DenyProductState(configuration)
	if err != nil {
		return failure("MRK-5004")
	}
	launcher := &sandbox.Launcher{StateDir: domain.sandboxStateDir, MemberName: member.Name, Unavailable: func(context.Context, sandbox.Status) error { return errors.New("MRK-5004") }}
	defer launcher.Close()
	if !launcher.Status(ctx, configuration).Available {
		return failure("MRK-5004")
	}
	binary := domain.mcpCommand
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
