package permission

import (
	"context"
	"encoding/json"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

type Request struct {
	RequiredRole group.Role `json:"requiredRole,omitempty"`
	Member       event.ID   `json:"member,omitempty"`
	Mode         Mode       `json:"mode,omitempty"`
	Leader       event.ID   `json:"leader,omitempty"`
	Kind         string     `json:"kind,omitempty"`
	Path         string     `json:"path,omitempty"`
	Host         string     `json:"host,omitempty"`
	Deletes      bool       `json:"deletes,omitempty"`
	ID           event.ID   `json:"id,omitempty"`
	Call         tool.Call  `json:"call"`
	Spec         tool.Spec  `json:"spec"`
}

const (
	Requested event.Type = "permission.requested"
	Replied   event.Type = "permission.replied"
)

func init() {
	event.Register[Request](Requested)
	event.Register[Reply](Replied)
}

type Reply struct {
	Leader   event.ID `json:"leader,omitempty"`
	Remember string   `json:"remember,omitempty"`
	Human    event.ID `json:"human,omitempty"`
	Decision Decision `json:"decision"`
}

type Pending struct {
	Request Request     `json:"request"`
	Scope   event.Scope `json:"scope"`
	Time    time.Time   `json:"time"`
	Seq     uint64      `json:"seq"`
}

type Gate struct {
	Grants *Grants
	Router *Router
	Policy Policy
	Ask    func(context.Context, Request) (Reply, error)
	Bus    *event.Bus
}

func (g *Gate) Wrap(t tool.Tool) tool.Tool {
	return guarded{gate: g, tool: t}
}

type guarded struct {
	gate *Gate
	tool tool.Tool
}

func (g guarded) Spec() tool.Spec { return g.tool.Spec() }

func (g guarded) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	if err := ctx.Err(); err != nil {
		return tool.Result{}, err
	}
	policy := g.gate.Policy
	policy.Rules = append(append([]Rule(nil), policy.Rules...), g.gate.Grants.rules()...)
	if call.Env.Mode != "" {
		policy.Mode = Mode(call.Env.Mode)
	}
	var status sandbox.Status
	if call.Env.Sandbox != nil {
		status = call.Env.Sandbox.Status(ctx, call.Env.SandboxProfile)
		call.Env.CacheDirectories = call.Env.Sandbox.PackageCaches()
	}
	decision := policy.Decide(call, g.Spec(), status)
	if decision == Ask {
		if remembered := g.gate.Grants.decision(call, g.Spec(), policy.Mode); remembered != "" {
			decision = remembered
		}
	}
	if decision == Ask {
		request := requestFor(call, g.Spec())
		request.Mode = policy.Mode
		if request.Mode == ModeAuto && !status.Available {
			request.Mode = ModeAsk
		}
		reply := Reply{Decision: Deny}
		var err error
		if g.gate.Router != nil {
			reply, err = g.gate.Router.Ask(ctx, request)
		} else {
			request.ID, err = g.gate.emit(ctx, call.Env.Scope, event.ActorAgent, Requested, request, "")
			if err == nil && g.gate.Ask != nil {
				reply, err = g.gate.Ask(ctx, request)
			}
			if err == nil {
				_, err = g.gate.emit(ctx, call.Env.Scope, event.ActorHuman, Replied, reply, request.ID)
			}
		}
		if err != nil {
			return tool.Result{}, err
		}
		if err := g.gate.Grants.remember(call, g.Spec(), policy.Mode, reply); err != nil {
			return tool.Result{}, err
		}
		decision = reply.Decision
	}
	if decision != Allow {
		return tool.Result{IsError: true, Code: "MRK-5002", Parts: []model.Part{{Text: "Permission denied."}}}, nil
	}
	if err := ctx.Err(); err != nil {
		return tool.Result{}, err
	}
	return g.tool.Run(ctx, call)
}

func (g *Gate) emit(ctx context.Context, scope event.Scope, actor event.ActorKind, kind event.Type, payload any, cause event.ID) (event.ID, error) {
	if g.Bus == nil {
		return "", nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	author := event.Actor{Kind: actor}
	if reply, ok := payload.(Reply); ok {
		author.ID = reply.Human
		if reply.Leader != "" {
			author.Kind, author.ID = event.ActorAgent, reply.Leader
		}
	}
	e, err := g.Bus.Publish(ctx, event.Event{
		Stream: event.Stream("session:" + string(scope.Session)), Scope: scope, Actor: author,
		Type: kind, Payload: data, Cause: cause,
	})
	return e.ID, err
}
