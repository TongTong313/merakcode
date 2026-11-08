package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

func models(args []string, output io.Writer) int {
	flags := flag.NewFlagSet("models", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	refresh := flags.Bool("refresh", false, "")
	overrides := flags.String("overrides", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	c, err := configuredCatalog(*overrides)
	if err != nil {
		return 1
	}
	if *refresh {
		if err := c.Refresh(context.Background()); err != nil {
			return 1
		}
	}
	if err := json.NewEncoder(output).Encode(c.List()); err != nil {
		return 1
	}
	return 0
}

func configuredCatalog(path string) (*catalog.Catalog, error) {
	var options catalog.Options
	for _, provider := range []string{"anthropic", "openrouter"} {
		prefix := strings.ToUpper(provider)
		key, base := os.Getenv(prefix+"_API_KEY"), os.Getenv(prefix+"_BASE_URL")
		if key != "" || base != "" {
			options.Sources = append(options.Sources, catalog.Source{Provider: provider, APIKey: key, BaseURL: base})
		}
	}
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&options.Overrides); err != nil {
			return nil, err
		}
		if decoder.Decode(new(any)) != io.EOF {
			return nil, errors.New("expected one overrides array")
		}
		for _, override := range options.Overrides {
			if override.Provider == "" || override.ID == "" || override.Window != nil && *override.Window <= 0 || override.MaxOutput != nil && *override.MaxOutput <= 0 {
				return nil, errors.New("invalid model override")
			}
		}
	}
	return catalog.New(options), nil
}
