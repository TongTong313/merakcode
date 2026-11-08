package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func defaultProfiles() []profile.Profile {
	leader, worker := profile.DefaultLeader(), profile.DefaultWorker()
	leader.ID, worker.ID = "builtin-leader", "builtin-worker"
	return []profile.Profile{leader, worker}
}

func (e *Engine) ListProfiles(ctx context.Context, human event.ID) ([]profile.Profile, error) {
	result := defaultProfiles()
	docs, err := e.store.List(ctx, "profile", "")
	if err != nil {
		return nil, err
	}
	for _, meta := range docs {
		if meta.Meta["owner"] != string(human) || human == "" {
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

func (e *Engine) SaveProfile(ctx context.Context, human event.ID, p profile.Profile) (profile.Profile, error) {
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
		return profile.Profile{}, errors.New("only the profile owner can edit it")
	}
	body, err := json.Marshal(p)
	if err != nil {
		return profile.Profile{}, err
	}
	err = e.store.Put(ctx, store.Doc{Kind: "profile", Key: string(p.ID), Rev: doc.Rev, Body: body, Meta: map[string]string{"owner": string(human)}})
	return p, err
}

func validateProfile(p profile.Profile) error {
	if strings.TrimSpace(p.Name) == "" || p.Role != profile.Leader && p.Role != profile.Worker {
		return errors.New("profile name and role are required")
	}
	if p.Role == profile.Leader {
		if p.Product != nil {
			return errors.New("external leaders are not supported")
		}
		if p.ToolPool != "leader.default" {
			return errors.New("leader profile requires leader tools")
		}
		return nil
	}
	if p.ToolPool != "worker.default" && p.ToolPool != "worker.readonly" {
		return errors.New("worker profile requires worker tools")
	}
	if p.Product == nil {
		return nil
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
	if actor.Kind != group.MemberHuman || member.Kind != group.MemberAgent || member.Owner != "" && member.Owner != human {
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
		return e.AddGroupMember(ctx, groupID, member, nil)
	}
	return group.Member{}, errors.New("profile is not owned by this human")
}
