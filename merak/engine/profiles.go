package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func defaultProfiles() []profile.Profile {
	leader, worker := profile.DefaultLeader(), profile.DefaultWorker()
	leader.ID, worker.ID = "builtin-leader", "builtin-worker"
	return []profile.Profile{leader, worker}
}

func (e *Engine) authorizeMemberAssignment(ctx context.Context, member group.Member, actor event.Actor) error {
	p, err := e.memberProfile(ctx, member)
	if err != nil {
		return err
	}
	if !p.Shared && (actor.Kind != event.ActorHuman || actor.ID != member.Owner) {
		return coded(errorcode.ProfileOwnerOnly, errors.New("only the owner can assign an unshared member"))
	}
	return nil
}

func (e *Engine) ListProfiles(ctx context.Context, human event.ID) ([]profile.Profile, error) {
	result := defaultProfiles()
	docs, err := e.store.List(ctx, "profile", "")
	if err != nil {
		return nil, err
	}
	for _, meta := range docs {
		if meta.Meta["owner"] != string(human) || human == "" || meta.Meta["deleted"] == "true" {
			continue
		}
		doc, err := e.store.Fetch(ctx, "profile", meta.Key)
		if err != nil {
			return nil, err
		}
		var p profile.Profile
		if err := json.Unmarshal(doc.Body, &p); err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	return result, nil
}

func (e *Engine) DeleteProfile(ctx context.Context, human, id event.ID) error {
	e.profileMu.Lock()
	defer e.profileMu.Unlock()
	doc, err := e.store.Fetch(ctx, "profile", string(id))
	if err != nil {
		return err
	}
	if human == "" || doc.Meta["owner"] != string(human) {
		return coded(errorcode.ProfileOwnerOnly, errors.New("only the profile owner can delete it"))
	}
	facts, err := e.store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return err
	}
	for _, fact := range facts {
		state, err := e.Groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return err
		}
		for _, member := range state.Members {
			if member.Profile == id {
				return coded(errorcode.ProfileInUse, errors.New("profile is still assigned to a group member"))
			}
		}
	}
	doc.Meta["deleted"] = "true"
	return e.store.Put(ctx, doc)
}

func (e *Engine) SaveProfile(ctx context.Context, human event.ID, p profile.Profile) (profile.Profile, error) {
	e.profileMu.Lock()
	defer e.profileMu.Unlock()
	if human == "" {
		return profile.Profile{}, errors.New("profile owner is required")
	}
	if err := validateProfile(p); err != nil {
		return profile.Profile{}, err
	}
	for _, builtin := range defaultProfiles() {
		if p.ID == builtin.ID {
			return profile.Profile{}, errors.New("copy a builtin profile before editing")
		}
	}
	if p.ID == "" {
		p.ID = e.newID()
	}
	doc, err := e.store.Fetch(ctx, "profile", string(p.ID))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return profile.Profile{}, err
	}
	if err == nil && doc.Meta["owner"] != string(human) {
		return profile.Profile{}, coded(errorcode.ProfileOwnerOnly, errors.New("only the profile owner can edit it"))
	}
	p, err = e.keepAgentSecrets(ctx, p)
	if err != nil {
		return profile.Profile{}, err
	}
	body, err := json.Marshal(p)
	if err != nil {
		return profile.Profile{}, err
	}
	err = e.store.Put(ctx, store.Doc{Kind: "profile", Key: string(p.ID), Rev: doc.Rev, Body: body, Meta: map[string]string{"owner": string(human)}})
	return p, err
}

func validateProfileNetwork(p profile.Profile) error {
	for _, scope := range p.Memory {
		if scope != "member" && scope != "group" && scope != "project" {
			return errors.New("invalid profile memory scope")
		}
	}
	if err := p.Budget.Validate(); err != nil {
		return err
	}
	if (p.Product == nil || p.Product.Kind == worker.KindBuiltin) && len(p.Network) != 0 {
		return errors.New("network hosts are only available to external member profiles")
	}
	return (sandbox.Network{Mode: "allowlist", Hosts: p.Network}).Validate()
}

func validateProfile(p profile.Profile) error {
	if err := validateProfileNetwork(p); err != nil {
		return err
	}
	if strings.TrimSpace(p.Name) == "" || p.Role != profile.Leader && p.Role != profile.Worker {
		return errors.New("profile name and role are required")
	}
	if p.Role == profile.Leader {
		if p.ToolPool != "leader.default" {
			return errors.New("leader profile requires leader tools")
		}
		if p.Product != nil && p.Product.Kind != worker.KindClaudeCode && p.Product.Kind != worker.KindCodex && p.Product.Kind != worker.KindPi {
			return coded(errorcode.ExternalLeaderUnsupported, errors.New("external leaders require MCP and steering"))
		}
	} else if p.ToolPool != "worker.default" && p.ToolPool != "worker.readonly" {
		return errors.New("worker profile requires worker tools")
	}
	if p.Product == nil {
		return nil
	}
	if p.Product.Kind == worker.KindRemote {
		source := p.Product.Remote
		if source == nil || source.Connection == "" || source.Group == "" || source.Member == "" || p.Product.Binary != "" || len(p.Product.Args) != 0 || len(p.Product.Env) != 0 || len(p.Network) != 0 {
			return errors.New("remote profiles require a connection and a source member")
		}
		return nil
	}
	if p.Product.Remote != nil {
		return errors.New("only remote profiles can select a remote source")
	}
	if strings.TrimSpace(p.Product.Binary) == "" {
		return errors.New("product binary is required")
	}
	switch p.Product.Kind {
	case worker.KindClaudeCode, worker.KindCodex, worker.KindOpenCode, worker.KindPi, worker.KindACP, worker.KindCommand:
		return nil
	default:
		return errors.New("unsupported worker product")
	}
}

func (e *Engine) RegisterMember(ctx context.Context, groupID, human event.ID, member group.Member) (group.Member, error) {
	actor, err := e.groupMember(ctx, groupID, human)
	if err != nil {
		return group.Member{}, err
	}
	if !actor.Can(group.RoleAdmin) || member.Kind != group.MemberAgent || member.Owner != "" && member.Owner != human {
		return group.Member{}, errors.New("a human member can register only their own agents")
	}
	profiles, err := e.ListProfiles(ctx, human)
	if err != nil {
		return group.Member{}, err
	}
	for _, p := range profiles {
		if p.ID != member.Profile {
			continue
		}
		member.Owner = human
		return e.addGroupMember(ctx, groupID, member, nil, actor.Can(group.RoleAdmin))
	}
	return group.Member{}, errors.New("profile is not owned by this human")
}

func agentSecretKey(id, name string) string { return "agent:" + id + ":" + name }

// keepAgentSecrets moves the non-empty environment values of an external agent into the vault and returns the profile
// without them. An empty value keeps the value that is already stored.
func (e *Engine) keepAgentSecrets(ctx context.Context, p profile.Profile) (profile.Profile, error) {
	if p.Product == nil || len(p.Product.Env) == 0 {
		return p, nil
	}
	product := *p.Product
	product.Env = make(map[string]string, len(p.Product.Env))
	for name, value := range p.Product.Env {
		product.Env[name] = ""
		if value == "" {
			continue
		}
		if err := e.vault.Set(ctx, agentSecretKey(string(p.ID), name), []byte(value)); err != nil {
			return profile.Profile{}, err
		}
	}
	p.Product = &product
	return p, nil
}

// withAgentSecrets fills the environment values of an external agent that are empty from the vault.
func (e *Engine) withAgentSecrets(ctx context.Context, p profile.Profile) (profile.Profile, error) {
	if p.Product == nil || len(p.Product.Env) == 0 || p.ID == "" {
		return p, nil
	}
	product := *p.Product
	product.Env = make(map[string]string, len(p.Product.Env))
	for name, value := range p.Product.Env {
		if value == "" {
			stored, err := e.vault.Get(ctx, agentSecretKey(string(p.ID), name))
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return profile.Profile{}, err
			}
			value = string(stored)
		}
		product.Env[name] = value
	}
	p.Product = &product
	return p, nil
}
