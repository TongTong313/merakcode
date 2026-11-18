package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/protocol"
)

// providerCommand runs merak provider list, login, logout and relay add|remove. Keys are read from standard input,
// never from the command line, and the engine keeps them in its vault.
func providerCommand(args []string, stdin io.Reader, stdout io.Writer) int {
	if len(args) == 0 {
		return 2
	}
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	switch {
	case args[0] == "list" && len(args) == 1:
		return withEngine(ctx, home, func(client *protocol.Client) int { return listProviders(ctx, client, stdout) })
	case args[0] == "login" && len(args) == 2:
		key, ok := readKey(stdin)
		if !ok {
			return 2
		}
		return setProvider(ctx, home, args[1], map[string]any{"apiKey": key})
	case args[0] == "logout" && len(args) == 2:
		return setProvider(ctx, home, args[1], map[string]any{"apiKey": ""})
	case args[0] == "relay" && len(args) >= 3 && args[1] == "add":
		return addRelay(ctx, home, args[2], args[3:], stdin)
	case args[0] == "relay" && len(args) == 3 && args[1] == "remove":
		return withEngine(ctx, home, func(client *protocol.Client) int {
			patch := map[string]any{"providers": map[string]any{args[2]: nil}}
			if client.Call(ctx, "config.set", patch, nil) != nil {
				return 1
			}
			return 0
		})
	}
	return 2
}

func withEngine(ctx context.Context, home string, run func(*protocol.Client) int) int {
	client, err := ensureEngine(ctx, home, "", "")
	if err != nil {
		return 1
	}
	defer client.Close()
	return run(client)
}

func readKey(stdin io.Reader) (string, bool) {
	line, err := bufio.NewReader(stdin).ReadString('\n')
	key := strings.TrimSpace(line)
	return key, key != "" && (err == nil || err == io.EOF)
}

func setProvider(ctx context.Context, home, id string, change map[string]any) int {
	return withEngine(ctx, home, func(client *protocol.Client) int {
		if client.Call(ctx, "config.set", map[string]any{"providers": map[string]any{id: change}}, nil) != nil {
			return 1
		}
		return 0
	})
}

func addRelay(ctx context.Context, home, id string, args []string, stdin io.Reader) int {
	flags := flag.NewFlagSet("relay", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	address := flags.String("url", "", "")
	station := flags.String("station", "", "")
	group := flags.String("group", "", "")
	protocolName := flags.String("protocol", "openai", "")
	auth := flags.String("auth", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *address == "" || *station == "" {
		return 2
	}
	key, ok := readKey(stdin)
	if !ok {
		return 2
	}
	change := map[string]any{"name": id, "protocol": *protocolName, "baseURL": *address, "station": *station, "group": *group, "apiKey": key}
	if *auth != "" {
		change["auth"] = *auth
	}
	return setProvider(ctx, home, id, change)
}

func listProviders(ctx context.Context, client *protocol.Client, stdout io.Writer) int {
	var value protocol.Config
	if client.Call(ctx, "config.get", struct{}{}, &value) != nil {
		return 1
	}
	names := make([]string, 0, len(value.Providers))
	for name := range value.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	listed := make(map[string]any, len(names))
	for _, name := range names {
		provider := value.Providers[name]
		listed[name] = map[string]any{"name": provider.Name, "protocol": provider.Protocol, "baseURL": provider.BaseURL, "station": provider.Station, "group": provider.Group, "hasKey": provider.HasKey, "disabled": provider.Disabled}
	}
	if json.NewEncoder(stdout).Encode(listed) != nil {
		return 1
	}
	return 0
}
