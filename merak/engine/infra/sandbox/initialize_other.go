//go:build !windows

package sandbox

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
)

func initialize(context.Context, string, string) error {
	return errorcode.Coded(errorcode.SandboxUnavailable, errors.New(errorcode.SandboxUnavailable))
}
