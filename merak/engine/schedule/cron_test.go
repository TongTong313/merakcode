package schedule_test

import (
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/schedule"
)

func at(value string) time.Time {
	parsed, err := time.ParseInLocation("2006-01-02 15:04", value, time.UTC)
	if err != nil {
		panic(err)
	}
	return parsed
}

func TestParseAcceptsTheCommonFiveFieldForms(t *testing.T) {
	for _, test := range []struct {
		name, expression string
		after, next      string
	}{
		{"every minute", "* * * * *", "2026-11-12 09:00", "2026-11-12 09:01"},
		{"daily at nine", "0 9 * * *", "2026-11-12 09:00", "2026-11-13 09:00"},
		{"later the same day", "0 9 * * *", "2026-11-12 08:59", "2026-11-12 09:00"},
		{"every half hour", "*/30 * * * *", "2026-11-12 09:00", "2026-11-12 09:30"},
		{"a list", "5,35 * * * *", "2026-11-12 09:05", "2026-11-12 09:35"},
		{"a range with a step", "0 9-17/4 * * *", "2026-11-12 09:00", "2026-11-12 13:00"},
		{"weekdays only", "30 8 * * 1-5", "2026-11-13 08:30", "2026-11-16 08:30"},
		{"sunday written as 0 or 7", "0 0 * * 7", "2026-11-12 00:00", "2026-11-15 00:00"},
		{"names of days and months", "0 12 1 jan mon", "2026-11-12 00:00", "2027-01-01 12:00"},
		{"the first of the month", "0 0 1 * *", "2026-11-12 00:00", "2026-12-01 00:00"},
		{"day of month or day of week when both are set", "0 0 13 * fri", "2026-11-12 00:00", "2026-11-13 00:00"},
		{"the last day that exists", "0 0 31 * *", "2026-11-12 00:00", "2026-12-31 00:00"},
		{"a leap day", "0 0 29 2 *", "2026-11-12 00:00", "2028-02-29 00:00"},
		{"extra spaces", "  0   9  * * *  ", "2026-11-12 09:00", "2026-11-13 09:00"},
	} {
		t.Run(test.name, func(t *testing.T) {
			spec, err := schedule.Parse(test.expression)
			if err != nil {
				t.Fatal(err)
			}
			if got := spec.Next(at(test.after)); !got.Equal(at(test.next)) {
				t.Fatalf("next after %s = %s, want %s", test.after, got.Format("2006-01-02 15:04"), test.next)
			}
		})
	}
}

func TestParseRefusesWhatIsNotAFiveFieldExpression(t *testing.T) {
	for _, expression := range []string{
		"", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *", "* * * * 8",
		"a * * * *", "*/0 * * * *", "*/-1 * * * *", "5-1 * * * *", "1- * * * *", ", * * * *", "0 9 * * * # comment",
		"@daily", "? * * * *", "0 0 31 2 *",
	} {
		if _, err := schedule.Parse(expression); err == nil {
			t.Errorf("%q was accepted", expression)
		}
	}
}

func TestCountFiresBetweenTwoTimesTakesTheEndAndLeavesTheStart(t *testing.T) {
	spec, err := schedule.Parse("*/30 * * * *")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		from, to string
		want     int
	}{
		{"2026-11-12 09:00", "2026-11-12 10:01", 2},
		{"2026-11-12 09:00", "2026-11-12 10:00", 2},
		{"2026-11-12 09:00", "2026-11-12 09:29", 0},
		{"2026-11-12 09:10", "2026-11-12 09:10", 0},
		{"2026-11-12 10:00", "2026-11-12 09:00", 0},
	} {
		if got := spec.CountBetween(at(test.from), at(test.to)); got != test.want {
			t.Errorf("%s..%s: %d fires, want %d", test.from, test.to, got, test.want)
		}
	}
}
