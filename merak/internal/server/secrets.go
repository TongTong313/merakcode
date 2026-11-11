package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
)

func providerSecret(name string) string { return "provider:" + name }

// providerKey returns the key saved for a provider, or "" when there is none.
func (s *Server) providerKey(ctx context.Context, name string) string {
	value, err := s.engine.Vault().Get(ctx, providerSecret(name))
	if err != nil {
		return ""
	}
	return string(value)
}

// keepProviderKeys moves the keys of a configuration change into the vault, so that they are never written to the
// configuration file. An empty key removes the saved one; removing a provider removes its key.
func (s *Server) keepProviderKeys(ctx context.Context, patch *config.Patch) error {
	vault := s.engine.Vault()
	for name, change := range patch.Providers {
		switch {
		case change == nil:
			if err := vault.Delete(ctx, providerSecret(name)); err != nil {
				return err
			}
		case change.APIKey != nil && *change.APIKey == "":
			if err := vault.Delete(ctx, providerSecret(name)); err != nil {
				return err
			}
			change.APIKey = nil
		case change.APIKey != nil:
			if err := vault.Set(ctx, providerSecret(name), []byte(*change.APIKey)); err != nil {
				return err
			}
			change.APIKey = nil
		}
	}
	return nil
}

// migrateSecrets moves the provider keys that earlier versions kept in plain files into the vault: the apiKey entries
// of the configuration file, and the api entries of <data>/auth.json. A key that is already in the vault stays.
func migrateSecrets(ctx context.Context, settings *config.Store, vault credential.Vault, dataDir string) error {
	for name, provider := range settings.Private().Providers {
		if provider.APIKey == "" {
			continue
		}
		if err := vault.Set(ctx, providerSecret(name), []byte(provider.APIKey)); err != nil {
			return err
		}
		empty := ""
		if _, err := settings.Update(config.Patch{Providers: map[string]*config.ProviderPatch{name: {APIKey: &empty}}}); err != nil {
			return err
		}
	}
	return migrateAuthFile(ctx, vault, filepath.Join(dataDir, "auth.json"))
}

// migrateAuthFile reads the file the v0.3 engine kept its credentials in: an object by provider id whose "api"
// entries carry a key. Entries of other kinds stay in the file; it is removed when nothing is left in it.
func migrateAuthFile(ctx context.Context, vault credential.Vault, path string) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var entries map[string]json.RawMessage
	if json.Unmarshal(data, &entries) != nil {
		return nil
	}
	remaining := map[string]json.RawMessage{}
	for name, raw := range entries {
		var entry struct {
			Type string `json:"type"`
			Key  string `json:"key"`
		}
		if json.Unmarshal(raw, &entry) != nil || entry.Type != "api" || entry.Key == "" {
			remaining[name] = raw
			continue
		}
		if _, err := vault.Get(ctx, providerSecret(name)); err == nil {
			continue
		}
		if err := vault.Set(ctx, providerSecret(name), []byte(entry.Key)); err != nil {
			return err
		}
	}
	if len(remaining) == 0 {
		return os.Remove(path)
	}
	body, err := json.MarshalIndent(remaining, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0600)
}

// authenticate matches the token of a request with the person who holds it: the engine's own token belongs to the
// person of this machine, and the tokens added with AddIdentity to the people they were made for.
func (s *Server) authenticate(header string) (event.ID, bool) {
	if s.token != "" && subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+s.token)) == 1 {
		return s.human, true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, human := range s.identities {
		if subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+token)) == 1 {
			return human, true
		}
	}
	return "", false
}

// AddIdentity makes a token whose connections act as another person than the one of this machine, and returns it.
// Nothing in the engine hands such a token out yet; tests use it to be several people at once.
func (s *Server) AddIdentity(human event.ID) string {
	var secret [32]byte
	_, _ = rand.Read(secret[:])
	token := hex.EncodeToString(secret[:])
	s.mu.Lock()
	s.identities[token] = human
	s.mu.Unlock()
	return token
}
