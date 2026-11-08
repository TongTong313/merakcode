package engine_test

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

func TestChatPersistsPricedUsageForReplay(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":100,\"prompt_tokens_details\":{\"cached_tokens\":200}}}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	config, _ := openai.Builtin("zhipu")
	e, err := engine.New(engine.Deps{Model: "glm-5.3", Workdir: t.TempDir(), Providers: map[string]model.Provider{"zhipu": openai.New(openai.Options{BaseURL: server.URL, Config: config})}})
	if err != nil {
		t.Fatal(err)
	}
	events, stop := e.Bus.Subscribe(event.Filter{})
	outcome, err := e.Chat(context.Background(), "zhipu", "Begin")
	if err != nil {
		t.Fatal(err)
	}
	stop()
	var replay session.State
	for fact := range events {
		if err := session.Fold(&replay, fact); err != nil {
			t.Fatal(err)
		}
	}
	if outcome.Usage != replay.Usage || math.Abs(replay.Usage.Cost-0.0096) > 1e-12 {
		t.Fatalf("outcome=%+v replay=%+v", outcome.Usage, replay.Usage)
	}
}
