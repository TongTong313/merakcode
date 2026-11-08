// Package diagnose builds redacted diagnostic archives with explicit conversation opt-in.
package diagnose

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/store"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

type Request struct {
	Days       int      `json:"days,omitempty"`
	Session    event.ID `json:"session,omitempty"`
	Group      event.ID `json:"group,omitempty"`
	WithConfig bool     `json:"withConfig,omitempty"`
}

type Bundler struct {
	DataDir        string
	LogRoot        string
	DesktopVersion string
	Models         []catalog.Model
	Now            func() time.Time
	Find           func(context.Context, store.Query) ([]event.Event, error)
}

func (b Bundler) Bundle(ctx context.Context, req Request, out io.Writer) (runErr error) {
	if req.Days == 0 {
		req.Days = 3
	}
	if req.Days < 1 || req.Days > 30 {
		return errors.New("diagnostic log range must be between 1 and 30 days")
	}
	if (req.Session != "" || req.Group != "") && b.Find == nil {
		return store.ErrUnavailable
	}
	now := time.Now()
	if b.Now != nil {
		now = b.Now()
	}
	archive := zip.NewWriter(out)
	defer func() {
		if err := archive.Close(); runErr == nil {
			runErr = err
		}
	}()
	write := func(name string, value any) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		file, err := archive.Create(name)
		if err != nil {
			return err
		}
		return json.NewEncoder(file).Encode(secret.RedactValue(value))
	}
	versions := map[string]any{"merak": merak.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "go": runtime.Version()}
	if b.DesktopVersion != "" {
		versions["desktop"] = b.DesktopVersion
	}
	if err := write("versions.json", versions); err != nil {
		return err
	}
	connection := map[string]any{"status": "unavailable"}
	if b.DataDir != "" {
		if body, err := os.ReadFile(filepath.Join(b.DataDir, "engine.json")); err == nil {
			var info struct {
				Endpoint string `json:"endpoint"`
				PID      int    `json:"pid"`
				Protocol int    `json:"protocol"`
			}
			if err := json.Unmarshal(body, &info); err != nil {
				return errors.New("invalid engine connection file")
			}
			connection = map[string]any{"endpoint": info.Endpoint, "pid": info.PID, "protocol": info.Protocol}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if err := write("engine.json", connection); err != nil {
		return err
	}
	if req.WithConfig && b.DataDir != "" {
		body, err := os.ReadFile(filepath.Join(b.DataDir, "merakcode.json"))
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil {
			var config any
			if err := json.Unmarshal(body, &config); err != nil {
				return errors.New("invalid diagnostic configuration file")
			}
			if err := write("config/merakcode.json", config); err != nil {
				return err
			}
		}
	}
	if b.LogRoot != "" {
		cutoff := now.Add(-time.Duration(req.Days) * 24 * time.Hour)
		err := filepath.WalkDir(b.LogRoot, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				if os.IsNotExist(walkErr) {
					return nil
				}
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || filepath.Ext(path) != ".ndjson" {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.ModTime().Before(cutoff) {
				return nil
			}
			relative, err := filepath.Rel(b.LogRoot, path)
			if err != nil {
				return err
			}
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			defer file.Close()
			destination, err := archive.Create("logs/" + secret.Redact(filepath.ToSlash(relative)))
			if err != nil {
				return err
			}
			scanner := bufio.NewScanner(file)
			scanner.Buffer(make([]byte, 64*1024), 20<<20)
			for scanner.Scan() {
				if err := ctx.Err(); err != nil {
					return err
				}
				clean, err := platformlog.SanitizeRecord(scanner.Bytes())
				if err != nil {
					clean = []byte(`{"msg":"Unparseable log record omitted"}`)
				}
				if _, err := destination.Write(append(clean, '\n')); err != nil {
					return err
				}
			}
			return scanner.Err()
		})
		if err != nil {
			return err
		}
	}
	for _, scope := range []struct {
		name  string
		id    event.ID
		query store.Query
	}{
		{"session", req.Session, store.Query{Scope: event.Scope{Session: req.Session}}},
		{"group", req.Group, store.Query{Scope: event.Scope{Group: req.Group}}},
	} {
		if scope.id == "" {
			continue
		}
		facts, err := b.Find(ctx, scope.query)
		if err != nil {
			return err
		}
		file, err := archive.Create("events/" + scope.name + "-" + url.PathEscape(string(scope.id)) + ".jsonl")
		if err != nil {
			return err
		}
		for _, fact := range facts {
			if err := ctx.Err(); err != nil {
				return err
			}
			body, err := json.Marshal(fact)
			if err != nil {
				return err
			}
			var value any
			if err := json.NewDecoder(bytes.NewReader(body)).Decode(&value); err != nil {
				return err
			}
			if err := json.NewEncoder(file).Encode(secret.RedactValue(value)); err != nil {
				return err
			}
		}
	}
	models := b.Models
	if models == nil {
		models = catalog.New().List()
	}
	sources := make([]map[string]any, 0, len(models))
	for _, model := range models {
		sources = append(sources, map[string]any{"provider": model.Provider, "id": model.ID, "source": model.Source, "unknown": strings.Join(model.Unknown, ",")})
	}
	if err := write("model-catalog.json", sources); err != nil {
		return err
	}
	if err := write("member-catalog.json", []any{}); err != nil {
		return err
	}
	return write("sandbox-status.json", map[string]any{"status": "unavailable", "reason": "not_configured"})
}
