package cloud_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestDeviceLinkAnnouncesMembersAndForwardsRequestsUnchanged(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	announced := make(chan []group.Member, 1)
	forwarded := make(chan json.RawMessage, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			http.Error(w, "Unauthorized", 401)
			return
		}
		conn, err := websocket.Accept(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			body, err := conn.Read()
			if err != nil {
				return
			}
			var request protocol.Message
			if json.Unmarshal(body, &request) != nil {
				return
			}
			var result any = struct{}{}
			switch request.Method {
			case "hello":
				result = protocol.HelloResult{Protocol: 1, Engine: "fixture"}
			case "device.attach":
			case "device.announce":
				var members []group.Member
				if err := json.Unmarshal(request.Params, &members); err != nil {
					t.Error(err)
				}
				announced <- members
			case "group.create":
				forwarded <- request.Params
				result = group.Group{ID: "cloud-group", Kind: group.KindCloud, Name: "Cloud"}
			default:
				t.Errorf("unexpected method=%s", request.Method)
			}
			payload, _ := json.Marshal(result)
			reply, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", ID: request.ID, Result: payload})
			if conn.Write(reply) != nil {
				return
			}
			if request.Method == "group.create" {
				for range 20 {
					payload, _ := json.Marshal(event.Event{ID: "before-assignment", Type: "task.started"})
					body, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", Method: "event", Params: payload})
					_ = conn.Write(body)
					payload, _ = json.Marshal(protocol.CloudInbound{Cancel: new(event.ID("paired-claim"))})
					body, _ = json.Marshal(protocol.Message{JSONRPC: "2.0", Method: "device.inbound", Params: payload})
					_ = conn.Write(body)
				}
				payload, _ := json.Marshal(protocol.CloudInbound{Cancel: new(event.ID("claim"))})
				body, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", Method: "device.inbound", Params: payload})
				_ = conn.Write(body)
			}
		}
	}))
	defer server.Close()
	link := cloud.NewWebSocket()
	done := make(chan error, 1)
	go func() {
		done <- link.Connect(ctx, cloud.Credentials{Endpoint: strings.Replace(server.URL, "http:", "ws:", 1), Token: "fixture-secret", Account: "account", Device: "device"})
	}()
	defer func() { cancel(); <-done }()
	members := []group.Member{{ID: "member", Name: "Worker", Group: "local", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: "profile", Status: group.Idle}}
	if err := link.Announce(ctx, members); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-announced:
		if len(got) != 1 || got[0].ID != "member" {
			t.Fatalf("members=%+v", got)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	params := json.RawMessage(`{"kind":"cloud","name":"Cloud","extra":{"preserve":true}}`)
	result, err := link.Forward(ctx, "group.create", params)
	if err != nil {
		t.Fatal(err)
	}
	var created group.Group
	if err = json.Unmarshal(result, &created); err != nil || created.ID != "cloud-group" {
		t.Fatalf("result=%s %v", result, err)
	}
	select {
	case got := <-forwarded:
		if string(got) != string(params) {
			t.Fatalf("forward=%s", got)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for range 20 {
		select {
		case incoming := <-link.Inbound():
			if len(incoming.Events) != 1 || incoming.Events[0].ID != "before-assignment" {
				t.Fatalf("event was overtaken: %+v", incoming)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		select {
		case incoming := <-link.Inbound():
			if incoming.Cancel == nil || *incoming.Cancel != "paired-claim" {
				t.Fatalf("paired command out of order: %+v", incoming)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	select {
	case incoming := <-link.Inbound():
		if incoming.Cancel == nil || *incoming.Cancel != "claim" {
			t.Fatalf("incoming=%+v", incoming)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestDevicePublishSplitsBatchesBelowTheTransportLimit(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	received := make(chan event.Event, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r)
		if err != nil {
			return
		}
		defer connection.Close()
		var assembled []byte
		for {
			body, err := connection.Read()
			if err != nil {
				return
			}
			var request protocol.Message
			if json.Unmarshal(body, &request) != nil {
				return
			}
			result := json.RawMessage(`{}`)
			if request.Method == "hello" {
				result = json.RawMessage(`{"protocol":1,"engine":"fixture"}`)
			}
			if request.Method == "device.publish" {
				var facts []event.Event
				if json.Unmarshal(request.Params, &facts) != nil {
					return
				}
				for _, fact := range facts {
					received <- fact
				}
			}
			if request.Method == "device.publishChunk" {
				var chunk protocol.DeviceEventChunk
				if json.Unmarshal(request.Params, &chunk) != nil {
					return
				}
				if chunk.Offset == 0 {
					assembled = nil
				}
				if len(assembled) != chunk.Offset {
					t.Error("chunk offset mismatch")
					return
				}
				assembled = append(assembled, chunk.Data...)
				if len(assembled) == chunk.Total {
					var fact event.Event
					if json.Unmarshal(assembled, &fact) != nil {
						return
					}
					received <- fact
				}
			}
			response, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", ID: request.ID, Result: result})
			if connection.Write(response) != nil {
				return
			}
		}
	}))
	defer server.Close()
	link := cloud.NewWebSocket()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = link.Connect(ctx, cloud.Credentials{Endpoint: strings.Replace(server.URL, "http:", "ws:", 1), Token: "token", Account: "account", Device: "device"})
	}()
	defer func() { cancel(); <-done }()
	payload, _ := json.Marshal(strings.Repeat("x", 3<<20))
	facts := []event.Event{{ID: "first", Stream: "session:test", Seq: 1, Type: "message.completed", Payload: payload}, {ID: "second", Stream: "session:test", Seq: 2, Type: "message.completed", Payload: payload}}
	large, _ := json.Marshal(strings.Repeat("z", 5<<20))
	facts = append(facts, event.Event{ID: "large", Stream: "session:test", Seq: 3, Type: "tool.completed", Payload: large})
	if err := link.Publish(ctx, facts); err != nil {
		t.Fatal(err)
	}
	for _, want := range facts {
		select {
		case got := <-received:
			if got.ID != want.ID {
				t.Fatalf("event=%s", got.ID)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
