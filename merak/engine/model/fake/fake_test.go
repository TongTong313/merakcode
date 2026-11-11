package fake_test

import (
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
)

func TestExtraRequestFailsTheOwningTest(t *testing.T) {
	const child = "MERAK_TEST_EXHAUSTED_SCRIPT"
	if os.Getenv(child) == "1" {
		provider := fake.New(t)
		_, _ = provider.Stream(context.Background(), model.Request{})
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestExtraRequestFailsTheOwningTest$")
	cmd.Env = append(os.Environ(), child+"=1")
	output, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "script exhausted") {
		t.Fatalf("extra request did not fail the owning test: err=%v output=%s", err, output)
	}
}

func TestRequestsReceiveRepliesInScriptOrder(t *testing.T) {
	provider := fake.New(t, fake.Reply{Text: "Hello"}, fake.Reply{Text: "Goodbye"})
	for _, want := range []string{"Hello", "Goodbye"} {
		stream, err := provider.Stream(context.Background(), model.Request{
			Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hi"}}}},
		})
		if err != nil {
			t.Fatal(err)
		}
		var text string
		var stop model.StopReason
		for {
			chunk, err := stream.Recv()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if chunk.Kind == model.Text {
				text += chunk.Text
			}
			if chunk.Kind == model.Stop {
				stop = chunk.Stop
			}
		}
		if err := stream.Close(); err != nil {
			t.Fatal(err)
		}
		if text != want || stop != model.EndTurn {
			t.Fatalf("reply = %q, stop = %s, want %q and endTurn", text, stop, want)
		}
	}
}

func TestARoleReplyAnswersOnlyRequestsOfThatRole(t *testing.T) {
	provider := fake.New(t,
		fake.Reply{Role: "worker", Text: "Worker one"},
		fake.Reply{Role: "leader", Text: "Leader one"},
		fake.Reply{Text: "Anyone"},
		fake.Reply{Role: "worker", Text: "Worker two"},
	)
	ask := func(system string) string {
		t.Helper()
		stream, err := provider.Stream(context.Background(), model.Request{System: system})
		if err != nil {
			t.Fatal(err)
		}
		var text string
		for {
			chunk, err := stream.Recv()
			if err == io.EOF {
				return text
			}
			if err != nil {
				t.Fatal(err)
			}
			text += chunk.Text
		}
	}
	got := []string{ask("Role: leader"), ask("Role: worker"), ask("Role: worker"), ask("Role: worker")}
	want := []string{"Leader one", "Worker one", "Anyone", "Worker two"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("answers = %v, want %v", got, want)
		}
	}
}
