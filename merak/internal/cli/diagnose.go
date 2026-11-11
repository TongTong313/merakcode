package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/diagnose"
	"github.com/TongTong313/merakcode/merak/internal/localstore"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func diagnoseCommand(args []string, out io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("diagnose", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	path := flags.String("out", "merak-diag.zip", "")
	session := flags.String("session", "", "")
	group := flags.String("group", "", "")
	days := flags.Int("days", 3, "")
	config := flags.Bool("with-config", false, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *path == "" || *days < 1 || *days > 30 {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request := diagnose.Request{Days: *days, Session: event.ID(*session), Group: event.ID(*group), WithConfig: *config}
	if err := writeDiagnostic(ctx, request, *path); err != nil {
		ui.failure(out, errorcode.DiagnosticsFailed)
		return 1
	}
	_, err := fmt.Fprintf(out, ui.text("diagnosticSaved"), *path)
	if err != nil {
		return 1
	}
	return 0
}

func writeDiagnostic(ctx context.Context, request diagnose.Request, path string) error {
	home, err := dataHome()
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".merak-diag-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	defer file.Close()
	client, connectErr := connectEngine(ctx, home)
	if connectErr == nil {
		defer client.Close()
		var bundle protocol.DiagnosticsResult
		params := protocol.DiagnosticsParams{Days: request.Days, Session: request.Session, Group: request.Group, WithConfig: request.WithConfig}
		if err := client.Call(ctx, "diagnostics.bundle", params, &bundle); err != nil {
			return err
		}
		offset, total := 0, -1
		for {
			var chunk protocol.BlobReadResult
			if err := client.Call(ctx, "blob.read", protocol.BlobReadParams{Ref: bundle.Ref, Offset: offset, Limit: 1 << 20}, &chunk); err != nil {
				return err
			}
			if chunk.Offset != offset || chunk.Total < 0 || chunk.Total > 64<<20 || total >= 0 && chunk.Total != total {
				return errors.New("invalid diagnostic blob")
			}
			total = chunk.Total
			if offset+len(chunk.Data) > total || len(chunk.Data) == 0 && offset < total {
				return errors.New("incomplete diagnostic blob")
			}
			if _, err := file.Write(chunk.Data); err != nil {
				return err
			}
			offset += len(chunk.Data)
			if offset == total {
				break
			}
		}
	} else {
		root, err := platformlog.Root()
		if err != nil {
			return err
		}
		settings, err := configRoot()
		if err != nil {
			return err
		}
		bundler := diagnose.Bundler{DataDir: home, ConfigRoot: settings, LogRoot: root}
		if request.Session != "" || request.Group != "" {
			path := filepath.Join(home, "merak.db")
			if _, err := os.Stat(path); err != nil {
				return err
			}
			local, err := localstore.Open(path)
			if err != nil {
				return err
			}
			defer local.Close()
			bundler.Find = local.Find
		}
		if err := bundler.Bundle(ctx, request, file); err != nil {
			return err
		}
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
