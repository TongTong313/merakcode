package cli

import (
	"context"
	"encoding/json"
	"io"

	"github.com/TongTong313/merakcode/merak/engine/event"

	"github.com/TongTong313/merakcode/merak/protocol"
)

// scheduleCommand runs merak schedule list and merak schedule delete <id>.
func scheduleCommand(args []string, output io.Writer, ui *renderer) int {
	switch {
	case len(args) == 1 && args[0] == "list":
	case len(args) == 2 && args[0] == "delete" && args[1] != "":
	default:
		return 2
	}
	return callEngine(output, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		var result json.RawMessage
		if args[0] == "list" {
			err := client.Call(ctx, "schedule.list", struct{}{}, &result)
			return result, err
		}
		err := client.Call(ctx, "schedule.delete", protocol.ScheduleDeleteParams{ID: event.ID(args[1])}, &result)
		return result, err
	})
}
