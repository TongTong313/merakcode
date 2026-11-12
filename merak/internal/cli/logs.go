package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
)

// rotatedLog matches the files a process keeps after its log rotated, such as 12-34.1.ndjson.
var rotatedLog = regexp.MustCompile(`\.[0-9]+\.ndjson$`)

// logSelection says which log files a command reads: those of the production or the development folder, and of
// one component or of all of them.
type logSelection struct {
	mode      string
	component string
}

type logRecord struct {
	at   time.Time
	text string
}

// files lists the log files of the selection. A folder that does not exist yet has no files.
func (s logSelection) files() ([]string, error) {
	root, err := platformlog.Root()
	if err != nil {
		return nil, err
	}
	base := filepath.Join(root, s.mode)
	components := []string{s.component}
	if s.component == "" {
		entries, err := os.ReadDir(base)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		components = components[:0]
		for _, entry := range entries {
			if entry.IsDir() {
				components = append(components, entry.Name())
			}
		}
	}
	var files []string
	for _, component := range components {
		info, err := os.Stat(filepath.Join(base, component))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err == nil && !info.IsDir() {
			err = errors.New("a log folder is a file")
		}
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(filepath.Join(base, component))
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".ndjson") {
				files = append(files, filepath.Join(base, component, entry.Name()))
			}
		}
	}
	sort.Strings(files)
	return files, nil
}

// readRecords reads the complete lines of a file from offset on. It returns how far it read, which is the end of the
// last complete line: a line another process is still writing is read the next time.
func readRecords(path string, offset int64) ([]logRecord, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, offset, err
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, offset, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, offset, err
	}
	end := bytes.LastIndexByte(data, '\n') + 1
	var records []logRecord
	scanner := bufio.NewScanner(bytes.NewReader(data[:end]))
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for scanner.Scan() {
		text := strings.TrimRight(scanner.Text(), "\r")
		if strings.TrimSpace(text) == "" {
			continue
		}
		var row struct {
			Time time.Time `json:"time"`
		}
		_ = json.Unmarshal([]byte(text), &row)
		records = append(records, logRecord{at: row.Time, text: text})
	}
	return records, offset + int64(end), scanner.Err()
}

func sortRecords(records []logRecord) {
	sort.SliceStable(records, func(i, j int) bool { return records[i].at.Before(records[j].at) })
}

func lastRecords(records []logRecord, count int) []logRecord {
	sortRecords(records)
	if len(records) > count {
		return records[len(records)-count:]
	}
	return records
}

func writeRecords(output io.Writer, records []logRecord) error {
	for _, record := range records {
		if _, err := io.WriteString(output, record.text+"\n"); err != nil {
			return err
		}
	}
	return nil
}

// followLogs prints the last lines of the selection, then every line written after that, until ctx ends. A file that
// appears while following is read from its start; a file that rotated away is not read again.
func followLogs(ctx context.Context, output io.Writer, selection logSelection, lines int, interval time.Duration) error {
	files, err := selection.files()
	if err != nil {
		return err
	}
	offsets := map[string]int64{}
	var initial []logRecord
	for _, path := range files {
		records, end, err := readRecords(path, 0)
		if err != nil {
			return err
		}
		offsets[path] = end
		initial = append(initial, records...)
	}
	if err := writeRecords(output, lastRecords(initial, lines)); err != nil {
		return err
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		files, err := selection.files()
		if err != nil {
			return err
		}
		var fresh []logRecord
		for _, path := range files {
			offset, seen := offsets[path]
			if !seen && rotatedLog.MatchString(path) {
				if info, err := os.Stat(path); err == nil {
					offsets[path] = info.Size()
				}
				continue
			}
			if info, err := os.Stat(path); err == nil && info.Size() < offset {
				offset = 0
			}
			records, end, err := readRecords(path, offset)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			offsets[path] = end
			fresh = append(fresh, records...)
		}
		sortRecords(fresh)
		if err := writeRecords(output, fresh); err != nil {
			return err
		}
	}
}

// logsCommand runs merak logs: the last lines of the engine, command line and desktop logs, and with -f the lines
// that follow. The files are redacted when they are written, so the lines are printed as they are.
func logsCommand(args []string, output io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("logs", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	follow := flags.Bool("f", false, "")
	flags.BoolVar(follow, "follow", false, "")
	lines := flags.Int("lines", 50, "")
	component := flags.String("component", "", "")
	development := flags.Bool("development", false, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *lines < 1 || strings.ContainsAny(*component, `/\`) || *component == "." || *component == ".." {
		return 2
	}
	selection := logSelection{mode: "production", component: *component}
	if *development {
		selection.mode = "development"
	}
	files, err := selection.files()
	if err != nil {
		ui.failure(output, errorcode.LogsUnavailable)
		return 1
	}
	if len(files) == 0 && !*follow {
		if _, err := fmt.Fprint(output, ui.text("logsNone")); err != nil {
			return 1
		}
		return 0
	}
	if *follow {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if err := followLogs(ctx, output, selection, *lines, 250*time.Millisecond); err != nil {
			ui.failure(output, errorcode.LogsUnavailable)
			return 1
		}
		return 0
	}
	var records []logRecord
	for _, path := range files {
		found, _, err := readRecords(path, 0)
		if err != nil {
			ui.failure(output, errorcode.LogsUnavailable)
			return 1
		}
		records = append(records, found...)
	}
	if writeRecords(output, lastRecords(records, *lines)) != nil {
		return 1
	}
	return 0
}
