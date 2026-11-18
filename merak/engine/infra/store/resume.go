package store

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// ResumeStream restores the last stored position of a stream that the bus has not resumed.
func ResumeStream(ctx context.Context, bus *event.Bus, storage Store, stream event.Stream) error {
	if bus.Position(stream) != 0 {
		return nil
	}
	facts, err := storage.Read(ctx, stream, 1, 0)
	if err != nil {
		return err
	}
	if len(facts) > 0 {
		bus.Resume(stream, facts[len(facts)-1].Seq)
	}
	return nil
}
