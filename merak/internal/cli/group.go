package cli

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

func groupCommand(args []string, input io.Reader, output io.Writer, ui *renderer) int {
	if len(args) < 2 {
		return 2
	}
	methods := map[string]string{
		"group create": "group.create", "group add-member": "group.addMember", "group remove-member": "group.removeMember",
		"group update": "group.update", "group board": "group.state", "group inbox": "inbox", "group say": "group.say",
		"group pause": "group.pause", "group resume": "group.resume", "task create": "task.create", "task assign": "task.assign",
		"task review": "task.review", "task update": "task.update", "task cancel": "task.cancel", "task list": "task.list",
		"task archive": "task.archive", "group bind": "group.bind", "group list": "group.list",
	}
	method := methods[args[0]+" "+args[1]]
	if method == "" {
		return 2
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	file := flags.String("file", "", "")
	values := map[string]*string{}
	for _, key := range []string{"group", "task", "member", "thread", "title", "description", "workspace", "leader", "decision", "feedback", "text", "role", "project"} {
		values[key] = flags.String(key, "", "")
	}
	tasks := flags.String("tasks", "", "")
	archived := flags.Bool("archived", false, "")
	restore := flags.Bool("restore", false, "")
	if flags.Parse(args[2:]) != nil || flags.NArg() != 0 {
		return 2
	}
	params := map[string]json.RawMessage{}
	if *file != "" {
		reader := input
		if *file != "-" {
			opened, err := os.Open(*file)
			if err != nil {
				return 1
			}
			defer opened.Close()
			reader = opened
		}
		body, err := io.ReadAll(io.LimitReader(reader, 1<<20+1))
		if err != nil || len(body) > 1<<20 || json.Unmarshal(body, &params) != nil || params == nil {
			return 2
		}
	}
	for key, value := range values {
		if *value != "" {
			params[key], _ = json.Marshal(*value)
		}
	}
	switch method {
	case "task.list":
		if *archived {
			params["archived"] = json.RawMessage("true")
		}
	case "task.archive":
		list := strings.FieldsFunc(*tasks, func(r rune) bool { return r == ',' })
		if len(list) == 0 {
			return 2
		}
		params["tasks"], _ = json.Marshal(list)
		params["archived"], _ = json.Marshal(!*restore)
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
	var result any
	if method == "inbox" {
		var id event.ID
		if json.Unmarshal(params["group"], &id) != nil || id == "" {
			return 2
		}
		result, err = client.GroupInbox(ctx, id, client.Hello.Human)
	} else {
		var raw json.RawMessage
		err = client.Call(ctx, method, params, &raw)
		result = raw
	}
	if err != nil {
		ui.failure(output, err.Error())
		return 1
	}
	if json.NewEncoder(output).Encode(result) != nil {
		return 1
	}
	return 0
}
