// Package configfile reads and saves the global configuration file.
package configfile

import (
	"os"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/infra/config"
)

// Open reads the global configuration of a root directory: merakcode.jsonc, or merakcode.json when that is the file
// that exists. A missing file is an empty configuration; the first change creates merakcode.jsonc.
func Open(root string) (*config.Store, error) {
	path := filepath.Join(root, "merakcode.jsonc")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if _, err := os.Stat(filepath.Join(root, "merakcode.json")); err == nil {
			path = filepath.Join(root, "merakcode.json")
		}
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return config.New(path, nil, fileSaver{path})
	}
	if err != nil {
		return nil, err
	}
	return config.New(path, data, fileSaver{path})
}

type fileSaver struct{ path string }

func (s fileSaver) Save(data []byte) error {
	return replaceFile(s.path, data)
}

func replaceFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
