// Package task defines work assignments and their bounded reports.
package task

import (
	"bytes"
	"encoding/json"
	"errors"
	"path"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

type Verdict string

const (
	VerdictDone        Verdict = "done"
	VerdictBlocked     Verdict = "blocked"
	VerdictNeedsReview Verdict = "needs_review"
	VerdictFailed      Verdict = "failed"
)

type Claim struct {
	ID         event.ID    `json:"id"`
	Member     event.ID    `json:"member"`
	Task       event.ID    `json:"task"`
	Role       ClaimRole   `json:"role"`
	Scope      []string    `json:"scope,omitempty"`
	Session    event.ID    `json:"session,omitempty"`
	Status     ClaimStatus `json:"status"`
	Report     *Report     `json:"report,omitempty"`
	Workspace  event.ID    `json:"workspace,omitempty"`
	Integrated string      `json:"integrated,omitempty"`
	Feedback   string      `json:"feedback,omitempty"`
	Published  []event.ID  `json:"published,omitempty"`
}

func (r Report) Validate() error {
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if secret.Contains(string(body)) {
		return errors.New("MRK-5001: remove credentials before submitting the report")
	}
	if strings.TrimSpace(r.Summary) == "" {
		return errors.New("report summary is required")
	}
	if len([]rune(r.Summary)) > 1200 {
		return errors.New("report summary exceeds 1200 characters; shorten it and submit again")
	}
	if len(r.Questions) > 5 || len(r.Next) > 5 {
		return errors.New("report questions and next steps each allow at most 5 items")
	}
	for _, change := range r.Changes {
		if !relativeFile(change.Path) {
			return errors.New("change paths must be project-relative file paths using forward slashes")
		}
		if change.Added < 0 || change.Removed < 0 {
			return errors.New("change counts must be nonnegative")
		}
	}
	for _, check := range r.Checks {
		if strings.TrimSpace(check.Command) == "" {
			return errors.New("check command is required")
		}
	}
	for _, artifact := range r.Artifacts {
		if !relativeFile(artifact.Path) {
			return errors.New("artifact paths must be project-relative file paths using forward slashes")
		}
	}
	switch r.Verdict {
	case VerdictDone, VerdictBlocked, VerdictNeedsReview, VerdictFailed:
		return nil
	default:
		return errors.New("report verdict must be done, blocked, needs_review or failed")
	}
}

func relativeFile(name string) bool {
	clean := path.Clean(name)
	return name != "" && !path.IsAbs(name) && clean != "." && clean != ".." && !strings.HasPrefix(clean, "../") && !strings.ContainsAny(name, "\\:\x00")
}

type Report struct {
	Usage       model.Usage  `json:"usage"`
	Changes     []FileChange `json:"changes,omitempty"`
	Checks      []Check      `json:"checks,omitempty"`
	Questions   []string     `json:"questions,omitempty"`
	Next        []string     `json:"next,omitempty"`
	Artifacts   []Artifact   `json:"artifacts,omitempty"`
	Claim       event.ID     `json:"claim"`
	Verdict     Verdict      `json:"verdict"`
	Summary     string       `json:"summary"`
	Synthesized bool         `json:"synthesized,omitempty"`
}

type FileChange struct {
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
}

type Check struct {
	Command  string `json:"command"`
	ExitCode int    `json:"exitCode"`
}

// UnmarshalJSON requires an explicit exit code so missing results cannot imply success.
func (c *Check) UnmarshalJSON(body []byte) error {
	var input struct {
		Command  string `json:"command"`
		ExitCode *int   `json:"exitCode"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return err
	}
	if input.ExitCode == nil {
		return errors.New("check exitCode is required")
	}
	*c = Check{Command: input.Command, ExitCode: *input.ExitCode}
	return nil
}
