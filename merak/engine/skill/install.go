package skill

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

const (
	maxFile  = 4 << 20
	maxFiles = 200
)

// Offer is a skill a source has to give.
type Offer struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Files       []string `json:"files,omitempty"`
}

func fetch(ctx context.Context, address string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", address, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxFile+1))
	if err != nil || len(body) > maxFile {
		return nil, errors.New("a file of the source is too large")
	}
	return body, nil
}

// DiscoverSource lists the skills of an address: it reads <address>/index.json, {skills: [{name, description, files}]}.
func DiscoverSource(ctx context.Context, address string) ([]Offer, error) {
	base := strings.TrimRight(address, "/")
	if parsed, err := url.Parse(base); err != nil || parsed.Scheme != "https" && parsed.Scheme != "http" || parsed.Host == "" {
		return nil, errors.New("a skill source is an http(s) address or a git repository")
	}
	body, err := fetch(ctx, base+"/index.json")
	if err != nil {
		return nil, err
	}
	var index struct {
		Skills []Offer `json:"skills"`
	}
	if err := json.Unmarshal(body, &index); err != nil {
		return nil, errors.New("index.json is not a skill index")
	}
	for _, offer := range index.Skills {
		if err := Valid(offer.Name); err != nil || len(offer.Files) > maxFiles {
			return nil, errors.New("index.json names an invalid skill")
		}
	}
	slices.SortFunc(index.Skills, func(a, b Offer) int { return strings.Compare(a.Name, b.Name) })
	return index.Skills, nil
}

func cleanFile(name string) (string, error) {
	clean := path.Clean(strings.ReplaceAll(name, `\`, "/"))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, ":") {
		return "", errors.New("a skill file must stay inside its folder")
	}
	return clean, nil
}

// Install downloads the chosen skills of an address into root (a skills folder), one folder per skill.
func Install(ctx context.Context, address string, names []string, root string) ([]string, error) {
	offers, err := DiscoverSource(ctx, address)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(address, "/")
	var installed []string
	for _, name := range names {
		var offer *Offer
		for i := range offers {
			if offers[i].Name == name {
				offer = &offers[i]
			}
		}
		if offer == nil {
			return installed, fmt.Errorf("the source has no skill named %q", name)
		}
		files := offer.Files
		if len(files) == 0 {
			files = []string{"SKILL.md"}
		}
		staged := map[string][]byte{}
		for _, file := range files {
			clean, err := cleanFile(file)
			if err != nil {
				return installed, err
			}
			if staged[clean], err = fetch(ctx, base+"/"+url.PathEscape(name)+"/"+clean); err != nil {
				return installed, err
			}
		}
		text, ok := staged["SKILL.md"]
		if !ok {
			return installed, fmt.Errorf("skill %q has no SKILL.md", name)
		}
		if found, ok := parse(string(text)); !ok || found.Name != name {
			return installed, fmt.Errorf("the SKILL.md of %q does not name it", name)
		}
		if err := writeSkill(root, name, staged); err != nil {
			return installed, err
		}
		installed = append(installed, name)
	}
	return installed, nil
}

// writeSkill replaces the folder of a skill with the given files, all or nothing.
func writeSkill(root, name string, files map[string][]byte) error {
	if err := Valid(name); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(root, ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	for file, body := range files {
		target := filepath.Join(staging, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, body, 0o644); err != nil {
			return err
		}
	}
	final := filepath.Join(root, name)
	if err := os.RemoveAll(final); err != nil {
		return err
	}
	return os.Rename(staging, final)
}

// Uninstall deletes the folder of an installed skill.
func Uninstall(root, name string) error {
	if err := Valid(name); err != nil {
		return err
	}
	folder := filepath.Join(root, name)
	if _, err := os.Stat(filepath.Join(folder, "SKILL.md")); err != nil {
		return errors.New("no such skill")
	}
	return os.RemoveAll(folder)
}

// clone makes a shallow copy of a repository in the cache and returns its folder. Credential helpers and prompts
// are off; a private repository takes the token the user gave.
func clone(ctx context.Context, source, cache, token string) (string, error) {
	parsed, err := url.Parse(source)
	if err != nil || parsed.Scheme == "" || parsed.Scheme == "ext" {
		return "", errors.New("not a git repository address")
	}
	sum := sha256.Sum256([]byte(source))
	folder := filepath.Join(cache, "git-"+hex.EncodeToString(sum[:8]))
	if err := os.RemoveAll(folder); err != nil {
		return "", err
	}
	if err := os.MkdirAll(cache, 0o755); err != nil {
		return "", err
	}
	address := source
	if token != "" && (parsed.Scheme == "https" || parsed.Scheme == "http") {
		parsed.User = url.UserPassword("x-access-token", token)
		address = parsed.String()
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := process.Command(ctx, cache, "git", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--quiet", "--", address, folder)
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "GCM_INTERACTIVE=never")
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git clone failed: %s", strings.TrimSpace(strings.ReplaceAll(string(out), token, "***")))
	}
	return folder, nil
}

// skillFolders finds the folders of a clone that hold a SKILL.md.
func skillFolders(folder string) map[string]Skill {
	found := map[string]Skill{}
	_ = filepath.WalkDir(folder, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() && entry.Name() == ".git" {
			return filepath.SkipDir
		}
		if entry.IsDir() || entry.Name() != "SKILL.md" {
			return nil
		}
		text, err := os.ReadFile(file)
		if err != nil {
			return nil
		}
		if skill, ok := parse(string(text)); ok && skill.Name != "" && skill.Description != "" && Valid(skill.Name) == nil {
			skill.Dir = filepath.Dir(file)
			found[skill.Name] = skill
		}
		return nil
	})
	return found
}

// DiscoverGit lists the skills of a git repository, found by a shallow clone into the cache folder.
func DiscoverGit(ctx context.Context, source, cache, token string) ([]Offer, error) {
	folder, err := clone(ctx, source, cache, token)
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(folder)
	var offers []Offer
	for _, skill := range skillFolders(folder) {
		offers = append(offers, Offer{Name: skill.Name, Description: skill.Description})
	}
	slices.SortFunc(offers, func(a, b Offer) int { return strings.Compare(a.Name, b.Name) })
	return offers, nil
}

// InstallGit copies the chosen skills of a git repository into root, one folder per skill, without the clone's .git.
func InstallGit(ctx context.Context, source, cache, token string, names []string, root string) ([]string, error) {
	folder, err := clone(ctx, source, cache, token)
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(folder)
	found := skillFolders(folder)
	var installed []string
	for _, name := range names {
		skill, ok := found[name]
		if !ok {
			return installed, fmt.Errorf("the repository has no skill named %q", name)
		}
		files := map[string][]byte{}
		err := filepath.WalkDir(skill.Dir, func(file string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() && entry.Name() == ".git" {
				return filepath.SkipDir
			}
			if entry.IsDir() || !entry.Type().IsRegular() {
				return nil
			}
			if len(files) >= maxFiles {
				return errors.New("the skill has too many files")
			}
			body, err := os.ReadFile(file)
			if err != nil || len(body) > maxFile {
				return errors.New("a file of the skill is unreadable or too large")
			}
			relative, err := filepath.Rel(skill.Dir, file)
			if err != nil {
				return err
			}
			files[filepath.ToSlash(relative)] = body
			return nil
		})
		if err != nil {
			return installed, err
		}
		if err := writeSkill(root, name, files); err != nil {
			return installed, err
		}
		installed = append(installed, name)
	}
	return installed, nil
}
