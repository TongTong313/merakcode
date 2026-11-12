package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// importLegacy runs merak import --from v0.3: it has the engine bring in the data of the earlier version, shows how
// far it is, and then says what came in and what stayed behind. The engine does the work and keeps the record of it,
// so running it again only brings in what is new.
func importLegacy(from string, output io.Writer, ui *renderer) int {
	if from != "v0.3" {
		return 2
	}
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()
	client, err := ensureEngine(ctx, home, "", "")
	if err != nil {
		return 1
	}
	defer client.Close()
	if err := client.Call(ctx, "import.start", protocol.ImportStartParams{From: from}, nil); err != nil {
		ui.failure(output, codeOf(err))
		return 1
	}
	status, err := waitForImport(ctx, client, output, ui)
	if err != nil {
		ui.failure(output, codeOf(err))
		return 1
	}
	printImport(output, ui, status)
	return 0
}

// codeOf is the MRK code of a failed call, or the code of a failed import.
func codeOf(err error) string {
	if failure, ok := err.(*protocol.Error); ok && failure.Data.Code != "" {
		return failure.Data.Code
	}
	return "MRK-4022"
}

// waitForImport polls the engine until the migration is done, printing the progress when it moves. A migration that
// goes back to idle after it was started has failed.
func waitForImport(ctx context.Context, client *protocol.Client, output io.Writer, ui *renderer) (protocol.ImportStatus, error) {
	shown := -1
	for {
		var status protocol.ImportStatus
		if err := client.Call(ctx, "import.status", struct{}{}, &status); err != nil {
			return status, err
		}
		switch status.State {
		case "done":
			return status, nil
		case "idle":
			return status, errors.New("MRK-4022")
		}
		if status.Done != shown && status.Total > 0 {
			shown = status.Done
			fmt.Fprintf(output, ui.text("importProgress"), status.Done, status.Total)
		}
		select {
		case <-ctx.Done():
			return status, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func printImport(output io.Writer, ui *renderer, status protocol.ImportStatus) {
	fmt.Fprintf(output, ui.text("importProgress"), status.Done, status.Total)
	result := protocol.ImportResult{}
	if status.Result != nil {
		result = *status.Result
	}
	counts := result.Imported
	fmt.Fprintf(output, ui.text("importDone"), counts.Sessions, counts.Groups, counts.Agents+counts.Roles, counts.Plans, counts.Memories, len(result.Skipped))
	for _, skipped := range result.Skipped {
		title := ""
		if spec, ok := errorcode.Lookup(skipped.Code); ok {
			title = spec.Title.In(ui.language)
		}
		fmt.Fprintf(output, ui.text("importSkipped"), skipped.Kind, skipped.ID, skipped.Code, title)
	}
	if len(result.Adapters) > 0 {
		fmt.Fprintf(output, ui.text("importAdapters"), strings.Join(result.Adapters, ", "))
	}
}
