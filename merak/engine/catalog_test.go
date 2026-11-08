package engine_test

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

func TestInjectedCatalogControlsBudgetAndCost(t *testing.T) {
	limit, output := 24000, 16000
	c := catalog.New(catalog.Options{Overrides: []catalog.Override{{Provider: "fake", ID: "custom", Window: &limit, MaxOutput: &output, Price: &catalog.Price{Input: 2, Output: 10, Currency: "USD"}}}})
	storage := memory.New()
	e, err := engine.New(engine.Deps{Catalog: c, Store: storage, Model: "custom", Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Done", Usage: &model.Usage{Input: 1000000, Output: 100000}})}})
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
