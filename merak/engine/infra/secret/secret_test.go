package secret_test

import (
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/infra/secret"
)

func TestCredentialPatternsRetainBoundariesAndCaseFolding(t *testing.T) {
	for _, text := range []string{
		"sk-" + strings.Repeat("a", 20),
		"ghp_" + strings.Repeat("a", 20),
		"AKIA" + strings.Repeat("A", 16),
		"-----BEGIN PRIVATE KEY-----",
		"eyJaaaaa.aaaaaaaa.aaaaaaaa",
		"CLIENT_ſECRET = fixture-value",
		"Bearer\t" + strings.Repeat("a", 16),
	} {
		if !secret.Contains(text) || secret.Redact(text) != "[redacted]" {
			t.Fatal("credential pattern or case folding changed")
		}
		if clean := secret.Redact("Before\n" + text + "\nAfter"); clean != "Before\n[redacted]\nAfter" {
			t.Fatal("surrounding text changed")
		}
	}
	for _, text := range []string{"ordinary history", "task=done", "password", "Bearer short", "sk-short"} {
		if secret.Contains(text) || secret.Redact(text) != text {
			t.Fatal("ordinary text was redacted")
		}
	}
}

func BenchmarkRedactLargeOrdinaryHistory(b *testing.B) {
	text := strings.Repeat("history", 450000)
	b.SetBytes(int64(len(text)))
	b.ResetTimer()
	for range b.N {
		if secret.Redact(text) != text {
			b.Fatal("ordinary history changed")
		}
	}
}

func TestRedactValueRemovesCustomAuthenticationHeaders(t *testing.T) {
	value := secret.RedactValue(map[string]any{
		"providers": map[string]any{"relay": map[string]any{
			"headers": map[string]any{"X-Route": "private-routing-value"},
			"name":    "Relay",
		}},
	}).(map[string]any)
	provider := value["providers"].(map[string]any)["relay"].(map[string]any)
	if provider["headers"] != "[redacted]" || provider["name"] != "Relay" {
		t.Fatal("custom credentials were retained or public metadata was removed")
	}
}
