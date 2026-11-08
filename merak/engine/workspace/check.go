package workspace

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type CheckFailure struct {
	Output string
}

func (f *CheckFailure) Error() string { return "Group check failed: " + f.Output }

type checkOutput struct{ strings.Builder }

func (b *checkOutput) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := 64*1024 - b.Len(); remaining > 0 {
		_, _ = b.Builder.Write(p[:min(remaining, n)])
	}
	return n, nil
}

func runCheck(ctx context.Context, directory, check string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd, err := process.Shell(ctx, directory, check)
	if err != nil {
		return &CheckFailure{Output: err.Error()}
	}
	var output checkOutput
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		return &CheckFailure{Output: fmt.Sprintf("%v\n%s", err, output.String())}
	}
	return nil
}
