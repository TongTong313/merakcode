package permission

import (
	"encoding/json"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func requestFor(call tool.Call, spec tool.Spec) Request {
	req := Request{Call: call, Spec: spec, Member: call.Env.Member, Mode: Mode(call.Env.Mode)}
	var input struct {
		Path     string `json:"path"`
		FilePath string `json:"file_path"`
		URL      string `json:"url"`
		Host     string `json:"host"`
		Deletes  bool   `json:"deletes"`
	}
	if json.Unmarshal(call.Input, &input) != nil {
		return req
	}
	req.Path, req.Host, req.Deletes = input.Path, input.Host, input.Deletes
	if req.Path == "" {
		req.Path = input.FilePath
	}
	if input.URL != "" {
		if target, err := url.Parse(input.URL); err == nil && (target.Scheme == "https" || target.Scheme == "http") && target.User == nil {
			req.Host = target.Host
			if target.Port() == "" {
				port := "443"
				if target.Scheme == "http" {
					port = "80"
				}
				req.Host = net.JoinHostPort(target.Hostname(), port)
			}
		}
	}
	return req
}

func networkTarget(target string) (string, int) {
	host, raw, err := net.SplitHostPort(target)
	if err != nil {
		return strings.Trim(target, "[]"), 443
	}
	port, err := strconv.Atoi(raw)
	if err != nil {
		return "", 0
	}
	return host, port
}
