package server

import (
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// rpcError turns the failure of a method into the error of the response. The MRK code comes from the failure itself
// when it has one, and otherwise from the domain of the method.
func rpcError(method string, callErr error) *protocol.Error {
	if errors.Is(callErr, errMethodNotFound) {
		return &protocol.Error{Code: -32601, Message: "Method not found", Data: protocol.ErrorData{Code: "MRK-1001"}}
	}
	code := "MRK-4001"
	if strings.HasPrefix(method, "group.") || strings.HasPrefix(method, "task.") || method == "event.emit" {
		code = "MRK-6001"
	}
	if method == "permission.reply" || method == "question.reply" {
		code = "MRK-5002"
	}
	if method == "diagnostics.bundle" {
		code = "MRK-1004"
	}
	if strings.HasPrefix(method, "file.") || strings.HasPrefix(method, "terminal.") || strings.HasPrefix(method, "repo.") {
		code = "MRK-5001"
	}
	if method == "blob.read" {
		code = "MRK-1003"
	}
	if strings.HasPrefix(method, "config.") {
		code = "MRK-3001"
	}
	var failure *engine.Error
	if errors.As(callErr, &failure) {
		code = failure.Code
	}
	response := &protocol.Error{Code: -32602, Message: "Invalid request parameters", Data: protocol.ErrorData{Code: code}}
	if callErr.Error() == "MRK-4005" {
		response.Data = protocol.ErrorData{Code: "MRK-4005"}
	}
	var remote *protocol.Error
	if errors.As(callErr, &remote) {
		response = remote
	}
	if callErr.Error() == "MRK-1006" || callErr.Error() == "MRK-1007" {
		response = &protocol.Error{Code: -32000, Message: "Cloud request failed", Data: protocol.ErrorData{Code: callErr.Error()}}
	}
	return response
}
