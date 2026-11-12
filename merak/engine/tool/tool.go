// Package tool defines callable operations and their model-facing descriptions.
package tool

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

const (
	Called     event.Type = "tool.called"
	Completed  event.Type = "tool.completed"
	Progressed event.Type = "tool.progress"
)

func init() {
	event.Register[model.ToolCall](Called)
	event.Register[Completion](Completed)
	event.Register[Progress](Progressed)
}

type Progress struct {
	Raw json.RawMessage `json:"raw"`
}

type Completion struct {
	CallID string `json:"callId"`
	Name   string `json:"name"`
	Result
}

type Spec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Input       json.RawMessage `json:"input"`
	Effect      Effect          `json:"effect"`
}

type Effect string

const (
	EffectRead    Effect = "read"
	EffectWrite   Effect = "write"
	EffectExec    Effect = "exec"
	EffectGroup   Effect = "group"
	EffectNetwork Effect = "network"
)

type Tool interface {
	Spec() Spec
	Run(context.Context, Call) (Result, error)
}

type Call struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
	Env   Env             `json:"-"`
}

type Env struct {
	CacheDirectories []string
	Member           event.ID
	Mode             string
	Sandbox          *sandbox.Launcher
	SandboxProfile   sandbox.Profile
	Children         Children
	MemoryOwners     []memory.Owner
	Workdir          string
	Scope            event.Scope
	Reads            *Reads
	// Attach returns text to append to the result of reading a file, such as the rules that fit it; nil adds nothing.
	Attach func(file string) string
	Jobs   *Jobs
	Spill  func(context.Context, string, []byte) (Ref, error)
}

type Ref string

type Result struct {
	DeniedHost   string       `json:"deniedHost,omitempty"`
	DeniedSource string       `json:"deniedSource,omitempty"`
	MemberName   string       `json:"memberName,omitempty"`
	ChildID      event.ID     `json:"childId,omitempty"`
	Parts        []model.Part `json:"parts"`
	IsError      bool         `json:"isError,omitempty"`
	Code         string       `json:"code,omitempty"`
	ExitCode     *int         `json:"exitCode,omitempty"`
	Truncated    bool         `json:"truncated,omitempty"`
	Full         Ref          `json:"full,omitempty"`
	JobID        string       `json:"jobId,omitempty"`
	Running      bool         `json:"running,omitempty"`
}

func failure(err error) Result {
	return Result{IsError: true, Code: "MRK-5001", Parts: []model.Part{{Text: err.Error()}}}
}
