package cli

import (
	"github.com/TongTong313/merakcode/merak/protocol"
	"time"

	"context"
	"encoding/json"

	"flag"
	"io"
	"os"

	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

func models(args []string, output io.Writer) int {
	var only string
	refreshOnly := len(args) > 0 && args[0] == "refresh"
	if refreshOnly {
		if len(args) > 2 {
			return 2
		}
		if len(args) == 2 {
			only = args[1]
		}
		args = nil
	}
	flags := flag.NewFlagSet("models", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	refresh := flags.Bool("refresh", false, "")
	overrides := flags.String("overrides", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, err := ensureEngine(ctx, home, "", "")
	if err != nil {
		return 1
	}
	defer client.Close()
	if (*refresh || refreshOnly) && client.Call(ctx, "model.refresh", protocol.ModelRefreshParams{Provider: only}, nil) != nil {
		return 1
	}
	if refreshOnly {
		return 0
	}
	params := protocol.ModelListParams{}
	if *overrides != "" {
		body, err := os.ReadFile(*overrides)
		if err != nil || json.Unmarshal(body, &params.Overrides) != nil {
			return 1
		}
	}
	var entries []catalog.Model
	if client.Call(ctx, "model.list", params, &entries) != nil || json.NewEncoder(output).Encode(entries) != nil {
		return 1
	}
	return 0
}
