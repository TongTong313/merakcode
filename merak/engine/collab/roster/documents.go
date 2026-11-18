package roster

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/secret"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func validDocumentKey(key string) bool {
	return strings.TrimSpace(key) != "" && !strings.ContainsAny(key, "/\\?#\x00")
}

func (domain *Roster) ListGroupDocsTool(id event.ID) tool.Tool {
	return GroupTool{Definition: tool.Spec{Name: "list_docs", Description: "List shared document keys, titles and revisions in this group.", Effect: tool.EffectRead, Input: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		if err := DecodeGroupInput(call.Input, &struct{}{}); err != nil {
			return nil, err
		}
		return domain.ListGroupDocuments(ctx, id)
	}}
}

func (domain *Roster) WriteGroupDocTool(id, member event.ID) tool.Tool {
	return GroupTool{Definition: tool.Spec{Name: "write_doc", Description: "Create or replace a shared document. Use revision 0 to create; use its current revision to update. Re-read after a revision conflict.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"key":{"type":"string"},"title":{"type":"string"},"text":{"type":"string"},"rev":{"type":"integer","minimum":0}},"required":["key","title","text","rev"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Key   string `json:"key"`
			Title string `json:"title"`
			Text  string `json:"text"`
			Rev   uint64 `json:"rev"`
		}
		if err := DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		return domain.WriteGroupDocument(ctx, event.Actor{Kind: event.ActorAgent, ID: member}, group.Document{DocumentInfo: group.DocumentInfo{Group: id, Key: input.Key, Title: input.Title, Rev: input.Rev}, Text: input.Text})
	}}
}

func (domain *Roster) ListGroupDocuments(ctx context.Context, id event.ID) ([]group.DocumentInfo, error) {
	if _, err := domain.groups.Get(ctx, id); err != nil {
		return nil, err
	}
	docs, err := domain.core.Store.List(ctx, "shared", string(id)+"/")
	if err != nil {
		return nil, err
	}
	result := []group.DocumentInfo{}
	for _, doc := range docs {
		if doc.Meta["group"] != string(id) {
			continue
		}
		result = append(result, group.DocumentInfo{Group: id, Key: strings.TrimPrefix(doc.Key, string(id)+"/"), Title: doc.Meta["title"], Rev: doc.Rev})
	}
	return result, nil
}

func (domain *Roster) ReadGroupDocument(ctx context.Context, id event.ID, key string) (group.Document, error) {
	if !validDocumentKey(key) {
		return group.Document{}, errors.New("invalid shared document key")
	}
	if _, err := domain.groups.Get(ctx, id); err != nil {
		return group.Document{}, err
	}
	doc, err := domain.core.Store.Fetch(ctx, "shared", string(id)+"/"+key)
	if err != nil {
		return group.Document{}, err
	}
	if doc.Meta["group"] != string(id) {
		return group.Document{}, store.ErrNotFound
	}
	return group.Document{DocumentInfo: group.DocumentInfo{Group: id, Key: key, Title: doc.Meta["title"], Rev: doc.Rev}, Text: string(doc.Body)}, nil
}

func (domain *Roster) WriteGroupDocument(ctx context.Context, actor event.Actor, doc group.Document) (group.Document, error) {
	member, err := domain.GroupMember(ctx, doc.Group, actor.ID)
	if err != nil {
		return group.Document{}, err
	}
	if !(actor.Kind == event.ActorHuman && member.Can(group.RoleMember) || actor.Kind == event.ActorAgent && member.Kind == group.MemberAgent && member.AgentRole == group.AgentLeader) {
		return group.Document{}, errors.New("shared documents require a group writer")
	}
	if !validDocumentKey(doc.Key) || strings.TrimSpace(doc.Title) == "" || len(doc.Text) > 1<<20 {
		return group.Document{}, errors.New("invalid shared document")
	}
	if secret.Contains(doc.Title) || secret.Contains(doc.Text) {
		return group.Document{}, errors.New("MRK-5001: remove credentials before saving the document")
	}
	if err := domain.core.Store.Put(ctx, store.Doc{Kind: "shared", Key: string(doc.Group) + "/" + doc.Key, Rev: doc.Rev, Body: []byte(doc.Text), Meta: map[string]string{"group": string(doc.Group), "title": doc.Title}}); err != nil {
		return group.Document{}, err
	}
	doc.Rev++
	return doc, nil
}
