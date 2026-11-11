package catalog

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// defaultPublicURL is OpenRouter's public model list. It needs no key and covers the models of most vendors.
const defaultPublicURL = "https://openrouter.ai/api/v1/models"

// fetchPublic downloads the public catalog.
func fetchPublic(ctx context.Context, address string) ([]Override, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, &model.Error{Code: "MRK-2001", Cause: err}
	}
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, &model.Error{Code: "MRK-2001", Cause: err}
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 16<<20+1))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &model.Error{Code: "MRK-2001", Status: response.StatusCode}
	}
	if readErr != nil {
		return nil, &model.Error{Code: "MRK-2001", Cause: readErr}
	}
	if len(data) > 16<<20 {
		return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("catalog response too large")}
	}
	return openRouterModels(data)
}

// publicKeyOf is the part of an id that public entries and provider lists share: lower case, no vendor prefix, dots
// as dashes.
func publicKeyOf(id string) string { return normalize(id) }

func (c *Catalog) setPublic(entries []Override) {
	index := make(map[string]Override, len(entries))
	for _, entry := range entries {
		if strings.Contains(entry.ID, ":") {
			continue
		}
		key := publicKeyOf(entry.ID)
		if _, taken := index[key]; !taken {
			index[key] = entry
		}
	}
	c.public = index
}

// publicMatch finds the public entry of a model; a relay's id has its vendor prefix removed first.
func (c *Catalog) publicMatch(id string) (Override, bool) {
	entry, ok := c.public[publicKeyOf(id)]
	if !ok {
		return Override{}, false
	}
	entry.Provider, entry.ID = "", ""
	return entry, true
}
