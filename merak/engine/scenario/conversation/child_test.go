package conversation_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	storage "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestParentContinuesWhileReadOnlyChildRunsAndReceivesItsReportOnce(t *testing.T) {
	release := make(chan struct{})
	var released sync.Once
	unblock := func() { released.Do(func() { close(release) }) }
	defer unblock()
	var parents, children atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		child := strings.Contains(string(request.Messages[0].Content), "You are a read-only child.")
		var delta any
		stop := "stop"
		if child {
			for _, spec := range request.Tools {
				if spec.Function.Name == "write_file" || spec.Function.Name == "spawn" || spec.Function.Name == "bash" {
					t.Errorf("child has forbidden tool %s", spec.Function.Name)
				}
			}
			if children.Add(1) == 1 {
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				delta = map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "forbidden", "type": "function", "function": map[string]string{"name": "write_file", "arguments": `{"path":"forbidden.txt","content":"no"}`}}}}
				stop = "tool_calls"
			} else {
				if !strings.Contains(string(request.Messages[len(request.Messages)-1].Content), "Unknown tool: write_file") {
					t.Error("child did not receive tool denial")
				}
				delta = map[string]any{"content": "Child report"}
			}
		} else {
			switch parents.Add(1) {
			case 1:
				delta = map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "spawn-one", "type": "function", "function": map[string]string{"name": "spawn", "arguments": `{"prompt":"Research child"}`}}}}
				stop = "tool_calls"
			case 2:
				delta = map[string]any{"content": "Parent continued"}
			case 3:
				body, _ := json.Marshal(request.Messages)
				if strings.Count(string(body), "Child report") != 1 {
					t.Error("child report is missing or duplicated")
				}
				delta = map[string]any{"content": "Parent received report"}
			default:
				t.Error("unexpected parent request")
				delta = map[string]any{"content": "Unexpected"}
			}
		}
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": stop}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", body)
	}))
	defer upstream.Close()
	dir := t.TempDir()
	durable := storage.New()
	deps := enginetest.Deps(t)
	deps.Store = durable
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"openai": openai.New(openai.Options{BaseURL: upstream.URL})}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "openai", Mode: permission.ModeTakeover, Member: "researcher", Scope: event.Scope{Task: "research"}})
	if err != nil {
		t.Fatal(err)
	}
	events, unsubscribe := e.Subscribe(event.Filter{Scope: event.Scope{Session: id}})
	defer unsubscribe()
	if err := e.Send(ctx, id, []model.Part{{Text: "Parent task"}}); err != nil {
		t.Fatal(err)
	}
	started, finished := 0, 0
	for {
		select {
		case fact := <-events:
			if fact.Type == session.ChildStarted {
				started++

			}
			if fact.Type == session.ChildFinished {
				finished++
				result, err := event.Decode[session.ChildResult](fact)
				if err != nil {
					t.Fatal(err)
				}
				child, err := e.SessionSnapshot(ctx, result.ID)
				if err != nil {
					t.Fatal(err)
				}
				if child.Config.Mode != permission.ModeTakeover || child.Config.Member != "researcher" || child.Scope.Task != "research" || child.Scope.Session != child.ID {
					t.Fatalf("child lost execution context: %+v", child)
				}
			}
			if fact.Type != session.MessageCompleted {
				continue
			}
			message, err := event.Decode[model.Message](fact)
			if err != nil {
				t.Fatal(err)
			}
			for _, part := range message.Parts {
				if part.Text == "Parent continued" {
					unblock()
				}
				if part.Text != "Parent received report" {
					continue
				}
				if started != 1 || finished != 1 {
					t.Fatalf("started=%d finished=%d", started, finished)
				}
				if _, err := os.Stat(filepath.Join(dir, "forbidden.txt")); !os.IsNotExist(err) {
					t.Fatal("read-only child wrote a file")
				}
				facts, err := durable.Read(ctx, event.Stream("session:"+id), 1, 0)
				if err != nil {
					t.Fatal(err)
				}
				var replay session.State
				for _, fact := range facts {
					if err := session.Fold(&replay, fact); err != nil {
						t.Fatal(err)
					}
				}
				body, _ := json.Marshal(replay.Messages)
				if strings.Count(string(body), "Child report") != 1 {
					t.Fatal("replay duplicated the child report")
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("parent did not progress while child was running")
		}
	}
}

func TestCancellingParentAlsoStopsItsBackgroundChild(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	var parents atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		if strings.Contains(request.Messages[0].Content, "You are a read-only child.") {
			close(started)
			<-r.Context().Done()
			close(stopped)
			return
		}
		if parents.Add(1) == 1 {
			fmt.Fprint(w, `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"spawn","type":"function","function":{"name":"spawn","arguments":"{\"prompt\":\"Research\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	deps2 := enginetest.Deps(t)
	deps2.Workdir = t.TempDir()
	deps2.Providers = map[string]model.Provider{"openai": openai.New(openai.Options{BaseURL: upstream.URL})}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "openai"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Start"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Cancel(id); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("child continued after parent cancellation")
	}
}
