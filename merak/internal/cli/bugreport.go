package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/diagnose"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

const issuesURL = "https://github.com/TongTong313/merakcode/issues/new"

// bugReportName is the default file name of a bug report package.
func bugReportName(at time.Time) string {
	return "merak-bug-report-" + at.Format("20060102-150405") + ".zip"
}

// bugReportCommand runs merak bug-report: the diagnostic package of merak diagnose with the redacted configuration,
// then where it is and where to send it.
func bugReportCommand(args []string, output io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("bug-report", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	path := flags.String("out", "", "")
	days := flags.Int("days", 3, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *days < 1 || *days > 30 {
		return 2
	}
	if *path == "" {
		*path = bugReportName(time.Now())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := writeDiagnostic(ctx, diagnose.Request{Days: *days, WithConfig: true}, *path); err != nil {
		ui.failure(output, errorcode.DiagnosticsFailed)
		return 1
	}
	if _, err := fmt.Fprintf(output, ui.text("bugReportSaved"), *path); err != nil {
		return 1
	}
	if _, err := fmt.Fprintf(output, ui.text("bugReportNext"), issuesURL); err != nil {
		return 1
	}
	return 0
}
