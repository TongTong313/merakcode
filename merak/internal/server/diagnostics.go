package server

import (
	"bytes"
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/internal/diagnose"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) diagnostics(ctx context.Context, params protocol.DiagnosticsParams) (protocol.DiagnosticsResult, error) {
	bundler := diagnose.Bundler{DataDir: s.dataDir, LogRoot: s.logRoot, Find: s.engine.FindEvents, Models: s.engine.ModelCatalog()}
	s.mu.Lock()
	for _, version := range s.desktops {
		bundler.DesktopVersion = version
		break
	}
	s.mu.Unlock()
	var output bundleBuffer
	err := bundler.Bundle(ctx, diagnose.Request{Days: params.Days, Session: params.Session, Group: params.Group, WithConfig: params.WithConfig}, &output)
	if err != nil {
		return protocol.DiagnosticsResult{}, err
	}
	ref, err := s.engine.PutBlob(ctx, "diagnostics.zip", output.Bytes())
	return protocol.DiagnosticsResult{Ref: ref}, err
}

type bundleBuffer struct{ bytes.Buffer }

func (b *bundleBuffer) Write(data []byte) (int, error) {
	if len(data) > (64<<20)-b.Len() {
		return 0, errors.New("diagnostic archive exceeds its limit")
	}
	return b.Buffer.Write(data)
}
