package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Store holds the global configuration file under a root directory. An empty path keeps the value in memory only.
type Store struct {
	mu    sync.Mutex
	path  string
	text  []byte
	value Value
}

// Open reads the global configuration of a root directory: merakcode.jsonc, or merakcode.json when that is the file
// that exists. A missing file is an empty configuration; the first change creates merakcode.jsonc.
func Open(root string) (*Store, error) {
	s := &Store{path: filepath.Join(root, "merakcode.jsonc"), value: Value{Providers: map[string]Provider{}}}
	if _, err := os.Stat(s.path); os.IsNotExist(err) {
		if _, err := os.Stat(filepath.Join(root, "merakcode.json")); err == nil {
			s.path = filepath.Join(root, "merakcode.json")
		}
	}
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	value, err := load(data)
	if err != nil {
		return nil, err
	}
	s.text, s.value = data, value
	return s, nil
}

// load parses a configuration file and validates what it contains.
func load(data []byte) (Value, error) {
	top, err := parseFile(data)
	if err != nil {
		return Value{}, err
	}
	value, err := buildValue(top)
	if err != nil {
		return Value{}, err
	}
	if err := Validate(value); err != nil {
		return Value{}, err
	}
	return value, nil
}

func (s *Store) Private() Value {
	s.mu.Lock()
	defer s.mu.Unlock()
	return clone(s.value)
}

func (s *Store) Get() Value { return public(s.Private()) }

func (s *Store) Update(patch Patch) (Value, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.update(patch)
}

// edit sets the value at a path of the file, or removes it when clear is set.
type edit struct {
	path  []string
	value any
	clear bool
}

func setList[T any](key string, list []T) edit {
	if len(list) == 0 {
		return edit{path: []string{key}, clear: true}
	}
	return edit{path: []string{key}, value: list}
}

// write applies the edits to the text of the file, checks that the result is a valid configuration and saves it. A
// rejected change leaves the file as it was.
func (s *Store) write(edits ...edit) error {
	text := s.text
	if len(bytes.TrimSpace(text)) == 0 {
		text = []byte("{\n}\n")
	}
	for _, change := range edits {
		var raw json.RawMessage
		if !change.clear {
			body, err := json.Marshal(change.value)
			if err != nil {
				return err
			}
			raw = body
		}
		next, err := setValue(text, change.path, raw)
		if err != nil {
			return err
		}
		text = next
	}
	value, err := load(text)
	if err != nil {
		return err
	}
	if s.path != "" {
		if err := replaceFile(s.path, text); err != nil {
			return err
		}
	}
	s.text, s.value = text, value
	return nil
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

func (s *Store) update(patch Patch) (Value, error) {
	var edits []edit
	text := func(key string, value *string) {
		if value == nil {
			return
		}
		if *value == "" {
			edits = append(edits, edit{path: []string{key}, clear: true})
			return
		}
		edits = append(edits, edit{path: []string{key}, value: *value})
	}
	text("model", patch.Model)
	text("small_model", patch.SmallModel)
	text("thinking", patch.Thinking)
	text("locale", patch.Locale)
	text("permissionMode", patch.PermissionMode)
	if patch.Log != nil {
		upper := strings.ToUpper(*patch.Log)
		text("logLevel", &upper)
	}
	if patch.Cloud != nil {
		edits = append(edits, edit{path: []string{"cloud"}, value: *patch.Cloud})
	}
	if patch.PermissionRules != nil {
		edits = append(edits, setList("permissionRules", *patch.PermissionRules))
	}
	if patch.PermissionGrants != nil {
		edits = append(edits, setList("permissionGrants", *patch.PermissionGrants))
	}
	if patch.Unconfined != nil {
		edits = append(edits, setList("unconfined", *patch.Unconfined))
	}
	if patch.AllowedHosts != nil {
		edits = append(edits, setList("allowedHosts", *patch.AllowedHosts))
	}
	if patch.DeniedHosts != nil {
		edits = append(edits, setList("deniedHosts", *patch.DeniedHosts))
	}
	ids := make([]string, 0, len(patch.Providers))
	for id := range patch.Providers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		change := patch.Providers[id]
		if change == nil {
			edits = append(edits, edit{path: []string{"provider", id}, clear: true}, disabledEdit(s.value, id, false))
			continue
		}
		edits = append(edits, providerEdits(s.value.Providers[id], id, *change)...)
		if change.Disabled != nil {
			edits = append(edits, disabledEdit(s.value, id, *change.Disabled))
		}
	}
	if err := s.write(edits...); err != nil {
		return Value{}, err
	}
	return public(clone(s.value)), nil
}

// ForProject returns the configuration that applies in a project directory: the global configuration with the
// project's own files on top. The result still has the keys and secrets; pass it through Public before sending it out.
func (s *Store) ForProject(dir string) (Value, error) {
	project, err := ReadProject(dir)
	if err != nil {
		return Value{}, err
	}
	return Merge(s.Private(), project), nil
}
