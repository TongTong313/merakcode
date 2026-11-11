package tool

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
)

func decodeInput(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}

func resolvePath(workdir, name string) string {
	if filepath.IsAbs(name) {
		return filepath.Clean(name)
	}
	return filepath.Join(workdir, name)
}

// Decode reads the input of a tool call into target and refuses unknown fields and trailing data.
func Decode(data []byte, target any) error { return decodeInput(data, target) }

// Fail is the result of a tool that could not do what was asked; the model sees the error text.
func Fail(err error) Result { return failure(err) }
