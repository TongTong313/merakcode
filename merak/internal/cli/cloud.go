package cli

import (
	"context"
	"encoding/json"
	"flag"
	"github.com/TongTong313/merakcode/merak/protocol"
	"io"
	"time"
)

func cloudCommand(args []string, output io.Writer) int {
	if len(args) == 0 {
		return 2
	}
	method := "cloud." + args[0]
	if method != "cloud.login" && method != "cloud.logout" && method != "cloud.status" {
		return 2
	}
	flags := flag.NewFlagSet("cloud", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dev := flags.Bool("dev", false, "")
	endpoint := flags.String("endpoint", "", "")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 || method != "cloud.login" && (*dev || *endpoint != "") {
		return 2
	}
	if method == "cloud.login" && !*dev {
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
	var params any = struct{}{}
	if method == "cloud.login" {
		params = protocol.CloudLoginParams{Dev: *dev, Endpoint: *endpoint}
	}
	var result json.RawMessage
	if err = client.Call(ctx, method, params, &result); err != nil {
		return 1
	}
	if json.NewEncoder(output).Encode(result) != nil {
		return 1
	}
	return 0
}
