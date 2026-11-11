package window

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

const BudgetReported event.Type = "session.budget"

func init() { event.Register[Report](BudgetReported) }

type Budget struct {
	Window    int     `json:"window"`
	Reserve   int     `json:"reserve"`
	Trigger   float64 `json:"trigger"`
	Target    float64 `json:"target"`
	KeepTurns int     `json:"keepTurns"`
	ResultCap int     `json:"resultCap"`
}

type Report struct {
	Estimate
	Window       int         `json:"window"`
	Reserve      int         `json:"reserve"`
	CacheRead    int         `json:"cacheRead"`
	CacheWrite   int         `json:"cacheWrite"`
	Code         string      `json:"code,omitempty"`
	Purpose      string      `json:"purpose"`
	SummaryUsage model.Usage `json:"summaryUsage,omitempty"`
}

type Builder struct {
	Budget       Budget
	Counter      *Counter
	Bus          *event.Bus
	Summarize    Summarizer
	SummaryUsage model.Usage
	lastUsage    model.Usage
	Snapshot     func(context.Context, *session.State) error
	// ManualOnly stops the builder from shrinking the context by itself; a full context then fails with MRK-4010.
	ManualOnly bool
}

// Compact rebuilds the context now, keeping the latest turn, whatever the thresholds say.
func (b *Builder) Compact(ctx context.Context, s *session.State) error {
	keep := b.Budget.KeepTurns
	b.Budget.KeepTurns = 1
	defer func() { b.Budget.KeepTurns = keep }()
	return b.Rebuild(ctx, s)
}

func (b *Builder) Build(ctx context.Context, s *session.State) (model.Request, error) {
	b.SummaryUsage = model.Usage{}
	request := requestFor(s, b.Budget.Reserve)
	for i := len(request.Messages) - 1; i >= 0; i-- {
		if request.Messages[i].Role != model.User {
			continue
		}
		input := request
		input.System = ""
		input.Tools = nil
		input.Messages = request.Messages[i : i+1]
		if b.Counter.Estimate(s.Config.Provider, input).Total > b.Budget.Window-b.Budget.Reserve {
			return model.Request{}, b.reportFailure(ctx, s, request, "MRK-4002")
		}
		break
	}
	value := b.Counter.Estimate(s.Config.Provider, request)
	if float64(value.Total+b.Budget.Reserve) > float64(b.Budget.Window)*b.Budget.Trigger {
		if b.ManualOnly {
			return model.Request{}, b.reportFailure(ctx, s, request, "MRK-4010")
		}
		if err := b.Rebuild(ctx, s); err != nil {
			code := "MRK-4003"
			if err.Error() == "MRK-4002" {
				code = "MRK-4002"
			}
			return model.Request{}, b.reportFailure(ctx, s, request, code)
		}
		request = requestFor(s, b.Budget.Reserve)
		value = b.Counter.Estimate(s.Config.Provider, request)
	}
	report := Report{Estimate: value, Window: b.Budget.Window, Reserve: b.Budget.Reserve, CacheRead: b.lastUsage.CacheRead, CacheWrite: b.lastUsage.CacheWrite, Purpose: "conversation"}
	report.Total += report.Reserve
	if err := b.emit(ctx, s, BudgetReported, report); err != nil {
		return model.Request{}, err
	}
	return request, nil
}

func (b *Builder) Rebuild(ctx context.Context, s *session.State) error {
	open := make(map[string]bool)
	for _, message := range s.Messages {
		for _, part := range message.Parts {
			if part.ToolCall != nil {
				open[part.ToolCall.ID] = true
			}
			if part.ToolResult != nil {
				delete(open, part.ToolResult.CallID)
			}
		}
	}
	if len(open) > 0 {
		return errors.New("MRK-4003")
	}
	if b.Summarize == nil {
		return errors.New("MRK-4003")
	}
	var starts []int
	for i, message := range s.Messages {
		if message.Role == model.User && !(i == 0 && s.SummaryID != "") {
			starts = append(starts, i)
		}
	}
	if len(starts) <= b.Budget.KeepTurns {
		return errors.New("MRK-4002")
	}
	maxCut := starts[len(starts)-b.Budget.KeepTurns]
	parent := requestFor(s, b.Budget.Reserve)
	target := int(float64(b.Budget.Window) * b.Budget.Target)
	for _, cut := range starts {
		if cut <= 0 || cut > maxCut {
			continue
		}
		candidate := parent
		candidate.Messages = session.WithoutReasoning(parent.Messages[cut:])
		keptEstimate := b.Counter.Estimate(s.Config.Provider, candidate).Total
		minimum := candidate
		minimum.Messages = append([]model.Message{{Role: model.User, Parts: []model.Part{{Text: summarySkeleton}}}}, candidate.Messages...)
		if b.Counter.Estimate(s.Config.Provider, minimum).Total+b.Budget.Reserve > target {
			continue
		}
		summaryLimit := min(2048, target-b.Budget.Reserve-keptEstimate-4)
		input := SummaryRequest{Parent: parent, To: cut, MaxTokens: summaryLimit}
		summaryEstimate := b.Counter.Estimate(s.Config.Provider, summaryRequest(input))
		if summaryEstimate.Total+summaryLimit > b.Budget.Window {
			return errors.New("MRK-4002")
		}
		report := Report{Estimate: summaryEstimate, Window: b.Budget.Window, Reserve: summaryLimit, Purpose: "summary"}
		report.Total += summaryLimit
		if err := b.emit(ctx, s, BudgetReported, report); err != nil {
			return err
		}
		summary, err := b.Summarize.Summarize(ctx, input)
		b.SummaryUsage = summary.Usage
		b.Counter.Observe(s.Config.Provider, summaryRequest(input), summary.Usage)
		if err != nil {
			return err
		}
		candidate.Messages = append([]model.Message{summary.Message}, candidate.Messages...)
		if b.Counter.Estimate(s.Config.Provider, candidate).Total+b.Budget.Reserve > target {
			return errors.New("MRK-4003")
		}
		return b.emit(ctx, s, session.Rebuilt, session.Rebuild{From: 0, To: cut, ThroughSeq: s.LastSeq, SummaryID: event.NewID(), PreviousSummary: s.SummaryID, Summary: summary.Message, Usage: summary.Usage})
	}
	return errors.New("MRK-4002")
}

func (b *Builder) Observe(provider string, request model.Request, usage model.Usage) {
	b.Counter.Observe(provider, request, usage)
	b.lastUsage = usage
}

func (b *Builder) reportFailure(ctx context.Context, s *session.State, request model.Request, code string) error {
	report := Report{Estimate: b.Counter.Estimate(s.Config.Provider, request), Window: b.Budget.Window, Reserve: b.Budget.Reserve, Code: code, Purpose: "conversation", SummaryUsage: b.SummaryUsage}
	report.Total += report.Reserve
	if err := b.emit(ctx, s, BudgetReported, report); err != nil {
		return err
	}
	return errors.New(code)
}

func requestFor(s *session.State, reserve int) model.Request {
	request := model.Request{Model: s.Config.Model, System: s.System, Messages: s.Messages, Thinking: s.Config.Thinking, MaxTokens: reserve}
	for _, spec := range s.Tools {
		request.Tools = append(request.Tools, model.ToolSpec{Name: spec.Name, Description: spec.Description, Input: compactSchema(spec.Input)})
	}
	return request
}

func (b *Builder) emit(ctx context.Context, s *session.State, kind event.Type, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	scope := s.Scope
	scope.Session = s.ID
	fact, err := b.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + s.ID), Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: s.Config.Member}, Type: kind, Payload: body})
	if err != nil {
		return err
	}
	if err := session.Fold(s, fact); err != nil {
		return err
	}
	if fact.Seq%128 == 0 && b.Snapshot != nil {
		return b.Snapshot(ctx, s)
	}
	return nil
}
