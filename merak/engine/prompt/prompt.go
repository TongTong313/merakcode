// Package prompt composes stable system instructions for a session.
package prompt

import (
	"embed"
	"fmt"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

//go:embed templates/*.md
var templates embed.FS

type Environment struct {
	OS      string
	Shell   string
	Workdir string
}

type Situation struct {
	Role        string
	System      string
	Environment Environment
	// Skills is the list of skills the model can load; it is fixed when the session starts.
	Skills string
	// Personal are the user's own rules; they come before the project's.
	Personal     []string
	Instructions []string
	Deferred     []tool.Spec
}

type Composer struct{}

func (Composer) System(sit Situation) string {
	role := "worker"
	if sit.Role == "leader" {
		role = "leader"
	}
	identity, _ := templates.ReadFile("templates/" + role + ".md")
	sections := []string{strings.TrimSpace(string(identity)), "Role: " + role}
	if sit.System != "" {
		sections = append(sections, sit.System)
	}
	sections = append(sections, fmt.Sprintf("Environment:\nOS: %s\nShell: %s\nWorking directory: %s", sit.Environment.OS, sit.Environment.Shell, sit.Environment.Workdir))
	if len(sit.Personal) > 0 {
		sections = append(sections, "Personal rules (set by the user for every project):\n- "+strings.Join(sit.Personal, "\n- "))
	}
	if len(sit.Instructions) > 0 {
		sections = append(sections, "Project instructions:\n"+strings.Join(sit.Instructions, "\n\n"))
	}
	if sit.Skills != "" {
		sections = append(sections, sit.Skills)
	}
	if len(sit.Deferred) > 0 {
		lines := []string{"Deferred tools:"}
		for _, spec := range sit.Deferred {
			lines = append(lines, "- "+spec.Name+": "+strings.Join(strings.Fields(spec.Description), " "))
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}
	return strings.Join(sections, "\n\n")
}
