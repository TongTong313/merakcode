package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func emitEvent(args []string, stdout io.Writer) int {
	flags := flag.NewFlagSet("event emit", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	groupID := flags.String("group", "", "")
	kind := flags.String("type", "", "")
	payload := flags.String("payload", "{}", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *groupID == "" || *kind == "" {
		return 2
	}
	var object map[string]json.RawMessage
	if json.Unmarshal([]byte(*payload), &object) != nil || object == nil {
		return 2
	}
	if !strings.HasPrefix(*kind, "external.") {
		*kind = "external." + *kind
	}
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := connectEngine(ctx, home)
	if err != nil {
		return 1
	}
	defer connection.Close()
	var emitted event.Event
	if err := connection.Call(ctx, "event.emit", protocol.EventEmitParams{Group: event.ID(*groupID), Type: event.Type(*kind), Payload: json.RawMessage(*payload)}, &emitted); err != nil {
		return 1
	}
	fmt.Fprintln(stdout, emitted.ID)
	return 0
}
