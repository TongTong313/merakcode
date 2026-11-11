package server_test

import (
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// connectAs opens a connection that acts as the given person.
func connectAs(t *testing.T, instance *server.Instance, human event.ID, capabilities protocol.Capabilities) *protocol.Client {
	t.Helper()
	client, err := protocol.Connect(t.Context(), instance.Info.Endpoint, instance.AddIdentity(human), protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: capabilities})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

func TestAConnectionActsAsTheMachinesPersonAndNamesNobodyElse(t *testing.T) {
	ctx := t.Context()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if client.Hello.Human != protocol.LocalHuman || protocol.LocalHuman != "local-human" {
		t.Fatalf("hello human = %q", client.Hello.Human)
	}
	other := connectAs(t, instance, "someone", protocol.Capabilities{})
	if other.Hello.Human != "someone" {
		t.Fatalf("hello human = %q", other.Hello.Human)
	}
	// a request that names a person is refused
	if err := client.Call(ctx, "agent.list", map[string]any{"human": "someone"}, new([]any)); err == nil {
		t.Fatal("a request named a person")
	}
	var mine, theirs []struct{ ID string }
	if err := client.Call(ctx, "agent.save", map[string]any{"agent": map[string]any{"name": "Mine", "role": "worker", "toolPool": "worker.default"}}, new(any)); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "agent.list", struct{}{}, &mine); err != nil {
		t.Fatal(err)
	}
	if err := other.Call(ctx, "agent.list", struct{}{}, &theirs); err != nil {
		t.Fatal(err)
	}
	if len(mine) != len(theirs)+1 {
		t.Fatalf("profiles of the machine's person = %d, of another person = %d", len(mine), len(theirs))
	}
}

// waitForRequest returns once the connection has been offered the permission request.
func waitForRequest(t *testing.T, client *protocol.Client, id event.ID) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case fact := <-client.Events:
			if fact.ID == id {
				return
			}
		case <-deadline:
			t.Fatal("the request was not offered to the connection")
		}
	}
}

// connectServerAs opens a connection to a handler served by httptest that acts as the given person.
func connectServerAs(t *testing.T, handler *server.Server, host *httptest.Server, human event.ID, capabilities protocol.Capabilities) *protocol.Client {
	t.Helper()
	client, err := protocol.Connect(t.Context(), "ws"+strings.TrimPrefix(host.URL, "http"), handler.AddIdentity(human), protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: capabilities})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

func TestEngineStatusCountsTheConnectedClients(t *testing.T) {
	ctx := t.Context()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	first := connectAs(t, instance, protocol.LocalHuman, protocol.Capabilities{})
	second := connectAs(t, instance, protocol.LocalHuman, protocol.Capabilities{})
	var status protocol.EngineStatus
	if err := first.Call(ctx, "engine.status", struct{}{}, &status); err != nil {
		t.Fatal(err)
	}
	if status.PID != os.Getpid() || status.Clients != 2 {
		t.Fatalf("status = %+v, want this process with 2 clients", status)
	}
	second.Close()
	deadline := time.After(5 * time.Second)
	for status.Clients != 1 {
		select {
		case <-deadline:
			t.Fatalf("clients = %d after one disconnected", status.Clients)
		case <-time.After(20 * time.Millisecond):
		}
		if err := first.Call(ctx, "engine.status", struct{}{}, &status); err != nil {
			t.Fatal(err)
		}
	}
}
