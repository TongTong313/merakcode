package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/protocol"
)

var errUsage = errors.New("usage")

// agentCommand runs merak agent list, catalog, add, remove and test. Agents belong to the person of this machine; the
// engine keeps them.
func agentCommand(args []string, input io.Reader, output io.Writer, ui *renderer) int {
	if len(args) == 0 {
		return 2
	}
	flags := flag.NewFlagSet("agent", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	file := flags.String("file", "", "")
	product := flags.String("product", "", "")
	id := flags.String("agent", "", "")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 {
		return 2
	}
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, err := ensureEngine(ctx, home, "", "")
	if err != nil {
		return 1
	}
	defer client.Close()
	var result json.RawMessage
	switch args[0] {
	case "list":
		err = client.Call(ctx, "agent.list", protocol.AgentListParams{}, &result)
	case "catalog":
		err = client.Call(ctx, "agent.catalog", struct{}{}, &result)
	case "add", "test":
		var draft map[string]any
		if draft, err = agentDraft(ctx, client, input, *file, *product); err != nil {
			break
		}
		method := "agent.save"
		if args[0] == "test" {
			method = "agent.test"
		}
		err = client.Call(ctx, method, map[string]any{"agent": draft}, &result)
	case "remove":
		if *id == "" {
			return 2
		}
		err = client.Call(ctx, "agent.delete", map[string]string{"agent": *id}, &result)
	default:
		return 2
	}
	if errors.Is(err, errUsage) {
		return 2
	}
	if err != nil {
		ui.failure(output, err.Error())
		return 1
	}
	if len(result) == 0 {
		result = json.RawMessage("{}")
	}
	if _, err := output.Write(append(result, '\n')); err != nil {
		return 1
	}
	return 0
}

// agentDraft reads an agent from a file ("-" is standard input), or builds a worker around a product that was detected
// on this machine.
func agentDraft(ctx context.Context, client *protocol.Client, input io.Reader, file, product string) (map[string]any, error) {
	if (file == "") == (product == "") {
		return nil, errUsage
	}
	if file != "" {
		reader := input
		if file != "-" {
			opened, err := os.Open(file)
			if err != nil {
				return nil, err
			}
			defer opened.Close()
			reader = opened
		}
		body, err := io.ReadAll(io.LimitReader(reader, 1<<20+1))
		var draft map[string]any
		if err != nil || len(body) > 1<<20 || json.Unmarshal(body, &draft) != nil || draft == nil {
			return nil, errUsage
		}
		return draft, nil
	}
	var products []struct {
		Kind      string `json:"kind"`
		Name      string `json:"name"`
		Binary    string `json:"binary"`
		Available bool   `json:"available"`
	}
	if err := client.Call(ctx, "agent.catalog", struct{}{}, &products); err != nil {
		return nil, err
	}
	for _, found := range products {
		if found.Kind != product || !found.Available || found.Binary == "" {
			continue
		}
		base, _ := json.Marshal(agent.DefaultWorker())
		var draft map[string]any
		_ = json.Unmarshal(base, &draft)
		draft["name"], draft["summary"] = found.Name, "Runs "+found.Name+" as a Worker."
		draft["product"] = map[string]any{"kind": found.Kind, "binary": found.Binary}
		return draft, nil
	}
	return nil, errUsage
}
