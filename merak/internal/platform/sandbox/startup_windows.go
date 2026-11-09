package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"time"
)

type windowsStartupMessage struct {
	Token string `json:"token"`
	Ready bool   `json:"ready"`
}

func (l *Launcher) windowsStartup(ctx context.Context) (*commandStartup, string, string, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, "", "", err
	}
	secret := rand.Text()
	lifetime, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(lifetime, func() { _ = listener.Close() })
	done := make(chan struct{})
	authenticated := make(chan struct{})
	var failure error
	go func() {
		defer close(done)
		defer listener.Close()
		defer stop()
		connection, err := listener.Accept()
		if err != nil {
			failure = err
			return
		}
		defer connection.Close()
		stop := context.AfterFunc(lifetime, func() { _ = connection.Close() })
		defer stop()
		_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
		var result windowsStartupMessage
		if err := json.NewDecoder(io.LimitReader(connection, 4096)).Decode(&result); err != nil {
			failure = err
			return
		}
		if result.Token != secret {
			failure = errors.New("MRK-5004")
			return
		}
		close(authenticated)
		_ = connection.SetDeadline(time.Time{})
		if !result.Ready {
			l.mu.Lock()
			l.runtimeFailure = true
			l.mu.Unlock()
			failure = errors.New("MRK-5004")
			if l.Unavailable != nil && ctx.Err() == nil {
				failure = l.Unavailable(ctx, Status{Backend: "windows-account", Network: "none", Reason: "MRK-5004"})
			}
			if err := json.NewEncoder(connection).Encode(failure == nil); err != nil && failure == nil {
				failure = err
			}
			return
		}
		failure = json.NewEncoder(connection).Encode(true)
	}()
	startup := &commandStartup{close: cancel, wait: func() error {
		timer := time.NewTimer(15 * time.Second)
		defer timer.Stop()
		connected := authenticated
		for {
			select {
			case <-done:
				return failure
			case <-lifetime.Done():
				return lifetime.Err()
			case <-connected:
				timer.Stop()
				connected = nil
			case <-timer.C:
				cancel()
				return errors.New("MRK-5004")
			}
		}
	}}
	return startup, listener.Addr().String(), secret, nil
}
