package config

import (
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func NewMemory() *Store { return &Store{value: Value{Providers: map[string]Provider{}}} }

func (s *Store) AllowedNetworkHosts() []string { return s.Get().AllowedHosts }

func (s *Store) AllowNetworkHost(host string) error {
	if err := (sandbox.Network{Mode: "allowlist", Hosts: []string{host}}).Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if slices.ContainsFunc(s.value.AllowedHosts, func(known string) bool {
		return strings.EqualFold(strings.TrimSuffix(known, "."), host)
	}) {
		return nil
	}
	hosts := append(append([]string(nil), s.value.AllowedHosts...), host)
	_, err := s.update(Patch{AllowedHosts: &hosts})
	return err
}
