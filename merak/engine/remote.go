package engine

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker/remote"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (e *Engine) RemoteMembers(ctx context.Context) ([]protocol.RemoteMember, error) {
	members, err := e.DeviceMembers(ctx)
	if err != nil {
		return nil, err
	}
	result := []protocol.RemoteMember{}
	for _, member := range members {
		p, err := e.memberAgent(ctx, member)
		if err != nil {
			return nil, err
		}
		result = append(result, protocol.RemoteMember{Member: member, Caps: e.runnerFor(p, nil).Caps()})
	}
	return result, nil
}

func (e *Engine) remoteCredentials(ctx context.Context, id event.ID) (protocol.RemoteConnectParams, error) {
	var result protocol.RemoteConnectParams
	if e.dataDir == "" || id == "" {
		return result, errors.New("MRK-3001")
	}
	body, err := e.vault.Get(ctx, "remote:"+string(id))
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return result, err
	}
	return result, nil
}

func (e *Engine) importRemoteEvent(ctx context.Context, host event.ID, fact event.Event) error {
	e.remoteImportMu.Lock()
	defer e.remoteImportMu.Unlock()
	if !event.Transient(fact.Type) {
		doc, err := e.store.Fetch(ctx, "remote-stream", string(fact.Stream))
		if errors.Is(err, store.ErrNotFound) {
			err = e.store.Put(ctx, store.Doc{Kind: "remote-stream", Key: string(fact.Stream), Body: json.RawMessage(`{}`), Meta: map[string]string{"host": string(host)}})
		} else if err == nil && doc.Meta["host"] != string(host) {
			err = store.ErrConflict
		}
		if err != nil {
			return err
		}
	}
	if err := e.resumeDeviceStream(ctx, fact.Stream); err != nil {
		return err
	}
	if prior, err := e.store.Get(ctx, fact.ID); err == nil {
		if prior.Stream != fact.Stream || prior.Seq != fact.Seq {
			return store.ErrConflict
		}
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if fact.Type == group.MemberAsked {
		e.mu.Lock()
		e.workerQuestions[fact.ID] = &pendingWorkerQuestion{group: fact.Scope.Group, task: fact.Scope.Task, member: fact.Actor.ID, reply: make(chan string, 1)}
		e.mu.Unlock()
	}
	if err := e.Bus.Import(ctx, fact); err != nil {
		return err
	}
	if fact.Type == loop.TurnFinished {
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil {
			return err
		}
		if loop.BudgetStop(outcome.Stop) {
			e.blockBudgetTask(ctx, fact.Scope)
		}
	}
	return nil
}

func (e *Engine) replyRemoteEvent(ctx context.Context, fact event.Event) (protocol.RemoteControlParams, error) {
	if fact.Type == protocol.RemoteLookupRequested {
		call, err := event.Decode[tool.Call](fact)
		if err != nil {
			return protocol.RemoteControlParams{}, err
		}
		result, err := e.localGroupLookup(fact.Scope.Group).Run(ctx, call)
		return protocol.RemoteControlParams{Lookup: &protocol.RemoteLookupReply{Request: fact.ID, Result: result}}, err
	}
	if fact.Type == permission.Requested {
		request, err := event.Decode[permission.Request](fact)
		if err != nil {
			return protocol.RemoteControlParams{}, err
		}
		request.ID = fact.ID
		request.Call.Env.Scope = fact.Scope
		request.Call.Env.Scope.Session = ""
		reply, err := e.permissions.AskRemote(ctx, request, fact.Time)
		return protocol.RemoteControlParams{Reply: &protocol.DeviceReply{PermissionReplyParams: protocol.PermissionReplyParams{Request: fact.ID, Decision: reply.Decision, Leader: reply.Leader, Remember: reply.Remember}, Human: reply.Human}}, err
	}
	if fact.Type == question.Asked {
		request, err := event.Decode[question.Request](fact)
		if err != nil {
			return protocol.RemoteControlParams{}, err
		}
		request.ID = fact.ID
		answer, err := e.askQuestion(ctx, request)
		return protocol.RemoteControlParams{QuestionReply: &protocol.DeviceAnswer{QuestionReplyParams: protocol.QuestionReplyParams{Request: fact.ID, Text: answer.Text, Cancelled: answer.Cancelled}, Human: answer.Human}}, err
	}
	if fact.Type == group.MemberAsked {
		e.mu.Lock()
		pending := e.workerQuestions[fact.ID]
		e.mu.Unlock()
		if pending == nil {
			return protocol.RemoteControlParams{}, store.ErrNotFound
		}
		defer func() { e.mu.Lock(); delete(e.workerQuestions, fact.ID); e.mu.Unlock() }()
		state, err := e.Groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return protocol.RemoteControlParams{}, err
		}
		ctx, cancel := context.WithTimeout(ctx, max(time.Duration(0), state.Group.Settings.ApprovalWait(e.permissions.Timeout)-e.now().Sub(fact.Time)))
		defer cancel()
		select {
		case text := <-pending.reply:
			return protocol.RemoteControlParams{QuestionReply: &protocol.DeviceAnswer{QuestionReplyParams: protocol.QuestionReplyParams{Request: fact.ID, Text: text}}}, nil
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				e.approvalTimedOut(context.WithoutCancel(ctx), fact.Scope, fact.Actor.ID, fact.ID)
			}
			return protocol.RemoteControlParams{}, ctx.Err()
		}
	}
	return protocol.RemoteControlParams{}, errors.New("unsupported remote request")
}

func (e *Engine) ConnectRemote(ctx context.Context, params protocol.RemoteConnectParams) (protocol.RemoteConnection, error) {
	if e.dataDir == "" {
		return protocol.RemoteConnection{}, errors.New("MRK-3001")
	}
	members, err := remote.Members(ctx, params.Endpoint, params.Token)
	if err != nil {
		return protocol.RemoteConnection{}, err
	}
	e.remoteImportMu.Lock()
	defer e.remoteImportMu.Unlock()
	connections, err := e.store.List(ctx, "remote-connection", "")
	if err != nil {
		return protocol.RemoteConnection{}, err
	}
	secret, _ := json.Marshal(params)
	vault := e.vault
	for _, prior := range connections {
		doc, err := e.store.Fetch(ctx, prior.Kind, prior.Key)
		if err != nil {
			return protocol.RemoteConnection{}, err
		}
		var saved struct {
			Endpoint string `json:"endpoint"`
		}
		if json.Unmarshal(doc.Body, &saved) != nil || canonicalRemoteEndpoint(saved.Endpoint) != canonicalRemoteEndpoint(params.Endpoint) {
			continue
		}
		if err := vault.Set(ctx, "remote:"+prior.Key, secret); err != nil {
			return protocol.RemoteConnection{}, err
		}
		return protocol.RemoteConnection{ID: event.ID(prior.Key), Endpoint: params.Endpoint, Members: members}, nil
	}
	result := protocol.RemoteConnection{ID: e.newID(), Endpoint: params.Endpoint, Members: members}
	key := "remote:" + string(result.ID)
	if err := vault.Set(ctx, key, secret); err != nil {
		return protocol.RemoteConnection{}, err
	}
	body, _ := json.Marshal(struct {
		Endpoint string `json:"endpoint"`
	}{params.Endpoint})
	if err := e.store.Put(ctx, store.Doc{Kind: "remote-connection", Key: string(result.ID), Body: body}); err != nil {
		_ = vault.Delete(context.WithoutCancel(ctx), key)
		return protocol.RemoteConnection{}, err
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
