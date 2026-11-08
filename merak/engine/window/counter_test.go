package window_test

import (
	"math"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

func TestCounterStaysWithinSampleToleranceAndCalibratesPerModel(t *testing.T) {
	// Reference cl100k_base counts from the OpenAI token-counting cookbook.
	for _, sample := range []struct {
		name, text string
		tokens     int
	}{
		{"long English word", "antidisestablishmentarianism", 6},
		{"arithmetic", "2 + 2 = 4", 7},
		{"Japanese greeting", "\u304a\u8a95\u751f\u65e5\u304a\u3081\u3067\u3068\u3046", 9},
	} {
		t.Run(sample.name, func(t *testing.T) {
			got := window.EstimateText(sample.text)
			if math.Abs(float64(got-sample.tokens))/float64(sample.tokens) > .35 {
				t.Fatalf("estimate=%d reference=%d", got, sample.tokens)
			}
		})
	}
	counter := new(window.Counter)
	request := model.Request{Model: "one", System: "Rules", Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Inspect this file and explain the behavior."}}}}}
	before := counter.Estimate("provider", request)
	counter.Observe("provider", request, model.Usage{Input: before.Total * 2, CacheRead: before.Total})
	after := counter.Estimate("provider", request)
	if math.Abs(float64(after.Total-before.Total*2)) > 3 {
		t.Fatalf("calibrated=%+v baseline=%+v", after, before)
	}
	if got := counter.Estimate("other-provider", request); got.Total != before.Total {
		t.Fatal("calibration leaked across providers")
	}
	request.Model = "two"
	if got := counter.Estimate("provider", request); got.Total != before.Total {
		t.Fatal("calibration leaked across models")
	}
}

func TestCounterBudgetsImagesAndDocumentsIncludingToolResults(t *testing.T) {
	counter := new(window.Counter)
	for _, part := range []model.Part{
		{Image: &model.Image{MIME: "image/png", URL: "https://example.com/image.png"}},
		{Document: &model.Document{MIME: "text/plain", Name: "large.txt", Data: []byte(strings.Repeat("work ", 10000))}},
		{ToolResult: &model.ToolResult{CallID: "read", Parts: []model.Part{{Image: &model.Image{MIME: "image/png", URL: "https://example.com/image.png"}}}}},
	} {
		request := model.Request{Messages: []model.Message{{Role: model.User, Parts: []model.Part{part}}}}
		if estimate := counter.Estimate("test", request); estimate.Messages < 2000 {
			t.Fatalf("media omitted from budget: %+v", estimate)
		}
	}
}
