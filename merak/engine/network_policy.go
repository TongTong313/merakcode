package engine

import (
	"context"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func (e *Engine) workerNetworkPolicy(ctx context.Context, p agent.Agent, a worker.Assignment) (sandbox.Network, error) {
	network := a.SandboxProfile.Network
	hosts, err := e.workerNetworkHosts(ctx, p, a)
	if err != nil {
		return network, err
	}
	network.Mode, network.Hosts = "allowlist", hosts
	if a.Scope.Group == "" && slices.Contains(hosts, "*") {
		network.Mode = "on"
		network.Hosts = slices.DeleteFunc(slices.Clone(hosts), func(host string) bool { return host == "*" })
	}
	denials := append([]string(nil), network.Deny...)
	network.Deny = nil
	network.DenySources = make(map[string]string)
	add := func(source string, rules []string) {
		for _, rule := range rules {
			if !slices.Contains(network.Deny, rule) {
				network.Deny = append(network.Deny, rule)
				if source != "" {
					network.DenySources[rule] = source
				}
			}
		}
	}
	add("user", e.networkConfiguration().DeniedNetworkHosts())
	if a.Scope.Group != "" {
		state, err := e.Groups.Get(ctx, a.Scope.Group)
		if err != nil {
			return network, err
		}
		add("group", state.Group.Settings.DeniedHosts)
	}
	add("", denials)
	return network, nil
}
