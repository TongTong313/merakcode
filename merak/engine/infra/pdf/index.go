package pdf

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var names = regexp.MustCompile(`/([^\s<>\[\]()/]+)`)

// The upstream reader cannot bound compressed indexes or follow cyclic Prev chains.
// Reject those formats before calling it; adapters report the document as dropped.
func checkIndex(data []byte) error {
	marker := bytes.LastIndex(data, []byte("startxref"))
	if marker < 0 {
		return ErrInvalid
	}
	fields := bytes.Fields(data[marker+9:])
	if len(fields) == 0 {
		return ErrInvalid
	}
	offset, err := strconv.Atoi(string(fields[0]))
	if err != nil || offset < 0 || offset >= marker {
		return ErrInvalid
	}
	index := data[offset:marker]
	if !bytes.HasPrefix(index, []byte("xref")) {
		return ErrInvalid
	}
	end := bytes.Index(index, []byte("trailer"))
	if end < 0 {
		return ErrInvalid
	}
	rows := bytes.NewReader(index[4:end])
	count := 0
	for rows.Len() > 0 {
		var start, size int
		if _, err := fmt.Fscan(rows, &start, &size); err != nil {
			break
		}
		if start < 0 || size < 0 || start > 100000 || size > 100000-start || count+size > 100000 {
			return ErrLimit
		}
		count += size
		for range size {
			var positionText, generationText, kind string
			if _, err := fmt.Fscan(rows, &positionText, &generationText, &kind); err != nil {
				return ErrInvalid
			}
			position, positionErr := strconv.Atoi(positionText)
			generation, generationErr := strconv.Atoi(generationText)
			if positionErr != nil || generationErr != nil || position < 0 || position >= len(data) || generation < 0 || kind != "f" && kind != "n" {
				return ErrInvalid
			}
		}
	}
	for _, match := range names.FindAllSubmatch(index[end+7:], -1) {
		var name strings.Builder
		raw := string(match[1])
		for i := 0; i < len(raw); i++ {
			if raw[i] == '#' && i+2 < len(raw) {
				value, err := strconv.ParseUint(raw[i+1:i+3], 16, 8)
				if err != nil {
					return ErrInvalid
				}
				name.WriteByte(byte(value))
				i += 2
				continue
			}
			name.WriteByte(raw[i])
		}
		switch name.String() {
		case "Prev", "XRefStm", "Encrypt":
			return ErrInvalid
		}
	}
	return nil
}
