package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestDiagnosticsReturnsAReferenceAndDownloadsTheArchiveInChunks(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "desktop", Version: "1.2.3"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var bundle struct {
		Ref string `json:"ref"`
	}
	if err := client.Call(ctx, "diagnostics.bundle", map[string]any{}, &bundle); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(bundle.Ref, "mrk://blob/") {
		t.Fatalf("reference=%q", bundle.Ref)
	}
	var output bytes.Buffer
	for {
		var chunk struct {
			Data   []byte `json:"data"`
			Offset int    `json:"offset"`
			Total  int    `json:"total"`
		}
		if err := client.Call(ctx, "blob.read", map[string]any{"ref": bundle.Ref, "offset": output.Len(), "limit": 97}, &chunk); err != nil {
			t.Fatal(err)
		}
		if chunk.Offset != output.Len() || len(chunk.Data) > 97 || len(chunk.Data) == 0 {
			t.Fatalf("chunk=%+v", chunk)
		}
		output.Write(chunk.Data)
		if output.Len() == chunk.Total {
			break
		}
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), instance.Info.Token) {
			t.Fatal("download leaked connection token")
		}
		if file.Name == "versions.json" {
			var versions map[string]string
			if err := json.Unmarshal(body, &versions); err != nil {
				t.Fatal(err)
			}
			if versions["desktop"] != "1.2.3" {
				t.Fatalf("connected desktop version=%q", versions["desktop"])
			}
		}
	}
}
