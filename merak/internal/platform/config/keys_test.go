package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestReadGlobalKeysReturnsTheRawValuesOfKeysV1DoesNotInterpret(t *testing.T) {
	for _, test := range []struct {
		name, file, text string
		wantProducts     string
		wantErr          bool
	}{
		{"jsonc with comments", "merakcode.jsonc", "{\n // products\n \"agentConnections\": {\"products\": {\"a\": {\"adapter\": \"claude\"}},},\n \"model\": \"x/y\"\n}", `{"products": {"a": {"adapter": "claude"}},}`, false},
		{"plain json file", "merakcode.json", `{"agentConnections":{"products":{}}}`, `{"products":{}}`, false},
		{"missing file", "", "", "", false},
		{"not an object", "merakcode.json", `[1]`, "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			if test.file != "" {
				if err := os.WriteFile(filepath.Join(root, test.file), []byte(test.text), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			keys, err := config.ReadGlobalKeys(root, "agentConnections", "collaboration")
			if (err != nil) != test.wantErr {
				t.Fatalf("err = %v, want error %v", err, test.wantErr)
			}
			got := string(keys["agentConnections"])
			if test.wantProducts != "" && len(got) == 0 {
				t.Fatalf("agentConnections missing from %v", keys)
			}
			if test.wantProducts == "" && len(keys) != 0 {
				t.Fatalf("unexpected keys %v", keys)
			}
			if _, present := keys["model"]; present {
				t.Fatal("a key that was not asked for came back")
			}
		})
	}
}
