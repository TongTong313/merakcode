package testmodel

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestModelHTTPRejectsExternalRequestsBeforeDialing(t *testing.T) {
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	t.Setenv("DASHSCOPE_API_KEY", "canary")
	t.Setenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "canary")
	Isolate()
	for _, key := range []string{"DASHSCOPE_API_KEY", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"} {
		if _, ok := os.LookupEnv(key); ok {
			t.Error("test process inherited a cloud credential")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatal("local fixture did not respond")
	}
	transport := http.DefaultTransport.(*http.Transport)
	// Even a broken guard cannot send the canary request.
	transport = transport.Clone()
	transport.DialContext = func(context.Context, string, string) (net.Conn, error) {
		t.Error("external model address reached the dialer")
		return nil, errors.New("network disabled")
	}
	client := &http.Client{Transport: transport}
	if _, err := client.Get("https://model.invalid/v1/messages"); err == nil {
		t.Fatal("external model address accepted")
	}
}
