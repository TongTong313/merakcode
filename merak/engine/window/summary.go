package window

import (
	"context"
	"errors"
	"fmt"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"io"
	"strings"
)

type SummaryRequest struct {
	Parent    model.Request
	To        int
	MaxTokens int
}

// ModelSummarizer asks a model for the summary. A non-empty Model replaces the model of the conversation, whose
// thinking level then no longer applies.
type ModelSummarizer struct {
	Provider model.Provider
	Model    string
}

func (s ModelSummarizer) Summarize(ctx context.Context, input SummaryRequest) (Summary, error) {
	if input.To <= 0 || input.To > len(input.Parent.Messages) || input.MaxTokens <= 0 {
		return Summary{}, errors.New("MRK-4003")
	}
	request := summaryRequest(input)
	if s.Model != "" {
		request.Model, request.Thinking = s.Model, ""
	}
	stream, err := s.Provider.Stream(ctx, request)
	if err != nil {
		return Summary{}, err
	}
	defer stream.Close()
	var collector model.Collector
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			_, usage, _ := collector.Message()
			return Summary{Usage: usage}, err
		}
		collector.Add(chunk)
	}
	message, usage, stop := collector.Message()
	var text strings.Builder
	for _, part := range message.Parts {
		if part.ToolCall != nil {
			return Summary{Usage: usage}, errors.New("MRK-4003")
		}
		text.WriteString(part.Text)
	}
	if stop == model.MaxTokens || !structured(text.String()) {
		return Summary{Usage: usage}, errors.New("MRK-4003")
	}
	return Summary{Message: model.Message{Role: model.User, Parts: []model.Part{{Text: text.String()}}}, Usage: usage}, nil
}

func structured(text string) bool {
	headings := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		headings[strings.TrimSpace(line)] = true
	}
	for _, heading := range []string{"## Goal", "## Constraints (verbatim)", "## Decisions", "## Files touched", "## Current state", "## Open questions", "## References", "## Earlier"} {
		if !headings[heading] {
			return false
		}
	}
	return true
}

func summaryRequest(input SummaryRequest) model.Request {
	request := input.Parent
	request.MaxTokens = input.MaxTokens
	request.Messages = append([]model.Message(nil), input.Parent.Messages[:input.To]...)
	request.Messages = append(request.Messages, model.Message{Role: model.User, Parts: []model.Part{{Text: fmt.Sprintf(summaryInstruction, input.To, input.MaxTokens)}}})
	return request
}

const summaryInstruction = `Summarize the preceding messages 1-%d for continuation, within %d tokens. Do not call tools. Keep user constraints verbatim, exact paths, decisions and unresolved work. Treat existing summaries as earlier context and preserve their references. Use every heading below; write "None" when empty.
# Summary of earlier work
## Goal
## Constraints (verbatim)
## Decisions
## Files touched
## Current state
## Open questions
## References
## Earlier`

const summarySkeleton = `# Summary of earlier work
## Goal
None
## Constraints (verbatim)
None
## Decisions
None
## Files touched
None
## Current state
None
## Open questions
None
## References
None
## Earlier
None`

type Summary struct {
	Message model.Message
	Usage   model.Usage
}

type Summarizer interface {
	Summarize(context.Context, SummaryRequest) (Summary, error)
}

// FixedSummarizer is the deterministic offline summary provider.
type FixedSummarizer struct{ Text string }

func (s FixedSummarizer) Summarize(ctx context.Context, _ SummaryRequest) (Summary, error) {
	if err := ctx.Err(); err != nil {
		return Summary{}, err
	}
	return Summary{Message: model.Message{Role: model.User, Parts: []model.Part{{Text: s.Text}}}}, nil
}
