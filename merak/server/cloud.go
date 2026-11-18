package server

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/storage/vault"
)

func (s *Server) loginCloud(ctx context.Context, params protocol.CloudLoginParams) (wire.CloudStatus, error) {
	s.cloudMu.Lock()
	defer s.cloudMu.Unlock()
	if !params.Dev || s.dataDir == "" {
		return wire.CloudStatus{}, errors.New("MRK-3001")
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
	creds, err := cloudlink.LoginDevelopment(ctx, endpoint, device)
	if err != nil {
		return wire.CloudStatus{}, err
	}
	storage := vault.New(filepath.Join(s.dataDir, "credentials"))
	body, _ := json.Marshal(creds)
	if err = storage.Set(ctx, "cloud", body); err != nil {
		return wire.CloudStatus{}, errors.New("MRK-1007")
	}
	if err = s.engine.DisconnectCloud(ctx); err != nil {
		return wire.CloudStatus{}, err
	}
	if err = s.engine.ConnectCloud(ctx, creds); err != nil {
		return wire.CloudStatus{}, err
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
	if err := vault.New(filepath.Join(s.dataDir, "credentials")).Delete(ctx, "cloud"); err != nil {
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
		body, err := vault.New(filepath.Join(s.dataDir, "credentials")).Get(ctx, "cloud")
		if err != nil {
			return
		}
		var creds wire.Credentials
		if json.Unmarshal(body, &creds) == nil {
			_ = s.engine.ConnectCloud(ctx, creds)
		}
	}()
}
