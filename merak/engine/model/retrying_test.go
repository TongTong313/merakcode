package model_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestRetryingBacksOffFor429AndServerFailures(t *testing.T) {
	for _, status := range []int{429, 500, 503, 400, 401, 403, 404, 422} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var mu sync.Mutex
			var arrivals []time.Time
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				arrivals = append(arrivals, time.Now())
				attempt := len(arrivals)
				mu.Unlock()
				if attempt < 3 {
					w.WriteHeader(status)
					return
				}
				fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Recovered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			p := &model.Retrying{Provider: openai.New(openai.Options{BaseURL: server.URL})}
			stream, err := p.Stream(context.Background(), model.Request{Model: "fixture"})
			retry := status == 429 || status >= 500
			if !retry {
				var failure *model.Error
				if !errors.As(err, &failure) || failure.Status != status {
					t.Fatalf("err=%v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer stream.Close()
				chunk, err := stream.Recv()
				if err != nil || chunk.Text != "Recovered" {
					t.Fatalf("chunk=%+v err=%v", chunk, err)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if !retry && len(arrivals) != 1 {
				t.Fatalf("requests=%d", len(arrivals))
			}
			if retry && (len(arrivals) != 3 || arrivals[1].Sub(arrivals[0]) < 90*time.Millisecond || arrivals[2].Sub(arrivals[1]) < 180*time.Millisecond) {
				t.Fatalf("backoff=%v", arrivals)
			}
		})
	}
}

func TestRetryingAccumulatesUsageAndPricesEachAttempt(t *testing.T) {
	var attempt atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := attempt.Add(1)
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":100,\"prompt_tokens_details\":{\"cached_tokens\":200}}}\n\n")
		if current == 1 {
			fmt.Fprint(w, "data: {\"error\":{\"status\":503,\"type\":\"server_error\"}}\n\n")
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	c := catalog.New()
	p := &model.Retrying{Provider: openai.New(openai.Options{BaseURL: server.URL}), Price: func(id string, u model.Usage) model.Usage { return c.Get("zhipu", id).Price.Apply(u) }}
	stream, err := p.Stream(context.Background(), model.Request{Model: "glm-5.3"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var collector model.Collector
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		collector.Add(chunk)
	}
	message, usage, _ := collector.Message()
	if len(message.Parts) != 1 || message.Parts[0].Text != "Done" || usage.Input != 2000 || usage.Output != 200 || usage.CacheRead != 400 || math.Abs(usage.Cost-0.0192) > 1e-10 {
		t.Fatalf("message=%+v usage=%+v", message, usage)
	}
}

func TestRetryingStopsAtLimitAndNeverRepeatsVisibleOutput(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(fmt.Sprint(partial), func(t *testing.T) {
			var attempts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempts.Add(1)
				if !partial {
					w.WriteHeader(503)
					return
				}
				fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Visible\"}}]}\n\ndata: {\"error\":{\"status\":503}}\n\n")
			}))
			defer server.Close()
			p := &model.Retrying{Provider: openai.New(openai.Options{BaseURL: server.URL})}
			stream, err := p.Stream(context.Background(), model.Request{})
			if partial {
				if err != nil {
					t.Fatal(err)
				}
				defer stream.Close()
				chunk, firstErr := stream.Recv()
				if firstErr != nil || chunk.Text != "Visible" {
					t.Fatalf("chunk=%+v err=%v", chunk, firstErr)
				}
				_, err = stream.Recv()
			}
			want := 3
			if partial {
				want = 1
			}
			if err == nil || int(attempts.Load()) != want {
				t.Fatalf("attempts=%d err=%v", attempts.Load(), err)
			}
		})
	}
}

func TestRetryingCancellationInterruptsBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { attempts.Add(1); w.WriteHeader(429); cancel() }))
	defer server.Close()
	p := &model.Retrying{Provider: openai.New(openai.Options{BaseURL: server.URL})}
	_, err := p.Stream(ctx, model.Request{})
	if !errors.Is(err, context.Canceled) || attempts.Load() != 1 {
		t.Fatalf("attempts=%d err=%v", attempts.Load(), err)
	}
}
