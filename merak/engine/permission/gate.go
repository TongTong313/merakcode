package permission

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type Request struct {
	Kind    string    `json:"kind,omitempty"`
	Path    string    `json:"path,omitempty"`
	Host    string    `json:"host,omitempty"`
	Deletes bool      `json:"deletes,omitempty"`
	ID      event.ID  `json:"-"`
	Call    tool.Call `json:"call"`
	Spec    tool.Spec `json:"spec"`
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
	Human    event.ID `json:"human,omitempty"`
	Decision Decision `json:"decision"`
}

type Gate struct {
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
	decision := g.gate.Policy.Decide(call, g.Spec())
	if decision == Ask {
		request := Request{Call: call, Spec: g.Spec()}
		id, err := g.gate.emit(ctx, call.Env.Scope, event.ActorAgent, Requested, request, "")
		if err != nil {
			return tool.Result{}, err
		}
		reply := Reply{Decision: Deny}
		if g.gate.Ask != nil {
			request.ID = id
			reply, err = g.gate.Ask(ctx, request)
			if err != nil {
				return tool.Result{}, err
			}
		}
		if _, err := g.gate.emit(ctx, call.Env.Scope, event.ActorHuman, Replied, reply, id); err != nil {
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
	}
	e, err := g.Bus.Publish(ctx, event.Event{
		Stream: event.Stream("session:" + string(scope.Session)), Scope: scope, Actor: author,
		Type: kind, Payload: data, Cause: cause,
	})
	return e.ID, err
}
