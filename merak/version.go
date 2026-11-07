// Package merak holds what the whole merak program shares: the product version.
package merak

import (
	_ "embed"
	"encoding/json"
)

// manifest is the package.json next to this file. The version lives there so that pnpm release:version sets it for
// every package at once.
//
//go:embed package.json
var manifest []byte

// Version returns the product version from package.json.
func Version() string {
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(manifest, &pkg); err != nil {
		panic(err)
	}
	return pkg.Version
}
