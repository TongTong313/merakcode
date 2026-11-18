package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Remote) GroupLookup(groupID event.ID) tool.Tool {
	return remoteLookupTool{Tool: domain.roster.LocalGroupLookup(groupID), owner: domain, group: groupID}
}

func (domain *Remote) ReadGroupDoc(groupID event.ID) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "read_doc", Description: "Read a shared document in the current group, optionally selecting one-based inclusive lines.", Effect: tool.EffectRead, Input: json.RawMessage(`{"type":"object","properties":{"key":{"type":"string"},"startLine":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1}},"required":["key"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Key   string `json:"key"`
			Start *int   `json:"startLine"`
			End   *int   `json:"endLine"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if input.Key == "" || strings.ContainsAny(input.Key, "/\\?#\x00") {
			return nil, errors.New("invalid shared document key")
		}
		args := map[string]any{"ref": "mrk://doc/shared/" + string(groupID) + "/" + url.PathEscape(input.Key)}
		if input.Start != nil {
			args["startLine"] = *input.Start
		}
		if input.End != nil {
			args["endLine"] = *input.End
		}
		call.Input, _ = json.Marshal(args)
		result, err := domain.GroupLookup(groupID).Run(ctx, call)
		if err != nil {
			return nil, err
		}
		if result.IsError {
			return nil, errors.New("shared document is unavailable or its line range is invalid")
		}
		return result.Parts[0].Text, nil
	}}
}
