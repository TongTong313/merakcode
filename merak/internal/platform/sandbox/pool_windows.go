package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type windowsLease struct {
	account     windowsAccount
	lock        *os.File
	mu          sync.Mutex
	closed      bool
	writePaths  []string
	readDenials []string
	deniedRules map[string]bool
	ancestors   []string
	journal     string
}

func cleanWindowsClaims(directory string, accounts []windowsAccount) error {
	for _, account := range accounts {
		file, err := os.OpenFile(filepath.Join(directory, "lease-"+account.Name+".lock"), os.O_RDWR|os.O_CREATE, 0600)
		if err != nil {
			return err
		}
		err = windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, new(windows.Overlapped))
		if err != nil {
			file.Close()
			if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
				continue
			}
			return err
		}
		lease := windowsLease{account: account, lock: file, journal: file.Name() + ".json"}
		if err := lease.Close(); err != nil {
			file.Close()
			return err
		}
	}
	return nil
}

func (l *windowsLease) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	failure := errors.Join(clearWindowsLeaseWrites(l.journal, l.account.SID), clearWindowsLeaseAccess(l.journal+".deny", l.account.SID, "/remove:d"), clearWindowsLeaseAccess(l.journal+".ancestors", l.account.SID, "directory"))
	if failure != nil {
		return failure
	}
	return l.lock.Close()
}

func (l *Launcher) windowsReadDenials(ctx context.Context, paths []string) error {
	return l.windowsDenyAccess(ctx, paths, "R")
}

func (l *Launcher) windowsDenyAccess(ctx context.Context, paths []string, rights string) error {
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
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return err
		}
		key := rights + "\x00" + path
		if lease.deniedRules[key] {
			continue
		}
		found := false
		for _, existing := range lease.readDenials {
			if existing == path {
				found = true
				break
			}
		}
		if !found {
			lease.readDenials = append(lease.readDenials, path)
		}
		if err := writeWindowsLeaseJournal(lease.journal+".deny", lease.readDenials); err != nil {
			return err
		}
		cmd := process.Command(ctx, "", filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"), path, "/deny", "*"+lease.account.SID+":(OI)(CI)"+rights)
		if err := cmd.Run(); err != nil {
			return err
		}
		if lease.deniedRules == nil {
			lease.deniedRules = make(map[string]bool)
		}
		lease.deniedRules[key] = true
	}
	return nil
}

func clearWindowsLeaseWrites(journal, sid string) error {
	return clearWindowsLeaseAccess(journal, sid, "/remove:g")
}

func clearWindowsLeaseAccess(journal, sid, operation string) error {
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
	if err := (Profile{ReadDeny: paths}).Validate(); err != nil {
		return err
	}
	var failure error
	for _, path := range paths {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		}
		if operation == "directory" {
			failure = errors.Join(failure, windowsDirectoryAccess(path, sid, false))
			continue
		}
		command := process.Command(context.Background(), "", filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"), path, operation, "*"+sid)
		failure = errors.Join(failure, command.Run())
	}
	if failure != nil {
		return failure
	}
	return os.Remove(journal)
}

func (l *Launcher) windowsAncestorAccess(paths []string) error {
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
	password, err := accountPassword(lease.account)
	if err != nil {
		return err
	}
	ancestors, err := windowsUnreadableAncestors(lease.account.Name, password, paths)
	if err != nil {
		return err
	}
	for _, path := range ancestors {
		lease.ancestors = append(lease.ancestors, path)
		if err := writeWindowsLeaseJournal(lease.journal+".ancestors", lease.ancestors); err != nil {
			return err
		}
		if err := windowsDirectoryAccess(path, lease.account.SID, true); err != nil {
			return err
		}
	}
	return nil
}

func writeWindowsLeaseJournal(path string, entries any) error {
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
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		rights := "M"
		if info.IsDir() {
			rights = "(OI)(CI)M"
		}
		command := process.Command(ctx, "", filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"), path, "/grant", "*"+lease.account.SID+":"+rights)
		if err := command.Run(); err != nil {
			return err
		}
	}
	return nil
}

func (l *Launcher) windowsAccount(ctx context.Context, project string) (windowsAccount, error) {
	defer func() { l.mu.Lock(); l.waitingAccount = false; l.mu.Unlock() }()
	manifest, err := readWindowsAccounts(l.StateDir)
	if err != nil {
		return windowsAccount{}, err
	}
	project = strings.ToUpper(filepath.Clean(project))
	l.mu.Lock()
	preferred := l.previousAccount
	l.mu.Unlock()
	histories := make(map[string]map[string]int64)
	for _, account := range manifest.Accounts {
		history, err := readWindowsAccountHistory(l.StateDir, account.Name)
		if err != nil {
			return windowsAccount{}, err
		}
		histories[account.Name] = history
	}
	slices.SortStableFunc(manifest.Accounts, func(a, b windowsAccount) int {
		if a.Name == preferred {
			return -1
		}
		if b.Name == preferred {
			return 1
		}
		first, second := histories[a.Name][project], histories[b.Name][project]
		if first < second {
			return -1
		}
		if first > second {
			return 1
		}
		return 0
	})
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
			if err := errors.Join(clearWindowsLeaseWrites(lease.journal, account.SID), clearWindowsLeaseAccess(lease.journal+".deny", account.SID, "/remove:d"), clearWindowsLeaseAccess(lease.journal+".ancestors", account.SID, "directory")); err != nil {
				file.Close()
				return windowsAccount{}, err
			}
			history, err := readWindowsAccountHistory(l.StateDir, account.Name)
			if err != nil {
				file.Close()
				return windowsAccount{}, err
			}
			history[project] = time.Now().UnixNano()
			if err := writeWindowsLeaseJournal(filepath.Join(l.StateDir, "history-"+account.Name+".json"), history); err != nil {
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
			l.previousAccount = account.Name
			l.idleSince = time.Now()
			l.mu.Unlock()
			return account, nil
		}
		if l.ReclaimAccount != nil {
			reclaimed, err := l.ReclaimAccount()
			if err != nil {
				return windowsAccount{}, err
			}
			if reclaimed {
				continue
			}
		}
		l.mu.Lock()
		l.waitingAccount = true
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return windowsAccount{}, ctx.Err()
		case <-lifetime.Done():
			return windowsAccount{}, lifetime.Err()
		case <-ticker.C:
		}
	}
}

func readWindowsAccountHistory(directory, account string) (map[string]int64, error) {
	history := make(map[string]int64)
	body, err := os.ReadFile(filepath.Join(directory, "history-"+account+".json"))
	if os.IsNotExist(err) {
		return history, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, &history); err != nil {
		return nil, err
	}
	if history == nil {
		return nil, errors.New("invalid sandbox account history")
	}
	return history, nil
}
