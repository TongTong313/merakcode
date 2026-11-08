package model_test

import (
	"github.com/TongTong313/merakcode/merak/engine/model"
	"testing"
)

func TestEmptyUsageDoesNotEraseKnownCost(t *testing.T) {
	known := model.Usage{Input: 20, Output: 5, Cost: .03, CostKnown: true, Currency: "USD"}
	if result := known.Add(model.Usage{}); result != known {
		t.Fatalf("empty usage erased price: %+v", result)
	}
	if result := (model.Usage{}).Add(known); result != known {
		t.Fatalf("first usage lost price: %+v", result)
	}
	if result := known.Add(model.Usage{Input: 1}); result.CostKnown || result.Cost != 0 {
		t.Fatalf("unpriced tokens gained a price: %+v", result)
	}
}
