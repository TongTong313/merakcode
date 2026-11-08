package protocol

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

type StoreAppendParams struct {
	Events []event.Event `json:"events"`
}
type EventsReadParams struct {
	Stream event.Stream `json:"stream"`
	From   uint64       `json:"from"`
	Limit  int          `json:"limit,omitempty"`
}
type EventsGetParams struct {
	ID event.ID `json:"id"`
}
type StorePutParams struct {
	Doc store.Doc `json:"doc"`
}
type StoreFetchParams struct {
	Kind string `json:"kind"`
	Key  string `json:"key"`
}
type StoreListParams struct {
	Kind   string `json:"kind"`
	Prefix string `json:"prefix,omitempty"`
}

// HandleStore answers a reverse request using the connected host's store.
func HandleStore(ctx context.Context, s store.Store, request Message) Message {
	response := Message{JSONRPC: "2.0", ID: request.ID}
	var result any = struct{}{}
	var err error
	switch request.Method {
	case "store.append":
		var p StoreAppendParams
		if err = json.Unmarshal(request.Params, &p); err == nil {
			err = s.Append(ctx, p.Events)
		}
	case "store.read":
		var p EventsReadParams
		if err = json.Unmarshal(request.Params, &p); err == nil {
			result, err = s.Read(ctx, p.Stream, p.From, p.Limit)
		}
	case "store.find":
		var p store.Query
		if err = json.Unmarshal(request.Params, &p); err == nil {
			result, err = s.Find(ctx, p)
		}
	case "store.get":
		var p EventsGetParams
		if err = json.Unmarshal(request.Params, &p); err == nil {
			result, err = s.Get(ctx, p.ID)
		}
	case "store.put":
		var p StorePutParams
		if err = json.Unmarshal(request.Params, &p); err == nil {
			err = s.Put(ctx, p.Doc)
		}
	case "store.fetch":
		var p StoreFetchParams
		if err = json.Unmarshal(request.Params, &p); err == nil {
			result, err = s.Fetch(ctx, p.Kind, p.Key)
		}
	case "store.list":
		var p StoreListParams
		if err = json.Unmarshal(request.Params, &p); err == nil {
			result, err = s.List(ctx, p.Kind, p.Prefix)
		}
	default:
		response.Error = &Error{Code: -32601, Message: "Method not found", Data: ErrorData{Code: "MRK-1001"}}
		return response
	}
	if err != nil {
		response.Error = StorageError(err)
		return response
	}
	response.Result, err = json.Marshal(result)
	if err != nil {
		response.Error = StorageError(err)
	}
	return response
}

func StorageError(err error) *Error {
	code := -32011
	switch {
	case errors.Is(err, store.ErrNotFound):
		code = -32004
	case errors.Is(err, store.ErrConflict):
		code = -32009
	case errors.Is(err, store.ErrSequence):
		code = -32010
	}
	return &Error{Code: code, Message: "Storage request failed", Data: ErrorData{Code: "MRK-1003"}}
}

func (e *Error) Is(target error) bool {
	switch e.Code {
	case -32004:
		return target == store.ErrNotFound
	case -32009:
		return target == store.ErrConflict
	case -32010:
		return target == store.ErrSequence
	case -32011:
		return target == store.ErrUnavailable
	}
	return false
}
