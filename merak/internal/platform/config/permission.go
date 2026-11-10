package config

import (
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
)

type PermissionRule struct {
	Project       string `json:"project,omitempty"`
	Tool          string `json:"tool,omitempty"`
	PathPrefix    string `json:"pathPrefix,omitempty"`
	CommandPrefix string `json:"commandPrefix,omitempty"`
	Decision      string `json:"decision"`
}

type PermissionGrant struct {
	Key      string `json:"key"`
	Decision string `json:"decision"`
}

func validatePermissions(value Value) error {
	for _, rule := range value.PermissionRules {
		if rule.Decision != "allow" && rule.Decision != "ask" && rule.Decision != "deny" {
			return errors.New("invalid permission rule decision")
		}
		if (rule.PathPrefix == "") == (rule.CommandPrefix == "") {
			return errors.New("permission rules require exactly one path or command prefix")
		}
		if rule.Project != "" && !filepath.IsAbs(rule.Project) || strings.ContainsRune(rule.PathPrefix+rule.Project+rule.CommandPrefix, '\x00') || rule.CommandPrefix != "" && strings.TrimSpace(rule.CommandPrefix) == "" {
			return errors.New("invalid permission rule scope")
		}
	}
	for _, grant := range value.PermissionGrants {
		key, err := hex.DecodeString(grant.Key)
		if err != nil || len(key) != 32 || grant.Decision != "allow" && grant.Decision != "deny" {
			return errors.New("invalid remembered permission")
		}
	}
	return nil
}

func (s *Store) PermissionRules() []PermissionRule {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]PermissionRule(nil), s.value.PermissionRules...)
}

func (s *Store) PermissionDecision(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, grant := range s.value.PermissionGrants {
		if grant.Key == key {
			return grant.Decision
		}
	}
	return ""
}

func (s *Store) RememberPermissionDecision(key, decision string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := make([]PermissionGrant, 0, len(s.value.PermissionGrants)+1)
	for _, grant := range s.value.PermissionGrants {
		if grant.Key != key {
			values = append(values, grant)
		}
	}
	values = append(values, PermissionGrant{Key: key, Decision: decision})
	_, err := s.update(Patch{PermissionGrants: &values})
	return err
}
