package cli

import (
	"context"
	"encoding/json"
	"flag"
	"io"

	"github.com/TongTong313/merakcode/merak/protocol"
)

// skillCommand runs merak skill list, discover, install and uninstall.
func skillCommand(args []string, output io.Writer, ui *renderer) int {
	if len(args) == 0 {
		return 2
	}
	flags := flag.NewFlagSet("skill", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	directory := flags.String("directory", "", "")
	scope := flags.String("scope", "", "")
	token := flags.String("token", "", "")
	var names stringList
	flags.Var(&names, "name", "")
	// the positional argument (a source or a name) may come before or after the flags
	positional := ""
	rest := args[1:]
	if len(rest) > 0 && len(rest[0]) > 0 && rest[0][0] != '-' {
		positional, rest = rest[0], rest[1:]
	}
	if flags.Parse(rest) != nil || flags.NArg() != 0 {
		return 2
	}
	return callEngine(output, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		var result json.RawMessage
		var err error
		switch args[0] {
		case "list":
			err = client.Call(ctx, "skill.list", protocol.DirectoryParams{Directory: *directory}, &result)
		case "discover":
			if positional == "" {
				return nil, errUsage
			}
			err = client.Call(ctx, "skill.discover", protocol.SkillDiscoverParams{Source: positional, Token: *token}, &result)
		case "install":
			if positional == "" || len(names) == 0 {
				return nil, errUsage
			}
			err = client.Call(ctx, "skill.install", protocol.SkillInstallParams{DirectoryParams: protocol.DirectoryParams{Directory: *directory}, Source: positional, Token: *token, Names: names, Scope: *scope}, &result)
		case "uninstall":
			if positional == "" {
				return nil, errUsage
			}
			err = client.Call(ctx, "skill.uninstall", protocol.SkillUninstallParams{DirectoryParams: protocol.DirectoryParams{Directory: *directory}, Name: positional, Scope: *scope}, &result)
		default:
			return nil, errUsage
		}
		return result, err
	})
}

// commandCommand runs merak command list.
func commandCommand(args []string, output io.Writer, ui *renderer) int {
	if len(args) == 0 || args[0] != "list" {
		return 2
	}
	flags := flag.NewFlagSet("command", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	directory := flags.String("directory", "", "")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 {
		return 2
	}
	return callEngine(output, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		var result json.RawMessage
		err := client.Call(ctx, "command.list", protocol.DirectoryParams{Directory: *directory}, &result)
		return result, err
	})
}

// stringList is a flag that can be given more than once.
type stringList []string

func (l *stringList) String() string     { return "" }
func (l *stringList) Set(v string) error { *l = append(*l, v); return nil }
