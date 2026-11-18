package remote

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type remoteLookupTool struct {
	tool.Tool
	owner *Remote
	group event.ID
}

func (t remoteLookupTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	domain := t.owner
	owner, hosted := domain.roster.HostedGroup(t.group)
	if !hosted || !strings.HasPrefix(owner.(string), "remote:") {
		return t.Tool.Run(ctx, call)
	}
	if !domain.ActiveDeviceGroup(t.group) || call.Env.Scope.Group != t.group || call.Env.Scope.Session == "" {
		return tool.Result{}, errors.New("MRK-1001")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result := make(chan tool.Result, 1)
	body, err := json.Marshal(call)
	if err != nil {
		return tool.Result{}, err
	}
	domain.cloudReplyMu.Lock()
	fact, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + call.Env.Scope.Session), Scope: call.Env.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: call.Env.Member}, Type: wire.RemoteLookupRequested, Payload: body})
	if err == nil {
		domain.remoteLookups[fact.ID] = result
	}
	domain.cloudReplyMu.Unlock()
	if err != nil {
		return tool.Result{}, err
	}
	defer func() {
		domain.cloudReplyMu.Lock()
		delete(domain.remoteLookups, fact.ID)
		domain.cloudReplyMu.Unlock()
	}()
	select {
	case reply := <-result:
		return reply, nil
	case <-ctx.Done():
		return tool.Result{}, ctx.Err()
	}
}

func (domain *Remote) answerRemoteLookup(ctx context.Context, reply wire.RemoteLookupReply) error {
	fact, err := domain.core.Store.Get(ctx, reply.Request)
	if err != nil || fact.Type != wire.RemoteLookupRequested {
		return errors.New("unknown reference request")
	}
	domain.cloudReplyMu.Lock()
	defer domain.cloudReplyMu.Unlock()
	if pending := domain.remoteLookups[reply.Request]; pending != nil {
		select {
		case pending <- reply.Result:
		default:
		}
	}
	return nil
}
