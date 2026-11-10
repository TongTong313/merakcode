package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type remoteLookupTool struct {
	tool.Tool
	engine *Engine
	group  event.ID
}

func (t remoteLookupTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	e := t.engine
	owner, hosted := e.hostedGroups.Load(t.group)
	if !hosted || !strings.HasPrefix(owner.(string), "remote:") {
		return t.Tool.Run(ctx, call)
	}
	if !e.activeDeviceGroup(t.group) || call.Env.Scope.Group != t.group || call.Env.Scope.Session == "" {
		return tool.Result{}, errors.New("MRK-1001")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result := make(chan tool.Result, 1)
	body, err := json.Marshal(call)
	if err != nil {
		return tool.Result{}, err
	}
	e.cloudReplyMu.Lock()
	fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + call.Env.Scope.Session), Scope: call.Env.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: call.Env.Member}, Type: protocol.RemoteLookupRequested, Payload: body})
	if err == nil {
		e.remoteLookups[fact.ID] = result
	}
	e.cloudReplyMu.Unlock()
	if err != nil {
		return tool.Result{}, err
	}
	defer func() { e.cloudReplyMu.Lock(); delete(e.remoteLookups, fact.ID); e.cloudReplyMu.Unlock() }()
	select {
	case reply := <-result:
		return reply, nil
	case <-ctx.Done():
		return tool.Result{}, ctx.Err()
	}
}

func (e *Engine) answerRemoteLookup(ctx context.Context, reply protocol.RemoteLookupReply) error {
	fact, err := e.store.Get(ctx, reply.Request)
	if err != nil || fact.Type != protocol.RemoteLookupRequested {
		return errors.New("unknown reference request")
	}
	e.cloudReplyMu.Lock()
	defer e.cloudReplyMu.Unlock()
	if pending := e.remoteLookups[reply.Request]; pending != nil {
		select {
		case pending <- reply.Result:
		default:
		}
	}
	return nil
}
