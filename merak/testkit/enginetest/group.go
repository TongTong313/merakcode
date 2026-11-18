package enginetest

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
)

type GroupScript struct {
	ProviderName string
	Reply        func(model.Request) fake.Reply
	Test         *testing.T
}

func (p GroupScript) Name() string { return p.ProviderName }

func (p GroupScript) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	return fake.New(p.Test, p.Reply(req)).Stream(ctx, req)
}
