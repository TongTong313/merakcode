package migrate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// The structs below read only the fields of the v0.3 formats that the migration uses; the formats are in
// packages/engine/src/agent/session/{index,message}.ts and infra/storage/db.ts of v0.3.

type v03Session struct {
	ID              string `json:"id"`
	Slug            string `json:"slug"`
	Directory       string `json:"directory"`
	ParentID        string `json:"parentID"`
	Title           string `json:"title"`
	PermissionLevel string `json:"permissionLevel"`
	Time            struct {
		Created  int64 `json:"created"`
		Updated  int64 `json:"updated"`
		Archived int64 `json:"archived"`
	} `json:"time"`
	Metadata map[string]json.RawMessage `json:"metadata"`
}

// isGroup says that the conversation is the chat of a collaboration group.
func (s v03Session) isGroup() bool {
	raw, ok := s.Metadata["group"]
	return ok && string(raw) == "true"
}

type v03Message struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	Time struct {
		Created   int64 `json:"created"`
		Completed int64 `json:"completed"`
	} `json:"time"`
	// Model is the provider and model of a user message; an assistant message names them directly.
	Model struct {
		ProviderID string `json:"providerID"`
		ModelID    string `json:"modelID"`
	} `json:"model"`
	ProviderID      string          `json:"providerID"`
	ModelID         string          `json:"modelID"`
	PermissionLevel string          `json:"permissionLevel"`
	Variant         string          `json:"variant"`
	Summary         json.RawMessage `json:"summary"`
}

// isSummary says that an assistant message holds the summary that a compaction wrote.
func (m v03Message) isSummary() bool { return m.Role == "assistant" && string(m.Summary) == "true" }

type v03Part struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Synthetic bool            `json:"synthetic"`
	Ignored   bool            `json:"ignored"`
	Mime      string          `json:"mime"`
	Filename  string          `json:"filename"`
	URL       string          `json:"url"`
	CallID    string          `json:"callID"`
	Tool      string          `json:"tool"`
	State     json.RawMessage `json:"state"`
	Tokens    struct {
		Input     int `json:"input"`
		Output    int `json:"output"`
		Reasoning int `json:"reasoning"`
		Cache     struct {
			Read  int `json:"read"`
			Write int `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
}

type v03ToolState struct {
	Status string          `json:"status"`
	Input  json.RawMessage `json:"input"`
	Output string          `json:"output"`
	Error  string          `json:"error"`
	Time   struct {
		Start int64 `json:"start"`
		End   int64 `json:"end"`
	} `json:"time"`
	Attachments []v03Part `json:"attachments"`
}

type v03Todo struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

type v03Seat struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Role    string `json:"role"`
	Duty    string `json:"duty"`
	Product string `json:"product"`
	Leader  bool   `json:"leader"`
}

type v03Group struct {
	Seats []v03Seat `json:"seats"`
}

type v03Plan struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Status  string `json:"status"`
}

func ms(value int64) time.Time { return time.UnixMilli(value).UTC() }

// defaultTitle matches the title v0.3 gave a conversation until a model named it.
var defaultTitle = regexp.MustCompile(`^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

// decodeError says which stored item could not be read; it never carries the item.
type decodeError struct{ kind, id string }

func (e decodeError) Error() string { return fmt.Sprintf("%s %s is not valid JSON", e.kind, e.id) }

func decode[T any](kind, id, data string) (T, error) {
	var value T
	if err := json.Unmarshal([]byte(data), &value); err != nil {
		return value, decodeError{kind, id}
	}
	return value, nil
}

// projectKey is how v0.3 named the directory of a project's memory: the path with its separators and characters a
// file name cannot hold turned into dashes.
func projectKey(path string) string {
	key := path
	if len(key) >= 2 && key[1] == ':' && (key[0] >= 'a' && key[0] <= 'z' || key[0] >= 'A' && key[0] <= 'Z') {
		key = key[:1] + key[2:]
	}
	var out strings.Builder
	dash := false
	for _, r := range key {
		if strings.ContainsRune("<>:\"/\\|?*", r) || r < 0x20 {
			if !dash {
				out.WriteByte('-')
			}
			dash = true
			continue
		}
		out.WriteRune(r)
		dash = r == '-'
	}
	key = strings.Trim(out.String(), "-")
	for strings.Contains(key, "--") {
		key = strings.ReplaceAll(key, "--", "-")
	}
	if runes := []rune(key); len(runes) > 180 {
		key = string(runes[:180])
	}
	if key == "" {
		return "project"
	}
	return key
}
