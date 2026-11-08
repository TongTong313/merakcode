package anthropic_test

import (
	"bytes"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestProviderSDKImportsStayInsideTheAdapter(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate module")
	}
	command := exec.Command("go", "list", "-deps", "-json", "./...")
	command.Dir = filepath.Join(filepath.Dir(file), "..", "..", "..")
	body, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	const module = "github.com/TongTong313/merakcode/merak/"
	for {
		var pkg struct {
			ImportPath string
			Imports    []string
		}
		if err := decoder.Decode(&pkg); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(pkg.ImportPath, module) || pkg.ImportPath == module+"engine/model/anthropic" {
			continue
		}
		for _, dependency := range pkg.Imports {
			if strings.HasPrefix(dependency, "github.com/anthropics/anthropic-sdk-go") {
				t.Errorf("%s imports provider SDK %s", pkg.ImportPath, dependency)
			}
		}
	}
}
