package cli

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

//go:embed text/*.json
var textFiles embed.FS

var texts = func() map[string]map[string]string {
	result := make(map[string]map[string]string)
	for _, lang := range []string{"zh", "en"} {
		body, err := textFiles.ReadFile("text/" + lang + ".json")
		if err != nil {
			panic(err)
		}
		var table map[string]string
		if err := json.Unmarshal(body, &table); err != nil {
			panic(err)
		}
		result[lang] = table
	}
	return result
}()

type renderer struct {
	language string
	reported bool
}

func defaultLanguage() string {
	for _, key := range []string{"MERAKCODE_LANG", "LC_ALL", "LC_MESSAGES", "LANG"} {
		if value := os.Getenv(key); value != "" {
			return language(value)
		}
	}
	return language(systemLocale())
}

func language(value string) string {
	if strings.HasPrefix(strings.ToLower(value), "zh") {
		return "zh"
	}
	return "en"
}

func (r *renderer) text(key string) string { return texts[r.language][key] }

func (r *renderer) failure(out io.Writer, code string) {
	if r.reported {
		return
	}
	spec, ok := errorcode.Lookup(code)
	if !ok {
		spec, _ = errorcode.Lookup(errorcode.ConnectionFailed)
	}
	_, _ = fmt.Fprintf(out, "[%s] %s\n%s\n", spec.Code, spec.Title.In(r.language), spec.Hint.In(r.language))
	r.reported = true
}
