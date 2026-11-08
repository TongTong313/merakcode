package secret_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

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
