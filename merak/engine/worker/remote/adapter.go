package remote

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type Runner struct {
	Source      agent.RemoteSource
	Bus         *event.Bus
	Store       store.Store
	Credentials func(context.Context) (protocol.RemoteConnectParams, error)
	Import      func(context.Context, event.Event) error
	Reply       func(context.Context, event.Event) (protocol.RemoteControlParams, error)
}

func (r *Runner) Caps() worker.Caps { return r.Source.Caps }

func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	if a.Scope.Group == "" || a.Scope.Task == "" || a.Session == "" || a.Claim.ID == "" {
		return nil, errors.New("remote members require a group claim")
	}
	run, err := worker.Launch(ctx, r.Bus, a, func(ctx context.Context, input <-chan loop.Input) (task.Report, error) {
		report, err := r.execute(ctx, a, input)
		if stop, failure := worker.Termination(ctx, err, loop.Answered); loop.BudgetStop(stop) {
			return worker.ReportFromText(a.Claim.ID, "Task budget exhausted.", stop, failure), failure
		}
		if err != nil && report.Claim == "" {
			report = worker.SynthesizeReport(a.Claim.ID, "Remote execution could not finish.", loop.Failed, err)
		}
		return report, err
	})
	if err != nil {
		return nil, err
	}
	return &remoteRun{Run: run, steer: r.Source.Caps.Steer}, nil
}

type remoteRun struct {
	worker.Run
	steer bool
}

func (r *remoteRun) Send(ctx context.Context, input loop.Input) error {
	if !r.steer {
		return worker.ErrUnsupported
	}
	return r.Run.Send(ctx, input)
}

func (r *Runner) execute(ctx context.Context, a worker.Assignment, inputs <-chan loop.Input) (task.Report, error) {
	ctx, cancel := context.WithCancel(ctx)
	var handlers sync.WaitGroup
	defer func() { cancel(); handlers.Wait() }()
	failures := make(chan error, 1)
	handled := make(map[event.ID]bool)
	creds, err := r.Credentials(ctx)
	if err != nil {
		return task.Report{}, err
	}
	handshake, stop := context.WithTimeout(ctx, 10*time.Second)
	client, err := protocol.Connect(handshake, creds.Endpoint, creds.Token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "merak-remote"}})
	stop()
	if err != nil {
		return task.Report{}, err
	}
	defer client.Close()
	groupStream := event.Stream("group:" + a.Scope.Group)
	updates, unsubscribe := r.Bus.Subscribe(event.Filter{Streams: []event.Stream{groupStream}})
	defer unsubscribe()
	facts, err := r.Store.Read(ctx, groupStream, 1, 0)
	if err != nil {
		return task.Report{}, err
	}
	for _, fact := range facts {
		if fact.Type == task.Started && fact.Scope.Task == a.Scope.Task {
			a.Cause = fact.ID
		}
	}
	if err := r.sync(ctx, client, a.Scope.Group, facts); err != nil {
		return task.Report{}, err
	}
	var synced uint64
	if len(facts) > 0 {
		synced = facts[len(facts)-1].Seq
	}
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Group: a.Scope.Group}}, nil); err != nil {
		return task.Report{}, err
	}
	params := protocol.RemoteStartParams{Host: r.Source.Connection, Assignment: protocol.DeviceAssignment{Cause: a.Cause, SourceGroup: r.Source.Group, Member: r.Source.Member, Claim: a.Claim, Session: a.Session, Scope: a.Scope, Packet: a.Packet}}
	var started protocol.RemoteStartResult
	if err := client.Call(ctx, "remote.start", params, &started); err != nil {
		return task.Report{}, err
	}
	for _, id := range started.Answered {
		handled[id] = true
	}
	var consume func(event.Event) (task.Report, bool, error)
	consume = func(fact event.Event) (task.Report, bool, error) {
		if fact.Scope.Group != a.Scope.Group {
			return task.Report{}, false, errors.New("remote event is outside the assigned group")
		}
		if fact.Stream == event.Stream("group:"+a.Scope.Group) {
			if _, err := r.Store.Get(ctx, fact.ID); err != nil {
				return task.Report{}, false, errors.New("remote member cannot append to the host group stream")
			}
			return task.Report{}, false, nil
		} else if fact.Stream != event.Stream("session:"+a.Session) && fact.Stream != event.Stream("device:remote:"+r.Source.Connection+":group:"+a.Scope.Group) {
			return task.Report{}, false, nil
		}
		for !event.Transient(fact.Type) && fact.Seq > r.Bus.Position(fact.Stream)+1 {
			from := r.Bus.Position(fact.Stream) + 1
			var missing []event.Event
			if err := client.Call(ctx, "events.read", protocol.EventsReadParams{Stream: fact.Stream, From: from, Limit: int(min(128, fact.Seq-from))}, &missing); err != nil {
				return task.Report{}, false, err
			}
			if len(missing) == 0 {
				return task.Report{}, false, errors.New("remote event history has a gap")
			}
			for _, prior := range missing {
				if prior.Stream != fact.Stream || prior.Seq != from || prior.Seq >= fact.Seq {
					return task.Report{}, false, errors.New("invalid remote event history")
				}
				if report, done, err := consume(prior); done || err != nil {
					return report, done, err
				}
				from++
			}
		}
		if err := r.Import(ctx, fact); err != nil {
			return task.Report{}, false, err
		}
		if !started.Completed && fact.Seq > started.Cursors[fact.Stream] && fact.Scope.Session == a.Session && (fact.Type == permission.Requested || fact.Type == question.Asked || fact.Type == "member.asked" || fact.Type == protocol.RemoteLookupRequested) && !handled[fact.ID] && r.Reply != nil {
			handled[fact.ID] = true
			handlers.Go(func() {
				reply, err := r.Reply(ctx, fact)
				if err == nil {
					err = client.Call(ctx, "remote.control", reply, nil)
				}
				if err != nil {
					select {
					case failures <- err:
					default:
					}
				}
			})
		}
		if fact.Scope.Session != a.Session || fact.Cause != a.Cause {
			return task.Report{}, false, nil
		}
		if fact.Type == "claim.reported" {
			report, err := event.Decode[task.Report](fact)
			return report, true, err
		}
		if fact.Type == "claim.interrupted" {
			return worker.ReportFromText(a.Claim.ID, "Remote execution was interrupted.", loop.Cancelled, context.Canceled), true, context.Canceled
		}
		return task.Report{}, false, nil
	}
	finish := func(report task.Report, finished bool, failure error) (task.Report, error) {
		if !finished {
			return report, failure
		}
		started.Completed = true
		stream := event.Stream("device:remote:" + r.Source.Connection + ":group:" + a.Scope.Group)
		from := r.Bus.Position(stream) + 1
		for {
			var facts []event.Event
			if err := client.Call(ctx, "events.read", protocol.EventsReadParams{Stream: stream, From: from, Limit: 128}, &facts); err != nil {
				return report, errors.Join(failure, err)
			}
			for _, fact := range facts {
				if fact.Stream != stream || fact.Seq != from {
					return report, errors.New("invalid remote completion history")
				}
				if _, _, err := consume(fact); err != nil {
					return report, errors.Join(failure, err)
				}
				from++
			}
			if len(facts) < 128 {
				return report, failure
			}
		}
	}
	for _, stream := range []event.Stream{event.Stream("session:" + a.Session), event.Stream("device:remote:" + r.Source.Connection + ":group:" + a.Scope.Group)} {
		cursor, exists := started.Cursors[stream]
		if !exists {
			return task.Report{}, errors.New("MRK-1003")
		}
		if r.Bus.Position(stream) == 0 {
			prior, err := r.Store.Read(ctx, stream, 1, 0)
			if err != nil {
				return task.Report{}, err
			}
			if len(prior) > 0 {
				r.Bus.Resume(stream, prior[len(prior)-1].Seq)
			}
		}
		from := cursor + 1
		for {
			var missing []event.Event
			if err := client.Call(ctx, "events.read", protocol.EventsReadParams{Stream: stream, From: from, Limit: 128}, &missing); err != nil {
				return task.Report{}, err
			}
			for _, fact := range missing {
				if report, finished, err := consume(fact); finished || err != nil {
					return finish(report, finished, err)
				}
				from = fact.Seq + 1
			}
			if len(missing) < 128 {
				break
			}
		}
	}
	for {
		select {
		case fact, ok := <-updates:
			if !ok {
				return task.Report{}, errors.New("MRK-1001")
			}
			if fact.Seq <= synced {
				continue
			}
			facts, err := r.Store.Read(ctx, groupStream, synced+1, 0)
			if err != nil {
				return task.Report{}, err
			}
			if err := r.sync(ctx, client, a.Scope.Group, facts); err != nil {
				return task.Report{}, err
			}
			if len(facts) > 0 {
				synced = facts[len(facts)-1].Seq
			}
		case err := <-failures:
			return task.Report{}, err
		case <-ctx.Done():
			ending, stop := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
			_ = client.Call(ending, "remote.control", protocol.RemoteControlParams{Cancel: &a.Claim.ID}, nil)
			stop()
			return worker.ReportFromText(a.Claim.ID, "Remote execution was interrupted.", loop.Cancelled, ctx.Err()), ctx.Err()
		case input := <-inputs:
			if !r.Source.Caps.Steer {
				return task.Report{}, worker.ErrUnsupported
			}
			if err := client.Call(ctx, "remote.control", protocol.RemoteControlParams{Message: &protocol.DeviceMessage{Claim: a.Claim.ID, Input: input}}, nil); err != nil {
				return task.Report{}, err
			}
		case fact, ok := <-client.Events:
			if !ok {
				return task.Report{}, errors.New("MRK-1001")
			}
			if report, finished, err := consume(fact); finished || err != nil {
				return finish(report, finished, err)
			}
		}
	}
}

func (r *Runner) sync(ctx context.Context, client *protocol.Client, group event.ID, facts []event.Event) error {
	for len(facts) > 0 {
		size, count := 0, 0
		for count < len(facts) && count < 128 {
			body, err := json.Marshal(facts[count])
			if err != nil {
				return err
			}
			if size+len(body) > 7<<19 {
				break
			}
			size += len(body)
			count++
		}
		if count == 0 {
			return errors.New("MRK-1003")
		}
		if err := client.Call(ctx, "remote.sync", protocol.RemoteSyncParams{Host: r.Source.Connection, Group: group, Events: facts[:count]}, nil); err != nil {
			return err
		}
		facts = facts[count:]
	}
	return nil
}
