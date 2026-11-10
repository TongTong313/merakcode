package server

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) loginCloud(ctx context.Context, params protocol.CloudLoginParams) (protocol.CloudStatus, error) {
	s.cloudMu.Lock()
	defer s.cloudMu.Unlock()
	if !params.Dev || s.dataDir == "" {
		return protocol.CloudStatus{}, errors.New("MRK-3001")
	}
	endpoint := params.Endpoint
	if endpoint == "" {
		endpoint = s.configuration().Cloud.Endpoint
	}
	if endpoint == "" {
		endpoint = "ws://127.0.0.1:8787"
	}
	device := s.engine.CloudStatus().Device
	if device == "" {
		device = string(event.NewID())
	}
	creds, err := cloud.LoginDevelopment(ctx, endpoint, device)
	if err != nil {
		return protocol.CloudStatus{}, err
	}
	storage := credential.New(filepath.Join(s.dataDir, "credentials"))
	body, _ := json.Marshal(creds)
	if err = storage.Set(ctx, "cloud", body); err != nil {
		return protocol.CloudStatus{}, errors.New("MRK-1007")
	}
	if err = s.engine.DisconnectCloud(ctx); err != nil {
		return protocol.CloudStatus{}, err
	}
	if err = s.engine.ConnectCloud(ctx, creds); err != nil {
		return protocol.CloudStatus{}, err
	}
	return s.engine.CloudStatus(), nil
}
func (s *Server) logoutCloud(ctx context.Context) error {
	s.cloudMu.Lock()
	defer s.cloudMu.Unlock()
	if err := s.engine.DisconnectCloud(ctx); err != nil {
		return err
	}
	if s.dataDir == "" {
		return nil
	}
	if err := credential.New(filepath.Join(s.dataDir, "credentials")).Delete(ctx, "cloud"); err != nil {
		return errors.New("MRK-1007")
	}
	return nil
}
func (s *Server) restoreCloud() {
	go func() {
		s.cloudMu.Lock()
		defer s.cloudMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		body, err := credential.New(filepath.Join(s.dataDir, "credentials")).Get(ctx, "cloud")
		if err != nil {
			return
		}
		var creds cloud.Credentials
		if json.Unmarshal(body, &creds) == nil {
			_ = s.engine.ConnectCloud(ctx, creds)
		}
	}()
}
