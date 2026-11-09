package cli

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
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
	replies := make(chan permission.Reply)
	e, err := engine.New(engine.Deps{Workdir: workdir, Ask: func(ctx context.Context, _ permission.Request) (permission.Reply, error) {
		select {
		case reply := <-replies:
			return reply, nil
		case <-ctx.Done():
			return permission.Reply{}, ctx.Err()
		}
	}})
	if err != nil {
		return 1
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Product = &profile.Product{Kind: worker.Kind(*kind), Binary: *binary}
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: event.NewID(), Packet: flags.Arg(0), Workdir: workdir})
	if err != nil {
		return 1
	}
	encoder := json.NewEncoder(stdout)
	decoder := json.NewDecoder(stdin)
	for fact := range run.Events() {
		if encoder.Encode(fact) != nil {
			return 1
		}
		if fact.Type == permission.Requested {
			reply := permission.Reply{Decision: permission.Deny}
			if err := decoder.Decode(&reply); err != nil {
				reply = permission.Reply{Decision: permission.Deny}
			}
			select {
			case replies <- reply:
			case <-ctx.Done():
				return 1
			}
		}
	}
	report, err := run.Wait(context.Background())
	if encoder.Encode(struct {
		Report task.Report `json:"report"`
	}{report}) != nil || err != nil {
		return 1
	}
	return 0
}
