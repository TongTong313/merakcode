package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (e *Engine) deviceStream(fact event.Event) event.Stream {
	if _, ok := e.hostedGroups.Load(fact.Scope.Group); !ok || fact.Stream != event.Stream("group:"+fact.Scope.Group) {
		return fact.Stream
	}
	device := "unavailable"
	if host := e.deviceHostForGroup(fact.Scope.Group); host != nil {
		device = host.device
	}
	return event.Stream("device:" + device + ":group:" + string(fact.Scope.Group))
}

func (e *Engine) ownCloudStream(ctx context.Context, stream event.Stream) error {
	e.cloudMu.Lock()
	account := cloud.Identity(e.cloudCredentials)
	e.cloudMu.Unlock()
	return e.ownDeviceStream(ctx, stream, account)
}

func (e *Engine) ownDeviceStream(ctx context.Context, stream event.Stream, account string) error {
	doc, err := e.store.Fetch(ctx, "cloud-stream", string(stream))
	if err == nil {
		if doc.Meta["host"] != account {
			return cloud.ErrNoCloud
		}
		return e.resumeDeviceStream(ctx, stream)
	}
	if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	err = e.store.Put(ctx, store.Doc{Kind: "cloud-stream", Key: string(stream), Rev: doc.Rev, Body: json.RawMessage(`0`), Meta: map[string]string{"host": account}})
	if errors.Is(err, store.ErrConflict) {
		return e.ownDeviceStream(ctx, stream, account)
	}
	return err
}

func (e *Engine) resumeDeviceStream(ctx context.Context, stream event.Stream) error {
	if e.Bus.Position(stream) != 0 {
		return nil
	}
	facts, err := e.store.Read(ctx, stream, 1, 0)
	if err != nil {
		return err
	}
	if len(facts) > 0 {
		e.Bus.Resume(stream, facts[len(facts)-1].Seq)
	}
	return nil
}

func (e *Engine) receiveCloud(ctx context.Context, link cloud.Link) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.ctx.Done():
			return
		case incoming, ok := <-link.Inbound():
			if !ok {
				return
			}
			if err := e.importCloud(ctx, incoming.Events); err != nil {
				if e.logger != nil {
					e.logger.Warn("Cloud event import failed", "code", "MRK-1007")
				}
				continue
			}
			if incoming.Reply != nil {
				e.answerDevicePermission(*incoming.Reply)
			}
			if incoming.QuestionReply != nil {
				e.answerDeviceQuestion(ctx, *incoming.QuestionReply)
			}
			if incoming.Notice != nil && e.currentCloudGroup(ctx, incoming.Scope.Group) {
				body, _ := json.Marshal(incoming.Notice)
				e.cloudMu.Lock()
				account := cloud.Identity(e.cloudCredentials)
				host := e.cloudHost
				e.cloudMu.Unlock()
				if host == nil {
					continue
				}
				if incoming.Cause != "" {
					host.imports.Lock()
					err := e.indexCloudReference(ctx, host, "event:"+string(incoming.Cause), incoming.Scope.Group)
					host.imports.Unlock()
					if err != nil {
						continue
					}
				}
				stream := event.Stream("inbox:" + account)
				if e.Bus.Position(stream) == 0 {
					facts, err := e.store.Read(ctx, stream, 1, 0)
					if err != nil {
						continue
					}
					if len(facts) > 0 {
						e.Bus.Resume(stream, facts[len(facts)-1].Seq)
					}
				}
				_, _ = e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: incoming.Scope, Cause: incoming.Cause, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorExternal}, Payload: body})
			}
			if incoming.Assignment != nil {
				e.startDeviceAssignment(*incoming.Assignment)
			}
			if incoming.Cancel != nil {
				e.cancelDeviceClaim(ctx, *incoming.Cancel)
			}
			if incoming.Message != nil {
				e.sendDeviceMessage(ctx, *incoming.Message)
			}
			if incoming.ToolCall != nil {
				e.startDeviceTool(*incoming.ToolCall)
			}
		}
	}
}

func (e *Engine) importCloud(ctx context.Context, facts []event.Event) error {
	e.cloudMu.Lock()
	host := e.cloudHost
	e.cloudMu.Unlock()
	return e.importCloudFrom(ctx, host, facts)
}

func (e *Engine) importCloudFrom(ctx context.Context, host *deviceHost, facts []event.Event) error {
	if host == nil {
		return cloud.ErrNoCloud
	}
	host.imports.Lock()
	defer host.imports.Unlock()
	e.cloudMu.Lock()
	current := e.cloudHost == host
	e.cloudMu.Unlock()
	if !current {
		return cloud.ErrNoCloud
	}
	return e.importCloudUnlocked(ctx, host, facts)
}

func (e *Engine) importCloudUnlocked(ctx context.Context, host *deviceHost, facts []event.Event) error {
	for _, fact := range facts {
		if fact.Scope.Group == "" {
			return errors.New("cloud event requires a group")
		}
		if owner, known := e.hostedGroups.Load(fact.Scope.Group); known && owner != host.id {
			return cloud.ErrNoCloud
		}
		if prior, err := e.store.Get(ctx, fact.ID); err == nil {
			if prior.Stream != fact.Stream || prior.Seq != fact.Seq {
				return store.ErrConflict
			}
			if err := e.indexCloudFact(ctx, host, fact); err != nil {
				return err
			}
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if _, ok := e.hostedGroups.Load(fact.Scope.Group); !ok {
			if fact.Type != group.Created {
				params, _ := json.Marshal(protocol.EventsReadParams{Stream: event.Stream("group:" + fact.Scope.Group), From: 1, Limit: 1})
				body, err := e.forwardFromHost(ctx, host, "events.read", params)
				if err != nil {
					return err
				}
				var first []event.Event
				if json.Unmarshal(body, &first) != nil || len(first) != 1 || first[0].Type != group.Created || first[0].Scope.Group != fact.Scope.Group || first[0].Stream != event.Stream("group:"+fact.Scope.Group) || first[0].Seq != 1 {
					return cloud.ErrUnavailable
				}
				if err := e.importCloudUnlocked(ctx, host, first); err != nil {
					return err
				}
				if err := e.importCloudUnlocked(ctx, host, []event.Event{fact}); err != nil {
					return err
				}
				continue
			}
			state, err := event.Decode[group.State](fact)
			if err != nil || state.Group.Kind != group.KindCloud || state.Group.ID != fact.Scope.Group {
				return errors.New("invalid cloud group")
			}
			if _, err = e.Groups.Get(ctx, fact.Scope.Group); !errors.Is(err, store.ErrNotFound) {
				return store.ErrConflict
			}
			account := host.id
			doc, fetchErr := e.store.Fetch(ctx, "cloud-group", string(fact.Scope.Group))
			if fetchErr != nil && !errors.Is(fetchErr, store.ErrNotFound) {
				return fetchErr
			}
			if fetchErr == nil && doc.Meta["host"] != account {
				return cloud.ErrNoCloud
			}
			body, _ := json.Marshal(state.Group)
			if err := e.store.Put(ctx, store.Doc{Kind: "cloud-group", Key: string(fact.Scope.Group), Rev: doc.Rev, Body: body, Meta: map[string]string{"host": account}}); err != nil {
				return err
			}
			e.hostedGroups.Store(fact.Scope.Group, account)
		}
		deviceStream := strings.HasPrefix(string(fact.Stream), "device:") && strings.HasSuffix(string(fact.Stream), ":group:"+string(fact.Scope.Group))
		if fact.Stream != event.Stream("group:"+fact.Scope.Group) && !strings.HasPrefix(string(fact.Stream), "session:") && !deviceStream {
			return errors.New("invalid cloud stream")
		}
		if _, err := e.store.Fetch(ctx, "cloud-stream", string(fact.Stream)); err == nil {
			if event.Transient(fact.Type) {
				continue
			}
			return errors.New("host cannot append to a device-owned stream")
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		position := e.Bus.Position(fact.Stream)
		if position == 0 {
			cached, err := e.store.Read(ctx, fact.Stream, 1, 0)
			if err != nil {
				return err
			}
			if len(cached) > 0 {
				if cached[0].Scope.Group != fact.Scope.Group {
					return store.ErrConflict
				}
				position = cached[len(cached)-1].Seq
				e.Bus.Resume(fact.Stream, position)
			}
		}
		for !event.Transient(fact.Type) && fact.Seq > position+1 {
			params, _ := json.Marshal(protocol.EventsReadParams{Stream: fact.Stream, From: position + 1, Limit: int(min(fact.Seq-position-1, 128))})
			body, err := e.forwardFromHost(ctx, host, "events.read", params)
			if err != nil {
				return err
			}
			var missing []event.Event
			if json.Unmarshal(body, &missing) != nil || len(missing) == 0 {
				return cloud.ErrUnavailable
			}
			for index, item := range missing {
				if item.Stream != fact.Stream || item.Scope.Group != fact.Scope.Group || item.Seq != position+1+uint64(index) || item.Seq >= fact.Seq {
					return cloud.ErrUnavailable
				}
			}
			if err = e.importCloudUnlocked(ctx, host, missing); err != nil {
				return err
			}
			position = missing[len(missing)-1].Seq
		}
		if err := e.Bus.Import(ctx, fact); err != nil {
			return err
		}
		if err := e.Tasks.Observe(ctx, fact); err != nil {
			return err
		}
		if err := e.indexCloudFact(ctx, host, fact); err != nil {
			return err
		}
		if fact.Type == group.MemberAnswered {
			answer, err := event.Decode[group.MemberAnswer](fact)
			if err != nil {
				return err
			}
			e.answerDeviceQuestion(ctx, protocol.DeviceAnswer{QuestionReplyParams: protocol.QuestionReplyParams{Request: fact.Cause, Text: answer.Text}})
		}
	}
	return nil
}

func (e *Engine) publishCloudLive(ctx context.Context, link cloud.Link, live <-chan event.Event, stopLive func()) {
	defer func() { stopLive() }()
	for {
		select {
		case <-ctx.Done():
			return
		case fact, ok := <-live:
			if !ok || fact.Type == event.Lagged {
				stopLive()
				live, stopLive = e.Bus.Subscribe(event.Filter{Types: []event.Type{"message.delta"}})
				continue
			}
			if !e.currentCloudGroup(ctx, fact.Scope.Group) || !event.Transient(fact.Type) {
				continue
			}
			doc, err := e.store.Fetch(ctx, "cloud-stream", string(fact.Stream))
			e.cloudMu.Lock()
			account := cloud.Identity(e.cloudCredentials)
			e.cloudMu.Unlock()
			if err != nil || doc.Meta["host"] != account {
				continue
			}
			request, stop := context.WithTimeout(ctx, time.Second)
			projected, err := e.cloudEvent(request, fact)
			if err == nil {
				_ = link.Publish(request, []event.Event{projected})
			}
			stop()
		}
	}
}

func (e *Engine) publishCloud(ctx context.Context, link cloud.Link) {
	timer := time.NewTicker(250 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-e.cloudWake:
		}
		request, stop := context.WithTimeout(ctx, 3*time.Second)
		_ = e.flushCloud(request, link)
		stop()
	}
}

// flushCloud advances each durable cursor only after the host acknowledges it.
func (e *Engine) flushCloud(ctx context.Context, link cloud.Link) error {
	e.cloudPublishMu.Lock()
	defer e.cloudPublishMu.Unlock()
	streams, err := e.store.List(ctx, "cloud-stream", "")
	if err != nil {
		return err
	}
	e.cloudMu.Lock()
	account := cloud.Identity(e.cloudCredentials)
	e.cloudMu.Unlock()
	for _, meta := range streams {
		if meta.Meta["host"] != account {
			continue
		}
		doc, err := e.store.Fetch(ctx, meta.Kind, meta.Key)
		if err != nil {
			return err
		}
		var sequence uint64
		if err = json.Unmarshal(doc.Body, &sequence); err != nil {
			return err
		}
		for {
			facts, err := e.store.Read(ctx, event.Stream(meta.Key), sequence+1, 128)
			if err != nil {
				return err
			}
			if len(facts) == 0 {
				break
			}
			projected := make([]event.Event, len(facts))
			for i, fact := range facts {
				projected[i], err = e.cloudEvent(ctx, fact)
				if err != nil {
					return err
				}
			}
			if err = link.Publish(ctx, projected); err != nil {
				return err
			}
			sequence = facts[len(facts)-1].Seq
			doc.Body, _ = json.Marshal(sequence)
			if err = e.store.Put(ctx, doc); err != nil {
				return err
			}
			doc.Rev++
		}
	}
	return nil
}
