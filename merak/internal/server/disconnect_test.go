package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestLastApproverDisconnectsBeforeRequestsAreDelivered(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	owner, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	started, results := make(chan struct{}, 64), make(chan bool, 64)
	for index := range 64 {
		go func() {
			started <- struct{}{}
			if index%2 == 0 {
				answer, err := handler.AskQuestion(ctx, question.Request{ID: event.NewID(), Text: "Choose"})
				results <- err == nil && answer.Cancelled
				return
			}
			reply, err := handler.Ask(ctx, permission.Request{ID: event.NewID()})
			results <- err == nil && reply.Decision == permission.Deny
		}()
	}
	for range 64 {
		<-started
	}
	owner.Close()
	for range 64 {
		select {
		case denied := <-results:
			if !denied {
				t.Fatal("undelivered request was not cancelled or denied")
			}
		case <-ctx.Done():
			t.Fatal("undelivered request remained pending after the last approver disconnected")
		}
	}
}
