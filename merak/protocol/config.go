package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

type ModelListParams struct {
	Overrides []catalog.Override `json:"overrides,omitempty"`
}

type Config = config.Value
type ConfigPatch = config.Patch
type ConfigProvider = config.Provider
type ConfigModel = config.Model

type ModelRefreshParams struct {
	Provider string `json:"provider,omitempty"`
}

type ModelDiscoverParams struct {
	Provider ConfigProvider `json:"provider"`
}
