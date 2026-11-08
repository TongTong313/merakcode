package catalog_test

import (
	"math"
	"reflect"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

func TestCatalogResolvesBuiltinRelayAndUnknownModels(t *testing.T) {
	c := catalog.New()
	known := c.Get("zhipu", "glm-5.3")
	if known.Window != 1000000 || known.MaxOutput != 131072 || known.Source != "builtin" || known.Price.Currency != "CNY" {
		t.Fatalf("model=%+v", known)
	}
	usage := known.Price.Apply(model.Usage{Input: 1000, CacheRead: 200, Output: 100})
	if math.Abs(usage.Cost-0.0096) > 1e-12 || !usage.CostKnown || usage.Currency != "CNY" {
		t.Fatalf("usage=%+v", usage)
	}
	relay := c.Get("relay", "zhipu/glm-5.3")
	if relay.Provider != "relay" || relay.ID != "zhipu/glm-5.3" || relay.Window != known.Window || !reflect.DeepEqual(relay.Thinking, known.Thinking) {
		t.Fatalf("relay=%+v", relay)
	}
	unknown := c.Get("local", "custom-model")
	if unknown.Source != "unknown" || unknown.Window != 128000 || unknown.MaxOutput != 8192 || unknown.Price.Apply(model.Usage{Input: 100}).CostKnown {
		t.Fatalf("unknown=%+v", unknown)
	}
	for _, test := range []struct{ input, want model.Thinking }{
		{model.ThinkingOff, model.ThinkingLow}, {model.ThinkingLow, model.ThinkingLow},
		{model.ThinkingMedium, model.ThinkingLow}, {model.ThinkingHigh, model.ThinkingHigh},
		{model.ThinkingXHigh, model.ThinkingHigh}, {model.ThinkingMax, model.ThinkingMax},
	} {
		if got := known.Clamp(test.input); got != test.want {
			t.Errorf("Clamp(%s)=%s want=%s", test.input, got, test.want)
		}
	}
	known.Thinking[0] = model.ThinkingOff
	if c.Get("zhipu", "glm-5.3").Thinking[0] != model.ThinkingLow {
		t.Fatal("caller changed the catalog")
	}
}

func TestCatalogIncludesCompatibleProvidersAndPricesLongRequests(t *testing.T) {
	c := catalog.New()
	for _, test := range []struct {
		provider, id   string
		window, output int
	}{
		{"openai", "gpt-5", 400000, 128000},
		{"deepseek", "deepseek-flash", 1000000, 384000},
		{"moonshot", "kimi-k2.6", 262144, 8192},
		{"zhipu", "glm-4.7", 200000, 131072},
		{"dashscope", "qwen3.5-plus", 1000000, 65536},
	} {
		m := c.Get(test.provider, test.id)
		if m.Source != "builtin" || m.Window != test.window || m.MaxOutput != test.output || len(m.Thinking) == 0 {
			t.Errorf("model=%+v", m)
		}
	}
	for _, test := range []struct {
		id            string
		input, output int
		cost          float64
	}{
		{"qwen3.5-plus", 128000, 1000, 0.1072},
		{"qwen3.5-plus", 128001, 1000, 0.268002},
		{"qwen3.5-plus", 256001, 1000, 1.048004},
		{"glm-4.7", 10000, 100, 0.0208},
		{"glm-4.7", 10000, 200, 0.0328},
		{"glm-4.7", 32000, 200, 0.1312},
	} {
		priced := c.Get("relay", test.id).Price.Apply(model.Usage{Input: test.input, Output: test.output})
		if !priced.CostKnown || math.Abs(priced.Cost-test.cost) > 1e-10 {
			t.Errorf("%s usage=%+v want=%f", test.id, priced, test.cost)
		}
	}
}
