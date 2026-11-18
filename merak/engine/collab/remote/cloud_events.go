package remote

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Remote) DeviceStream(fact event.Event) event.Stream {
	if _, ok := domain.roster.HostedGroup(fact.Scope.Group); !ok || fact.Stream != event.Stream("group:"+fact.Scope.Group) {
		return fact.Stream
	}
	device := "unavailable"
	if host := domain.deviceHostForGroup(fact.Scope.Group); host != nil {
		device = host.device
	}
	return event.Stream("device:" + device + ":group:" + string(fact.Scope.Group))
}

func (domain *Remote) ownCloudStream(ctx context.Context, stream event.Stream) error {
	domain.cloudMu.Lock()
	account := wire.Identity(domain.cloudCredentials)
	domain.cloudMu.Unlock()
	return domain.ownDeviceStream(ctx, stream, account)
}

func (domain *Remote) ownDeviceStream(ctx context.Context, stream event.Stream, account string) error {
	doc, err := domain.core.Store.Fetch(ctx, "cloud-stream", string(stream))
	if err == nil {
		if doc.Meta["host"] != account {
			return wire.ErrNoCloud
		}
		return store.ResumeStream(ctx, domain.core.Bus, domain.core.Store, stream)
	}
	if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	err = domain.core.Store.Put(ctx, store.Doc{Kind: "cloud-stream", Key: string(stream), Rev: doc.Rev, Body: json.RawMessage(`0`), Meta: map[string]string{"host": account}})
	if errors.Is(err, store.ErrConflict) {
		return domain.ownDeviceStream(ctx, stream, account)
	}
	return err
}

func (domain *Remote) receiveCloud(ctx context.Context, link wire.Link) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-domain.core.Ctx.Done():
			return
		case incoming, ok := <-link.Inbound():
			if !ok {
				return
			}
			if err := domain.importCloud(ctx, incoming.Events); err != nil {
				if domain.core.Logger != nil {
					domain.core.Logger.Warn("Cloud event import failed", "code", "MRK-1007")
				}
				continue
			}
			if incoming.Reply != nil {
				domain.answerDevicePermission(*incoming.Reply)
			}
			if incoming.QuestionReply != nil {
				domain.answerDeviceQuestion(ctx, *incoming.QuestionReply)
			}
			if incoming.Notice != nil && domain.CurrentCloudGroup(ctx, incoming.Scope.Group) {
				body, _ := json.Marshal(incoming.Notice)
				domain.cloudMu.Lock()
				account := wire.Identity(domain.cloudCredentials)
				host := domain.cloudHost
				domain.cloudMu.Unlock()
				if host == nil {
					continue
				}
				if incoming.Cause != "" {
					host.imports.Lock()
					err := domain.indexCloudReference(ctx, host, "event:"+string(incoming.Cause), incoming.Scope.Group)
					host.imports.Unlock()
					if err != nil {
						continue
					}
				}
				stream := event.Stream("inbox:" + account)
				if domain.core.Bus.Position(stream) == 0 {
					facts, err := domain.core.Store.Read(ctx, stream, 1, 0)
					if err != nil {
						continue
					}
					if len(facts) > 0 {
						domain.core.Bus.Resume(stream, facts[len(facts)-1].Seq)
					}
				}
				_, _ = domain.core.Bus.Publish(ctx, event.Event{Stream: stream, Scope: incoming.Scope, Cause: incoming.Cause, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorExternal}, Payload: body})
			}
			if incoming.Assignment != nil {
				domain.startDeviceAssignment(*incoming.Assignment)
			}
			if incoming.Cancel != nil {
				domain.cancelDeviceClaim(ctx, *incoming.Cancel)
			}
			if incoming.Message != nil {
				domain.sendDeviceMessage(ctx, *incoming.Message)
			}
			if incoming.ToolCall != nil {
				domain.startDeviceTool(*incoming.ToolCall)
			}
		}
	}
}

func (domain *Remote) importCloud(ctx context.Context, facts []event.Event) error {
	domain.cloudMu.Lock()
	host := domain.cloudHost
	domain.cloudMu.Unlock()
	return domain.importCloudFrom(ctx, host, facts)
}

func (domain *Remote) importCloudFrom(ctx context.Context, host *deviceHost, facts []event.Event) error {
	if host == nil {
		return wire.ErrNoCloud
	}
	host.imports.Lock()
	defer host.imports.Unlock()
	domain.cloudMu.Lock()
	current := domain.cloudHost == host
	domain.cloudMu.Unlock()
	if !current {
		return wire.ErrNoCloud
	}
	return domain.importCloudUnlocked(ctx, host, facts)
}

func (domain *Remote) importCloudUnlocked(ctx context.Context, host *deviceHost, facts []event.Event) error {
	for _, fact := range facts {
		if fact.Scope.Group == "" {
			return errors.New("cloud event requires a group")
		}
		if owner, known := domain.roster.HostedGroup(fact.Scope.Group); known && owner != host.id {
			return wire.ErrNoCloud
		}
		if prior, err := domain.core.Store.Get(ctx, fact.ID); err == nil {
			if prior.Stream != fact.Stream || prior.Seq != fact.Seq {
				return store.ErrConflict
			}
			if err := domain.indexCloudFact(ctx, host, fact); err != nil {
				return err
			}
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if _, ok := domain.roster.HostedGroup(fact.Scope.Group); !ok {
			if fact.Type != group.Created {
				params, _ := json.Marshal(wire.EventsReadParams{Stream: event.Stream("group:" + fact.Scope.Group), From: 1, Limit: 1})
				body, err := domain.forwardFromHost(ctx, host, "events.read", params)
				if err != nil {
					return err
				}
				var first []event.Event
				if json.Unmarshal(body, &first) != nil || len(first) != 1 || first[0].Type != group.Created || first[0].Scope.Group != fact.Scope.Group || first[0].Stream != event.Stream("group:"+fact.Scope.Group) || first[0].Seq != 1 {
					return wire.ErrUnavailable
				}
				if err := domain.importCloudUnlocked(ctx, host, first); err != nil {
					return err
				}
				if err := domain.importCloudUnlocked(ctx, host, []event.Event{fact}); err != nil {
					return err
				}
				continue
			}
			state, err := event.Decode[group.State](fact)
			if err != nil || state.Group.Kind != group.KindCloud || state.Group.ID != fact.Scope.Group {
				return errors.New("invalid cloud group")
			}
			if _, err = domain.groups.Get(ctx, fact.Scope.Group); !errors.Is(err, store.ErrNotFound) {
				return store.ErrConflict
			}
			account := host.id
			doc, fetchErr := domain.core.Store.Fetch(ctx, "cloud-group", string(fact.Scope.Group))
			if fetchErr != nil && !errors.Is(fetchErr, store.ErrNotFound) {
				return fetchErr
			}
			if fetchErr == nil && doc.Meta["host"] != account {
				return wire.ErrNoCloud
			}
			body, _ := json.Marshal(state.Group)
			if err := domain.core.Store.Put(ctx, store.Doc{Kind: "cloud-group", Key: string(fact.Scope.Group), Rev: doc.Rev, Body: body, Meta: map[string]string{"host": account}}); err != nil {
				return err
			}
			domain.roster.HostGroup(fact.Scope.Group, account)
		}
		deviceStream := strings.HasPrefix(string(fact.Stream), "device:") && strings.HasSuffix(string(fact.Stream), ":group:"+string(fact.Scope.Group))
		if fact.Stream != event.Stream("group:"+fact.Scope.Group) && !strings.HasPrefix(string(fact.Stream), "session:") && !deviceStream {
			return errors.New("invalid cloud stream")
		}
		if _, err := domain.core.Store.Fetch(ctx, "cloud-stream", string(fact.Stream)); err == nil {
			if event.Transient(fact.Type) {
				continue
			}
			return errors.New("host cannot append to a device-owned stream")
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		position := domain.core.Bus.Position(fact.Stream)
		if position == 0 {
			cached, err := domain.core.Store.Read(ctx, fact.Stream, 1, 0)
			if err != nil {
				return err
			}
			if len(cached) > 0 {
				if cached[0].Scope.Group != fact.Scope.Group {
					return store.ErrConflict
				}
				position = cached[len(cached)-1].Seq
				domain.core.Bus.Resume(fact.Stream, position)
			}
		}
		for !event.Transient(fact.Type) && fact.Seq > position+1 {
			params, _ := json.Marshal(wire.EventsReadParams{Stream: fact.Stream, From: position + 1, Limit: int(min(fact.Seq-position-1, 128))})
			body, err := domain.forwardFromHost(ctx, host, "events.read", params)
			if err != nil {
				return err
			}
			var missing []event.Event
			if json.Unmarshal(body, &missing) != nil || len(missing) == 0 {
				return wire.ErrUnavailable
			}
			for index, item := range missing {
				if item.Stream != fact.Stream || item.Scope.Group != fact.Scope.Group || item.Seq != position+1+uint64(index) || item.Seq >= fact.Seq {
					return wire.ErrUnavailable
				}
			}
			if err = domain.importCloudUnlocked(ctx, host, missing); err != nil {
				return err
			}
			position = missing[len(missing)-1].Seq
		}
		if err := domain.core.Bus.Import(ctx, fact); err != nil {
			return err
		}
		if err := domain.tasks.Observe(ctx, fact); err != nil {
			return err
		}
		if err := domain.indexCloudFact(ctx, host, fact); err != nil {
			return err
		}
		if fact.Type == group.MemberAnswered {
			answer, err := event.Decode[group.MemberAnswer](fact)
			if err != nil {
				return err
			}
			domain.answerDeviceQuestion(ctx, wire.DeviceAnswer{QuestionReplyParams: wire.QuestionReplyParams{Request: fact.Cause, Text: answer.Text}})
		}
	}
	return nil
}

func (domain *Remote) publishCloudLive(ctx context.Context, link wire.Link, live <-chan event.Event, stopLive func()) {
	defer func() { stopLive() }()
	for {
		select {
		case <-ctx.Done():
			return
		case fact, ok := <-live:
			if !ok || fact.Type == event.Lagged {
				stopLive()
				live, stopLive = domain.core.Bus.Subscribe(event.Filter{Types: []event.Type{"message.delta"}})
				continue
			}
			if !domain.CurrentCloudGroup(ctx, fact.Scope.Group) || !event.Transient(fact.Type) {
				continue
			}
			doc, err := domain.core.Store.Fetch(ctx, "cloud-stream", string(fact.Stream))
			domain.cloudMu.Lock()
			account := wire.Identity(domain.cloudCredentials)
			domain.cloudMu.Unlock()
			if err != nil || doc.Meta["host"] != account {
				continue
			}
			request, stop := context.WithTimeout(ctx, time.Second)
			projected, err := domain.cloudEvent(request, fact)
			if err == nil {
				_ = link.Publish(request, []event.Event{projected})
			}
			stop()
		}
	}
}

func (domain *Remote) publishCloud(ctx context.Context, link wire.Link) {
	timer := time.NewTicker(250 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-domain.cloudWake:
		}
		request, stop := context.WithTimeout(ctx, 3*time.Second)
		_ = domain.flushCloud(request, link)
		stop()
	}
}

// flushCloud advances each durable cursor only after the host acknowledges it.
func (domain *Remote) flushCloud(ctx context.Context, link wire.Link) error {
	domain.cloudPublishMu.Lock()
	defer domain.cloudPublishMu.Unlock()
	streams, err := domain.core.Store.List(ctx, "cloud-stream", "")
	if err != nil {
		return err
	}
	domain.cloudMu.Lock()
	account := wire.Identity(domain.cloudCredentials)
	domain.cloudMu.Unlock()
	for _, meta := range streams {
		if meta.Meta["host"] != account {
			continue
		}
		doc, err := domain.core.Store.Fetch(ctx, meta.Kind, meta.Key)
		if err != nil {
			return err
		}
		var sequence uint64
		if err = json.Unmarshal(doc.Body, &sequence); err != nil {
			return err
		}
		for {
			facts, err := domain.core.Store.Read(ctx, event.Stream(meta.Key), sequence+1, 128)
			if err != nil {
				return err
			}
			if len(facts) == 0 {
				break
			}
			projected := make([]event.Event, len(facts))
			for i, fact := range facts {
				projected[i], err = domain.cloudEvent(ctx, fact)
				if err != nil {
					return err
				}
			}
			if err = link.Publish(ctx, projected); err != nil {
				return err
			}
			sequence = facts[len(facts)-1].Seq
			doc.Body, _ = json.Marshal(sequence)
			if err = domain.core.Store.Put(ctx, doc); err != nil {
				return err
			}
			doc.Rev++
		}
	}
	return nil
}
