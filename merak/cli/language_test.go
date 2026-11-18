package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunRendersModelErrorsInTheSelectedLanguage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadRequest) }))
	defer upstream.Close()
	for _, test := range []struct{ name, environment, flag, title string }{
		{"system locale", "zh_CN.UTF-8", "", "模型请求失败"},
		{"explicit English", "zh_CN.UTF-8", "en", "Model request failed"},
		{"explicit Chinese", "en_US.UTF-8", "zh", "模型请求失败"},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("MERAKCODE_HOME", home)
			cleanupEngine(t, home)
			t.Setenv("MERAKCODE_LANG", "")
			t.Setenv("LC_ALL", test.environment)
			t.Setenv("OPENAI_BASE_URL", upstream.URL)
			args := []string{"run", "--model", "fixture"}
			if test.flag != "" {
				args = append(args, "--lang", test.flag)
			}
			args = append(args, "Hello")
			var output bytes.Buffer
			code := Run(args, strings.NewReader(""), &output)
			if code != 1 || !strings.Contains(output.String(), "[MRK-2001]") || !strings.Contains(output.String(), test.title) {
				t.Fatalf("code=%d output=%q", code, output.String())
			}
		})
	}
}

func TestTextTablesHaveIdenticalNonEmptyKeys(t *testing.T) {
	var tables []map[string]string
	for _, lang := range []string{"zh", "en"} {
		body, err := textFiles.ReadFile("text/" + lang + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var table map[string]string
		if err := json.Unmarshal(body, &table); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, table)
	}
	if len(tables[0]) != len(tables[1]) {
		t.Fatal("text table key counts differ")
	}
	for key, value := range tables[0] {
		if strings.TrimSpace(value) == "" || strings.TrimSpace(tables[1][key]) == "" {
			t.Fatalf("missing translation for %s", key)
		}
	}
}

func TestLanguageFlagAppliesToInvalidArguments(t *testing.T) {
	t.Setenv("MERAKCODE_LANG", "en")
	for _, args := range [][]string{{"--lang", "zh", "unknown"}, {"run", "--lang", "zh", "--unknown"}} {
		var output bytes.Buffer
		code := Run(args, strings.NewReader(""), &output)
		if code != 2 || !strings.Contains(output.String(), "[MRK-3001] 命令参数无效") {
			t.Fatalf("code=%d output=%q", code, output.String())
		}
	}
}
