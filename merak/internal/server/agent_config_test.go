package server_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestTheAgentSectionAndDefaultAgentOfTheConfigurationFileReachTheEngine(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	home := t.TempDir()
	text := `{
  "model": "fake/main",
  "small_model": "fake/small",
  "default_agent": "reviewer",
  "agent": {
    "reviewer": { "model": "fake/review-model", "prompt": "Only review." },
    "title": { "model": "fake/titler" }
  }
}
`
	if err := os.WriteFile(filepath.Join(home, "merakcode.jsonc"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := fake.New(t,
		fake.Reply{Text: "Reviewed.", Expect: func(req model.Request) error {
			if req.Model != "review-model" {
				return fmt.Errorf("model = %q, want the model of the default agent", req.Model)
			}
			return nil
		}},
		fake.Reply{Text: "Review title", Expect: func(req model.Request) error {
			if req.Model != "titler" {
				return fmt.Errorf("the title was written by %q, want the title agent's model", req.Model)
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var got protocol.Config
	if err := client.Call(ctx, "config.get", struct{}{}, &got); err != nil || got.DefaultAgent != "reviewer" || got.Agents["reviewer"].Prompt != "Only review." {
		t.Fatalf("config = %+v, err = %v", got, err)
	}
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Workdir: home}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Review the parser"}}}, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var list []session.Info
		if err := client.Call(ctx, "session.list", protocol.SessionListParams{}, &list); err == nil && len(list) == 1 && list[0].Title == "Review title" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the conversation was never titled by the title agent")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
