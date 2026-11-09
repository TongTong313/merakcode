package sandbox_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestProxyHoldsAnUnknownDestinationUntilTheHumanAnswers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	asked := make(chan string, 1)
	answer := make(chan bool, 1)
	proxy := &sandbox.Proxy{Network: sandbox.Network{Mode: "allowlist"}, Approve: func(ctx context.Context, host string) (bool, error) {
		asked <- host
		select {
		case allow := <-answer:
			return allow, nil
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}}
	defer proxy.Close()
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		proxy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://new.example.com/", nil).WithContext(ctx))
	}()
	select {
	case host := <-asked:
		if host != "new.example.com" {
			t.Fatalf("approval host = %q", host)
		}
	case <-done:
		t.Fatal("proxy rejected the connection without asking")
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case <-done:
		t.Fatal("proxy answered before the human decision")
	default:
	}
	answer <- false
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if response.Code != http.StatusForbidden {
		t.Fatalf("denied response = %d", response.Code)
	}
}

func TestProxyDenialReportsTheListAndDoesNotAskForApproval(t *testing.T) {
	for _, source := range []string{"user", "group"} {
		for _, method := range []string{http.MethodGet, http.MethodConnect} {
			t.Run(source+" "+method, func(t *testing.T) {
				var policy sandbox.Network
				body := `{"mode":"allowlist","hosts":["blocked.example"],"deny":["blocked.example:443"],"denySources":{"blocked.example:443":"` + source + `"}}`
				if err := json.Unmarshal([]byte(body), &policy); err != nil {
					t.Fatal(err)
				}
				asked := false
				proxy := &sandbox.Proxy{MemberName: "worker", Network: policy, Approve: func(context.Context, string) (bool, error) { asked = true; return true, nil }}
				defer proxy.Close()
				response := httptest.NewRecorder()
				request := httptest.NewRequest(method, "http://blocked.example:443/", nil)
				request.Host = "blocked.example:443"
				proxy.ServeHTTP(response, request)
				if response.Code != http.StatusForbidden || asked {
					t.Fatalf("response=%d asked=%v", response.Code, asked)
				}
				for _, want := range []string{"MRK-5005", "worker", "blocked.example", source + " DeniedHosts"} {
					if !strings.Contains(response.Body.String(), want) {
						t.Fatalf("response missing %q: %s", want, response.Body.String())
					}
				}
			})
		}
	}
}

func TestProxyTimeoutRejectsTheConnectionAndKeepsApprovalOpen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	asked := make(chan context.Context, 1)
	answer := make(chan bool, 1)
	answered := make(chan struct{})
	proxy := &sandbox.Proxy{Network: sandbox.Network{Mode: "allowlist"}, ApprovalTimeout: 20 * time.Millisecond, Approve: func(ctx context.Context, host string) (bool, error) {
		defer close(answered)
		asked <- ctx
		select {
		case allow := <-answer:
			return allow, nil
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}}
	defer proxy.Close()
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		request := httptest.NewRequest(http.MethodConnect, "http://new.example.com:443", nil).WithContext(ctx)
		request.Host = "new.example.com:443"
		proxy.ServeHTTP(response, request)
	}()
	var approvalContext context.Context
	select {
	case approvalContext = <-asked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("connection did not time out while waiting for approval")
	}
	if response.Code != http.StatusForbidden {
		t.Fatalf("timeout response = %d", response.Code)
	}
	if err := approvalContext.Err(); err != nil {
		t.Fatalf("connection timeout closed the approval: %v", err)
	}
	answer <- true
	select {
	case <-answered:
	case <-ctx.Done():
		t.Fatal("late approval could not finish")
	}
}
