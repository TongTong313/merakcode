package feature_test

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/window"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestInjectedCatalogControlsBudgetAndCost(t *testing.T) {
	limit, output := 24000, 16000
	c := catalog.New(catalog.Options{Overrides: []catalog.Override{{Provider: "fake", ID: "custom", Window: &limit, MaxOutput: &output, Price: &catalog.Price{Input: 2, Output: 10, Currency: "USD"}}}})
	storage := memory.New()
	deps := enginetest.Deps(t)
	deps.Catalog = c
	deps.Store = storage
	deps.Model = "custom"
	deps.Workdir = t.TempDir()
	deps.Providers = map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Done", Usage: &model.Usage{Input: 1000000, Output: 100000}})}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	result, err := e.Chat(context.Background(), "fake", "Hello")
	if err != nil || result.Usage.Cost != 3 {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	facts, err := storage.Find(context.Background(), store.Query{Types: []event.Type{window.BudgetReported}})
	if err != nil || len(facts) != 1 {
		t.Fatalf("facts=%v error=%v", facts, err)
	}
	report, err := event.Decode[window.Report](facts[0])
	if err != nil || report.Window != 24000 || report.Reserve != 8192 {
		t.Fatalf("budget=%+v error=%v", report, err)
	}
}
