package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type windowsLease struct {
	account    windowsAccount
	lock       *os.File
	mu         sync.Mutex
	closed     bool
	writePaths []string
	journal    string
}

func (l *windowsLease) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	if err := clearWindowsLeaseWrites(l.journal, l.account.SID); err != nil {
		return err
	}
	return l.lock.Close()
}

func clearWindowsLeaseWrites(journal, sid string) error {
	body, err := os.ReadFile(journal)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var paths []string
	if err := json.Unmarshal(body, &paths); err != nil {
		return err
	}
	if err := (Profile{WriteAllow: paths}).Validate(); err != nil {
		return err
	}
	var failure error
	for _, path := range paths {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		}
		command := process.Command(context.Background(), "", filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"), path, "/remove:g", "*"+sid)
		failure = errors.Join(failure, command.Run())
	}
	if failure != nil {
		return failure
	}
	return os.Remove(journal)
}

func writeWindowsLeaseJournal(path string, entries []string) error {
	file, err := os.CreateTemp(filepath.Dir(path), "lease-journal-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := json.NewEncoder(file).Encode(entries); err != nil {
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

func (l *Launcher) windowsWriteAccess(ctx context.Context, paths []string) error {
	l.mu.Lock()
	lease, ok := l.lease.(*windowsLease)
	l.mu.Unlock()
	if !ok {
		return errors.New("sandbox account is not leased")
	}
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed {
		return errors.New("sandbox claim has ended")
	}
	for _, path := range paths {
		found := false
		for _, known := range lease.writePaths {
			if known == path {
				found = true
				break
			}
		}
		if found {
			continue
		}
		lease.writePaths = append(lease.writePaths, path)
		if err := writeWindowsLeaseJournal(lease.journal, lease.writePaths); err != nil {
			return err
		}
		command := process.Command(ctx, "", filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"), path, "/grant", "*"+lease.account.SID+":(OI)(CI)M")
		if err := command.Run(); err != nil {
			return err
		}
	}
	return nil
}

func (l *Launcher) windowsAccount(ctx context.Context) (windowsAccount, error) {
	manifest, err := readWindowsAccounts(l.StateDir)
	if err != nil {
		return windowsAccount{}, err
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return windowsAccount{}, errors.New("sandbox claim has ended")
	}
	if lease, ok := l.lease.(*windowsLease); ok {
		l.mu.Unlock()
		return lease.account, nil
	}
	if l.lifetime == nil {
		l.lifetime, l.endLifetime = context.WithCancel(context.Background())
	}
	lifetime := l.lifetime
	l.mu.Unlock()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, account := range manifest.Accounts {
			if err := ctx.Err(); err != nil {
				return windowsAccount{}, err
			}
			if err := lifetime.Err(); err != nil {
				return windowsAccount{}, err
			}
			file, err := os.OpenFile(filepath.Join(l.StateDir, "lease-"+account.Name+".lock"), os.O_RDWR|os.O_CREATE, 0600)
			if err != nil {
				return windowsAccount{}, err
			}
			err = windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, new(windows.Overlapped))
			if err != nil {
				file.Close()
				if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
					continue
				}
				return windowsAccount{}, err
			}
			lease := &windowsLease{account: account, lock: file, journal: file.Name() + ".json"}
			if err := clearWindowsLeaseWrites(lease.journal, account.SID); err != nil {
				file.Close()
				return windowsAccount{}, err
			}
			l.mu.Lock()
			if l.closed {
				l.mu.Unlock()
				lease.Close()
				return windowsAccount{}, errors.New("sandbox claim has ended")
			}
			if current, ok := l.lease.(*windowsLease); ok {
				l.mu.Unlock()
				lease.Close()
				return current.account, nil
			}
			l.lease = lease
			l.mu.Unlock()
			return account, nil
		}
		select {
		case <-ctx.Done():
			return windowsAccount{}, ctx.Err()
		case <-lifetime.Done():
			return windowsAccount{}, lifetime.Err()
		case <-ticker.C:
		}
	}
}
