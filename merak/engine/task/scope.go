package task

import (
	"errors"
	"path"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

func validateAreas(areas []string) error {
	for _, area := range areas {
		if area == "" || strings.ContainsAny(area, "\\:\x00") || path.IsAbs(area) || path.Clean(area) == ".." || strings.HasPrefix(path.Clean(area), "../") {
			return errors.New("scope must contain project-relative paths or globs")
		}
		if _, err := path.Match(area, ""); err != nil {
			return err
		}
	}
	return nil
}

// A glob's literal directory is a conservative boundary for overlap checks.
func boundary(area string) string {
	if index := strings.IndexAny(area, "*?["); index >= 0 {
		area = path.Dir(area[:index] + "_")
	}
	return path.Clean(area)
}

func within(child, parent string) bool {
	return parent == "." || child == parent || strings.HasPrefix(child, parent+"/")
}

func validateScope(card Card, member event.ID, scope []string) error {
	if err := validateAreas(scope); err != nil {
		return err
	}
	for _, item := range scope {
		allowed := len(card.Areas) == 0
		for _, area := range card.Areas {
			if within(boundary(item), boundary(area)) {
				allowed = true
			}
		}
		if !allowed {
			return errors.New("claim scope is outside task areas")
		}
	}
	for _, existing := range card.Claims {
		if existing.Status == ClaimAbandoned {
			continue
		}
		if existing.Member == member {
			return errors.New("member already has a claim on this task")
		}
		if len(scope) == 0 || len(existing.Scope) == 0 {
			return errors.New("collaborating claims require explicit disjoint scopes")
		}
		for _, a := range existing.Scope {
			for _, b := range scope {
				if within(boundary(a), boundary(b)) || within(boundary(b), boundary(a)) {
					return errors.New("claim scope overlaps an existing claim")
				}
			}
		}
	}
	return nil
}

func claimStatus(claims []Claim) Status {
	status := Open
	for _, claim := range claims {
		if claim.Status == ClaimActive {
			return Running
		}
		if claim.Status == ClaimQueued {
			status = Queued
		}
		if claim.Status == ClaimReported && status == Open {
			status = Review
		}
	}
	return status
}
