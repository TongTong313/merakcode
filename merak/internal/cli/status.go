package cli

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// statusCommand tells whether the daemon runs, which process it is, where it listens, which folder it keeps its files
// in and how many clients are connected (this command included). It exits with 1 when the daemon does not run.
func statusCommand(output io.Writer, ui *renderer) int {
	home, err := dataHome()
	if err != nil {
		return 1
	}
	root, err := configRoot()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := connectEngine(ctx, home)
	if err != nil {
		fmt.Fprintln(output, ui.text("statusStopped"))
		return 1
	}
	defer client.Close()
	var status protocol.EngineStatus
	if client.Call(ctx, "engine.status", struct{}{}, &status) != nil {
		return 1
	}
	port := ""
	if info, err := server.ReadInfo(home); err == nil {
		if parsed, err := url.Parse(info.Endpoint); err == nil {
			port = parsed.Port()
		}
	}
	fmt.Fprintf(output, "%s\n", ui.text("statusRunning"))
	fmt.Fprintf(output, "%s: %d\n%s: %s\n%s: %s\n%s: %d\n", ui.text("statusPID"), status.PID, ui.text("statusPort"), port, ui.text("statusRoot"), root, ui.text("statusClients"), status.Clients)
	return 0
}
