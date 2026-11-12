package cli

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// sessionCommand runs merak session list, show, rename, archive and delete. The engine keeps the conversations.
func sessionCommand(args []string, output io.Writer, ui *renderer) int {
	if len(args) == 0 {
		return 2
	}
	flags := flag.NewFlagSet("session", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	id := flags.String("session", "", "")
	title := flags.String("title", "", "")
	archived := flags.Bool("archived", false, "")
	restore := flags.Bool("restore", false, "")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 {
		return 2
	}
	needsSession := args[0] != "list"
	if needsSession && *id == "" || args[0] == "rename" && *title == "" {
		return 2
	}
	return callEngine(output, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		var result json.RawMessage
		var err error
		switch args[0] {
		case "list":
			err = client.Call(ctx, "session.list", protocol.SessionListParams{Archived: *archived}, &result)
		case "show":
			err = client.Call(ctx, "session.snapshot", protocol.SessionCancelParams{Session: eventID(*id)}, &result)
		case "rename":
			err = client.Call(ctx, "session.update", map[string]any{"session": *id, "title": *title}, &result)
		case "archive":
			err = client.Call(ctx, "session.update", map[string]any{"session": *id, "archived": !*restore}, &result)
		case "delete":
			err = client.Call(ctx, "session.delete", protocol.SessionCancelParams{Session: eventID(*id)}, &result)
		default:
			return nil, errUsage
		}
		return result, err
	})
}

// exportCommand runs merak export: the events of one conversation, the latest one when none is named, as JSON on
// standard output or in a file.
func exportCommand(args []string, output io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("export", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	id := flags.String("session", "", "")
	file := flags.String("file", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	return callEngine(output, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		target := eventID(*id)
		if target == "" {
			var listed []struct {
				ID        string    `json:"id"`
				CreatedAt time.Time `json:"createdAt"`
			}
			if err := client.Call(ctx, "session.list", protocol.SessionListParams{}, &listed); err != nil || len(listed) == 0 {
				return nil, errUsage
			}
			latest := listed[0]
			for _, candidate := range listed {
				if candidate.CreatedAt.After(latest.CreatedAt) {
					latest = candidate
				}
			}
			target = eventID(latest.ID)
		}
		var events json.RawMessage
		if err := client.Call(ctx, "session.export", protocol.SessionCancelParams{Session: target}, &events); err != nil {
			return nil, err
		}
		if *file == "" {
			return events, nil
		}
		return nil, os.WriteFile(*file, append(events, '\n'), 0o600)
	})
}

// importCommand runs merak import: it reads the file written by merak export ("-" is standard input) and adds it
// as a new conversation.
func importCommand(args []string, input io.Reader, output io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("import", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	named := flags.String("file", "", "")
	from := flags.String("from", "", "")
	if flags.Parse(args) != nil || flags.NArg() > 1 || flags.NArg() == 1 && *named != "" {
		return 2
	}
	if *from != "" {
		if flags.NArg() != 0 || *named != "" {
			return 2
		}
		return importLegacy(*from, output, ui)
	}
	path := *named
	if flags.NArg() == 1 {
		path = flags.Arg(0)
	}
	if path == "" {
		return 2
	}
	reader := input
	if path != "-" {
		opened, err := os.Open(path)
		if err != nil {
			return 1
		}
		defer opened.Close()
		reader = opened
	}
	body, err := io.ReadAll(io.LimitReader(reader, 64<<20+1))
	var events []json.RawMessage
	if err != nil || len(body) > 64<<20 || json.Unmarshal(body, &events) != nil || len(events) == 0 {
		return 2
	}
	return callEngine(output, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		var result json.RawMessage
		err := client.Call(ctx, "session.import", map[string]any{"events": events}, &result)
		return result, err
	})
}

// callEngine connects to the engine of this machine, runs one call and prints its result as JSON.
func callEngine(output io.Writer, ui *renderer, call func(context.Context, *protocol.Client) (any, error)) int {
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
	result, err := call(ctx, client)
	if err == errUsage {
		return 2
	}
	if err != nil {
		ui.failure(output, err.Error())
		return 1
	}
	body, err := json.Marshal(result)
	if err != nil {
		return 1
	}
	if string(body) == "null" || len(body) == 0 {
		body = []byte("{}")
	}
	if _, err := output.Write(append(body, '\n')); err != nil {
		return 1
	}
	return 0
}

func eventID(value string) event.ID { return event.ID(value) }
