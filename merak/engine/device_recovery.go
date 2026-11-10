package engine

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

// recoverDeviceRuns reports an abandoned execution; only the host may assign it again.
func (e *Engine) recoverDeviceRuns(ctx context.Context, account string) error {
	docs, err := e.store.List(ctx, "device-run", "")
	if err != nil {
		return err
	}
	for _, meta := range docs {
		doc, err := e.store.Fetch(ctx, meta.Kind, meta.Key)
		if err != nil {
			return err
		}
		var record deviceRecord
		if err := json.Unmarshal(doc.Body, &record); err != nil {
			return err
		}
		if record.Account != account || record.Status != task.ClaimActive {
			continue
		}
		a := record.Assignment
		stream := event.Stream("session:" + a.Session)
		facts, err := e.store.Read(ctx, stream, 1, 0)
		if err != nil {
			return err
		}
		if len(facts) > 0 {
			e.Bus.Resume(stream, facts[len(facts)-1].Seq)
		}
		if err := e.ownDeviceStream(ctx, stream, account); err != nil {
			return err
		}
		for _, fact := range facts {
			if fact.Cause != a.Cause {
				continue
			}
			switch fact.Type {
			case DeviceReported:
				record.Status = task.ClaimReported
			case DeviceInterrupted:
				record.Status = task.ClaimInterrupted
			}
		}
		if record.Status == task.ClaimActive {
			claim := a.Claim
			claim.Status = task.ClaimInterrupted
			body, _ := json.Marshal(claim)
			if _, err := e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: a.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Type: DeviceInterrupted, Cause: a.Cause, Payload: body}); err != nil {
				return err
			}
			record.Status = task.ClaimInterrupted
		}
		leases, err := e.store.List(ctx, "workspace", "")
		if err != nil {
			return err
		}
		for _, lease := range leases {
			ws, err := e.Workspaces.Get(ctx, event.ID(lease.Key))
			if err != nil {
				return err
			}
			if ws.Claim == a.Claim.ID && ws.Active {
				e.hostedGroups.Store(a.Scope.Group, account)
				if err := e.ownDeviceStream(ctx, e.deviceStream(event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope}), account); err != nil {
					return err
				}
				if err := e.Workspaces.EndClaim(ctx, ws); err != nil {
					return err
				}
			}
		}
		doc.Body, _ = json.Marshal(record)
		if err := e.store.Put(ctx, doc); err != nil {
			return err
		}
	}
	return nil
}
