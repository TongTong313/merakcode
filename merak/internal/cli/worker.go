package cli

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func debugWorker(args []string, stdin io.Reader, stdout io.Writer) int {
	flags := flag.NewFlagSet("worker", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	kind := flags.String("kind", "claude-code", "")
	binary := flags.String("binary", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 1 {
		return 2
	}
	switch worker.Kind(*kind) {
	case worker.KindClaudeCode, worker.KindCodex, worker.KindOpenCode, worker.KindPi:
	case worker.KindACP, worker.KindCommand:
		if *binary == "" {
			return 2
		}
	default:
		return 2
	}
	workdir, err := os.Getwd()
	if err != nil {
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client, closeHost, err := debugClient(ctx, nil)
	if err != nil {
		return 1
	}
	defer closeHost()
	p := profile.DefaultWorker()
	p.Product = &profile.Product{Kind: worker.Kind(*kind), Binary: *binary}
	id := event.NewID()
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: id}}, nil); err != nil {
		return 1
	}
	type result struct {
		report task.Report
		err    error
	}
	completed := make(chan result, 1)
	go func() {
		var report task.Report
		err := client.Call(ctx, "worker.run", protocol.WorkerRunParams{Session: id, Profile: p, Workdir: workdir, Packet: flags.Arg(0)}, &report)
		completed <- result{report, err}
	}()
	encoder, decoder := json.NewEncoder(stdout), json.NewDecoder(stdin)
	var outcome *result
	finished := false
	for !finished || outcome == nil {
		select {
		case value := <-completed:
			if value.err != nil {
				return 1
			}
			outcome = &value
		case fact, ok := <-client.Events:
			if !ok || encoder.Encode(fact) != nil {
				return 1
			}
			if fact.Type == permission.Requested {
				reply := permission.Reply{Decision: permission.Deny}
				if decoder.Decode(&reply) != nil {
					reply.Decision = permission.Deny
				}
				if client.Call(ctx, "permission.reply", protocol.PermissionReplyParams{Request: fact.ID, Decision: reply.Decision}, nil) != nil {
					return 1
				}
			}
			finished = finished || fact.Type == loop.TurnFinished
		case <-ctx.Done():
			return 1
		}
	}
	if encoder.Encode(struct {
		Report task.Report `json:"report"`
	}{outcome.report}) != nil {
		return 1
	}
	return 0
}
