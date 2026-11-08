// Package errorcode reads the generated cross-language error catalog.
package errorcode

import "encoding/json"

type Text struct {
	ZH string `json:"zh"`
	EN string `json:"en"`
}

func (t Text) In(language string) string {
	if language == "zh" {
		return t.ZH
	}
	return t.EN
}

type Spec struct {
	Code      string `json:"code"`
	Domain    string `json:"domain"`
	Status    int    `json:"status"`
	Retryable bool   `json:"retryable"`
	Title     Text   `json:"title"`
	Hint      Text   `json:"hint"`
}

var catalog = func() map[string]Spec {
	var entries map[string]Spec
	if err := json.Unmarshal([]byte(catalogJSON), &entries); err != nil {
		panic("invalid generated error catalog")
	}
	result := make(map[string]Spec, len(entries))
	for _, spec := range entries {
		result[spec.Code] = spec
	}
	return result
}()

func Lookup(code string) (Spec, bool) { spec, ok := catalog[code]; return spec, ok }
