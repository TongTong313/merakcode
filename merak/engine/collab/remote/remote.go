package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	workerremote "github.com/TongTong313/merakcode/merak/engine/collab/worker/remote"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Remote) RemoteMembers(ctx context.Context) ([]wire.RemoteMember, error) {
	members, err := domain.DeviceMembers(ctx)
	if err != nil {
		return nil, err
	}
	result := []wire.RemoteMember{}
	for _, member := range members {
		p, err := domain.roster.MemberAgent(ctx, member)
		if err != nil {
			return nil, err
		}
		result = append(result, wire.RemoteMember{Member: member, Caps: domain.runnerFor(p, nil).Caps()})
	}
	return result, nil
}

func (domain *Remote) RemoteCredentials(ctx context.Context, id event.ID) (wire.RemoteConnectParams, error) {
	var result wire.RemoteConnectParams
	if domain.core.DataDir == "" || id == "" {
		return result, errors.New("MRK-3001")
	}
	body, err := domain.vault.Get(ctx, "remote:"+string(id))
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return result, err
	}
	return result, nil
}

func (domain *Remote) ImportRemoteEvent(ctx context.Context, host event.ID, fact event.Event) error {
	domain.remoteImportMu.Lock()
	defer domain.remoteImportMu.Unlock()
	if !event.Transient(fact.Type) {
		doc, err := domain.core.Store.Fetch(ctx, "remote-stream", string(fact.Stream))
		if errors.Is(err, store.ErrNotFound) {
			err = domain.core.Store.Put(ctx, store.Doc{Kind: "remote-stream", Key: string(fact.Stream), Body: json.RawMessage(`{}`), Meta: map[string]string{"host": string(host)}})
		} else if err == nil && doc.Meta["host"] != string(host) {
			err = store.ErrConflict
		}
		if err != nil {
			return err
		}
	}
	if err := store.ResumeStream(ctx, domain.core.Bus, domain.core.Store, fact.Stream); err != nil {
		return err
	}
	if prior, err := domain.core.Store.Get(ctx, fact.ID); err == nil {
		if prior.Stream != fact.Stream || prior.Seq != fact.Seq {
			return store.ErrConflict
		}
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if fact.Type == group.MemberAsked {
		domain.mu.Lock()
		domain.workerQuestions[fact.ID] = &PendingWorkerQuestion{group: fact.Scope.Group, Task: fact.Scope.Task, member: fact.Actor.ID, Reply: make(chan string, 1)}
		domain.mu.Unlock()
	}
	if err := domain.core.Bus.Import(ctx, fact); err != nil {
		return err
	}
	if fact.Type == loop.TurnFinished {
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil {
			return err
		}
		if loop.BudgetStop(outcome.Stop) {
			domain.execution.BlockBudgetTask(ctx, fact.Scope)
		}
	}
	return nil
}

func (domain *Remote) ReplyRemoteEvent(ctx context.Context, fact event.Event) (wire.RemoteControlParams, error) {
	if fact.Type == wire.RemoteLookupRequested {
		call, err := event.Decode[tool.Call](fact)
		if err != nil {
			return wire.RemoteControlParams{}, err
		}
		result, err := domain.roster.LocalGroupLookup(fact.Scope.Group).Run(ctx, call)
		return wire.RemoteControlParams{Lookup: &wire.RemoteLookupReply{Request: fact.ID, Result: result}}, err
	}
	if fact.Type == permission.Requested {
		request, err := event.Decode[permission.Request](fact)
		if err != nil {
			return wire.RemoteControlParams{}, err
		}
		request.ID = fact.ID
		request.Call.Env.Scope = fact.Scope
		request.Call.Env.Scope.Session = ""
		reply, err := domain.permissions.AskRemote(ctx, request, fact.Time)
		return wire.RemoteControlParams{Reply: &wire.DeviceReply{PermissionReplyParams: wire.PermissionReplyParams{Request: fact.ID, Decision: reply.Decision, Leader: reply.Leader, Remember: reply.Remember}, Human: reply.Human}}, err
	}
	if fact.Type == question.Asked {
		request, err := event.Decode[question.Request](fact)
		if err != nil {
			return wire.RemoteControlParams{}, err
		}
		request.ID = fact.ID
		answer, err := domain.askQuestion(ctx, request)
		return wire.RemoteControlParams{QuestionReply: &wire.DeviceAnswer{QuestionReplyParams: wire.QuestionReplyParams{Request: fact.ID, Text: answer.Text, Cancelled: answer.Cancelled}, Human: answer.Human}}, err
	}
	if fact.Type == group.MemberAsked {
		domain.mu.Lock()
		pending := domain.workerQuestions[fact.ID]
		domain.mu.Unlock()
		if pending == nil {
			return wire.RemoteControlParams{}, store.ErrNotFound
		}
		defer domain.ForgetWorkerQuestion(fact.ID)
		state, err := domain.groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return wire.RemoteControlParams{}, err
		}
		ctx, cancel := context.WithTimeout(ctx, max(time.Duration(0), state.Group.Settings.ApprovalWait(domain.permissions.Timeout)-domain.core.Now().Sub(fact.Time)))
		defer cancel()
		select {
		case text := <-pending.Reply:
			return wire.RemoteControlParams{QuestionReply: &wire.DeviceAnswer{QuestionReplyParams: wire.QuestionReplyParams{Request: fact.ID, Text: text}}}, nil
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				domain.approvalTimedOut(context.WithoutCancel(ctx), fact.Scope, fact.Actor.ID, fact.ID)
			}
			return wire.RemoteControlParams{}, ctx.Err()
		}
	}
	return wire.RemoteControlParams{}, errors.New("unsupported remote request")
}

func (domain *Remote) ConnectRemote(ctx context.Context, params wire.RemoteConnectParams) (wire.RemoteConnection, error) {
	if domain.core.DataDir == "" || domain.dial == nil {
		return wire.RemoteConnection{}, errors.New("MRK-3001")
	}
	members, err := workerremote.Members(ctx, domain.dial, params.Endpoint, params.Token)
	if err != nil {
		return wire.RemoteConnection{}, err
	}
	domain.remoteImportMu.Lock()
	defer domain.remoteImportMu.Unlock()
	connections, err := domain.core.Store.List(ctx, "remote-connection", "")
	if err != nil {
		return wire.RemoteConnection{}, err
	}
	secret, _ := json.Marshal(params)
	vault := domain.vault
	for _, prior := range connections {
		doc, err := domain.core.Store.Fetch(ctx, prior.Kind, prior.Key)
		if err != nil {
			return wire.RemoteConnection{}, err
		}
		var saved struct {
			Endpoint string `json:"endpoint"`
		}
		if json.Unmarshal(doc.Body, &saved) != nil || canonicalRemoteEndpoint(saved.Endpoint) != canonicalRemoteEndpoint(params.Endpoint) {
			continue
		}
		if err := vault.Set(ctx, "remote:"+prior.Key, secret); err != nil {
			return wire.RemoteConnection{}, err
		}
		return wire.RemoteConnection{ID: event.ID(prior.Key), Endpoint: params.Endpoint, Members: members}, nil
	}
	result := wire.RemoteConnection{ID: domain.core.NewID(), Endpoint: params.Endpoint, Members: members}
	key := "remote:" + string(result.ID)
	if err := vault.Set(ctx, key, secret); err != nil {
		return wire.RemoteConnection{}, err
	}
	body, _ := json.Marshal(struct {
		Endpoint string `json:"endpoint"`
	}{params.Endpoint})
	if err := domain.core.Store.Put(ctx, store.Doc{Kind: "remote-connection", Key: string(result.ID), Body: body}); err != nil {
		_ = vault.Delete(context.WithoutCancel(ctx), key)
		return wire.RemoteConnection{}, err
	}
	return result, nil
}

func canonicalRemoteEndpoint(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	parsed.Host = strings.ToLower(parsed.Host)
	if parsed.Scheme == "ws" && parsed.Port() == "80" || parsed.Scheme == "wss" && parsed.Port() == "443" {
		parsed.Host = strings.TrimSuffix(parsed.Host, ":"+parsed.Port())
	}
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String()
}
