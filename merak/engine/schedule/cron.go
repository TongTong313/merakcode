// Package schedule holds scheduled tasks: the five-field cron expressions that say when they run, the documents
// that store them, and the check that starts them. It knows nothing about conversations; the engine passes in what a
// run does.
package schedule

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Spec is a parsed five-field cron expression: minute, hour, day of month, month and day of week. Times are read in
// the location of the time that is passed in, which is the machine's own zone for the engine.
type Spec struct {
	minute, hour, dom, month, dow uint64
	// domAny and dowAny say that the field started with *, so it does not narrow the day.
	domAny, dowAny bool
}

type fieldRange struct {
	name     string
	low, top int
	names    []string
}

var (
	minuteRange = fieldRange{"minute", 0, 59, nil}
	hourRange   = fieldRange{"hour", 0, 23, nil}
	domRange    = fieldRange{"day of month", 1, 31, nil}
	monthRange  = fieldRange{"month", 1, 12, []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}}
	dowRange    = fieldRange{"day of week", 0, 7, []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}}
)

// Parse reads minute hour day-of-month month day-of-week. Each field is *, a number, a name of a month or a day, a
// range a-b, a step */n or a-b/n, or a comma-separated list of these. Sunday is 0 or 7. When both day fields are
// restricted a day matches if either does, as in cron.
func Parse(expression string) (Spec, error) {
	fields := strings.Fields(expression)
	if len(fields) != 5 {
		return Spec{}, errors.New("a cron expression has five fields: minute hour day-of-month month day-of-week")
	}
	var spec Spec
	for i, target := range []struct {
		bits *uint64
		kind fieldRange
	}{{&spec.minute, minuteRange}, {&spec.hour, hourRange}, {&spec.dom, domRange}, {&spec.month, monthRange}, {&spec.dow, dowRange}} {
		bits, err := parseField(fields[i], target.kind)
		if err != nil {
			return Spec{}, fmt.Errorf("%s: %w", target.kind.name, err)
		}
		*target.bits = bits
	}
	if spec.dow&(1<<7) != 0 {
		spec.dow = spec.dow&^(1<<7) | 1
	}
	spec.domAny, spec.dowAny = strings.HasPrefix(fields[2], "*"), strings.HasPrefix(fields[4], "*")
	if !spec.domAny && spec.dowAny && !spec.someDayExists() {
		return Spec{}, errors.New("no month has a day that matches")
	}
	return spec, nil
}

func parseField(text string, kind fieldRange) (uint64, error) {
	var bits uint64
	for _, part := range strings.Split(text, ",") {
		low, top, step := kind.low, kind.top, 1
		body, stepText, stepped := strings.Cut(part, "/")
		if stepped {
			value, err := strconv.Atoi(stepText)
			if err != nil || value < 1 {
				return 0, fmt.Errorf("%q is not a step", part)
			}
			step = value
		}
		switch {
		case body == "*":
		case strings.Contains(body, "-"):
			from, to, _ := strings.Cut(body, "-")
			var err error
			if low, err = kind.value(from); err != nil {
				return 0, err
			}
			if top, err = kind.value(to); err != nil {
				return 0, err
			}
			if low > top {
				return 0, fmt.Errorf("%q runs backwards", part)
			}
		default:
			value, err := kind.value(body)
			if err != nil {
				return 0, err
			}
			low = value
			if stepped {
				top = kind.top
			} else {
				top = value
			}
		}
		for value := low; value <= top; value += step {
			bits |= 1 << value
		}
	}
	return bits, nil
}

func (r fieldRange) value(text string) (int, error) {
	for i, name := range r.names {
		if strings.EqualFold(text, name) {
			return i + r.low, nil
		}
	}
	value, err := strconv.Atoi(text)
	if err != nil || value < r.low || value > r.top || text != strconv.Itoa(value) {
		return 0, fmt.Errorf("%q is not between %d and %d", text, r.low, r.top)
	}
	return value, nil
}

var monthDays = [...]int{0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}

func (s Spec) someDayExists() bool {
	for month := 1; month <= 12; month++ {
		for day := 1; day <= monthDays[month]; day++ {
			if s.month&(1<<month) != 0 && s.dom&(1<<day) != 0 {
				return true
			}
		}
	}
	return false
}

func (s Spec) dayMatches(t time.Time) bool {
	dom, dow := s.dom&(1<<t.Day()) != 0, s.dow&(1<<int(t.Weekday())) != 0
	if s.domAny || s.dowAny {
		return dom && dow
	}
	return dom || dow
}

// Next returns the first time after the given one, to the minute, that the expression names; the zero time when
// there is none within eight years.
func (s Spec) Next(after time.Time) time.Time {
	t := after.Truncate(time.Minute).Add(time.Minute)
	limit := after.AddDate(8, 0, 0)
	for t.Before(limit) {
		year, month, day := t.Date()
		switch {
		case s.month&(1<<int(month)) == 0:
			t = time.Date(year, month+1, 1, 0, 0, 0, 0, t.Location())
		case !s.dayMatches(t):
			t = time.Date(year, month, day+1, 0, 0, 0, 0, t.Location())
		case s.hour&(1<<t.Hour()) == 0:
			t = time.Date(year, month, day, t.Hour()+1, 0, 0, 0, t.Location())
		case s.minute&(1<<t.Minute()) == 0:
			t = t.Add(time.Minute)
		default:
			return t
		}
	}
	return time.Time{}
}

// CountBetween counts the times the expression names after from and up to and including to.
func (s Spec) CountBetween(from, to time.Time) int {
	count := 0
	for t := s.Next(from); !t.IsZero() && !t.After(to); t = s.Next(t) {
		count++
	}
	return count
}
