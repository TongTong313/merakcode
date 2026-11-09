// Package session derives conversation state from engine events.
package session

import (
	"encoding/json"
	"fmt"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"slices"
)

const (
	Created          event.Type = "session.created"
	Rebuilt          event.Type = "session.rebuilt"
	MessageSent      event.Type = "message.sent"
	MessageCompleted event.Type = "message.completed"
	MessageDelta     event.Type = "message.delta"
)

func init() {
	event.Register[State](Created)
	event.Register[Rebuild](Rebuilt)
	event.Register[model.Message](MessageSent)
	event.Register[Completion](MessageCompleted)
	event.Register[model.Chunk](MessageDelta)
}

type State struct {
	BaseCommit string                    `json:"baseCommit,omitempty"`
	Children   map[event.ID]ChildState   `json:"children,omitempty"`
	ID         event.ID                  `json:"id"`
	Scope      event.Scope               `json:"scope"`
	Config     Config                    `json:"config"`
	System     string                    `json:"system"`
	Messages   []model.Message           `json:"messages"`
	LastSeq    uint64                    `json:"lastSeq"`
	Usage      model.Usage               `json:"usage"`
	Tools      []tool.Spec               `json:"tools,omitempty"`
	Loaded     []string                  `json:"loaded,omitempty"`
	SummaryID  event.ID                  `json:"summaryId,omitempty"`
	Status     Status                    `json:"status"`
	Open       map[string]model.ToolCall `json:"open,omitempty"`
	Causes     map[string]event.ID       `json:"causes,omitempty"`
}

type Status string

const (
	Idle         Status = "idle"
	Running      Status = "running"
	WaitingHuman Status = "waiting_human"
	Done         Status = "done"
	Failed       Status = "failed"
)

type Rebuild struct {
	From            int           `json:"from"`
	To              int           `json:"to"`
	ThroughSeq      uint64        `json:"throughSeq"`
	SummaryID       event.ID      `json:"summaryId"`
	PreviousSummary event.ID      `json:"previousSummary,omitempty"`
	Summary         model.Message `json:"summary"`
	Usage           model.Usage   `json:"usage"`
}

type Config struct {
	Mode     permission.Mode `json:"mode,omitempty"`
	Member   event.ID        `json:"member,omitempty"`
	ToolPool string          `json:"toolPool,omitempty"`
	Parent   event.ID        `json:"parent,omitempty"`
	Provider string          `json:"provider"`
	Model    string          `json:"model"`
	Thinking model.Thinking  `json:"thinking,omitempty"`
	Workdir  string          `json:"workdir"`
}

type Selection struct {
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Thinking model.Thinking `json:"thinking,omitempty"`
}

type Started struct {
	Selection *Selection `json:"selection,omitempty"`
}

type Completion struct {
	model.Message
	Usage       model.Usage `json:"usage"`
	Interrupted bool        `json:"interrupted,omitempty"`
	Dropped     []string    `json:"dropped,omitempty"`
}

func Fold(s *State, e event.Event) error {
	if event.Transient(e.Type) {
		return nil
	}
	switch e.Type {
	case ChildStarted, ChildFinished:
		child, err := event.Decode[ChildResult](e)
		if err != nil {
			return err
		}
		if s.Children == nil {
			s.Children = make(map[event.ID]ChildState)
		}
		state := s.Children[child.ID]
		state.ID = child.ID
		if e.Type == ChildFinished && !state.Delivered {
			parts := append([]model.Part{{Text: fmt.Sprintf("Child %s report (%s):", child.ID, child.Stop)}}, child.Report...)
			s.Messages = append(s.Messages, model.Message{Role: model.User, Parts: parts})
			state.Delivered = true
		}
		s.Children[child.ID] = state
	case memory.Extracted:
		result, err := event.Decode[memory.Extraction](e)
		if err != nil {
			return err
		}
		s.Usage = s.Usage.Add(result.Usage)
	case "session.budget":
		var report struct {
			SummaryUsage model.Usage `json:"summaryUsage"`
		}
		if err := json.Unmarshal(e.Payload, &report); err != nil {
			return err
		}
		s.Usage = s.Usage.Add(report.SummaryUsage)
	case "turn.started":
		started, err := event.Decode[Started](e)
		if err != nil {
			return err
		}
		if started.Selection != nil {
			s.Config.Provider = started.Selection.Provider
			s.Config.Model = started.Selection.Model
			s.Config.Thinking = started.Selection.Thinking
		}
		s.Scope = e.Scope
		s.Scope.Turn = e.ID
		s.Status = Running
	case "turn.finished":
		var outcome struct {
			Stop string `json:"stop"`
		}
		if err := json.Unmarshal(e.Payload, &outcome); err != nil {
			return err
		}
		s.Status = Idle
		if outcome.Stop == "answered" {
			s.Status = Done
		}
		if outcome.Stop == "failed" {
			s.Status = Failed
		}
	case tool.Called:
		call, err := event.Decode[model.ToolCall](e)
		if err != nil {
			return err
		}
		if s.Open == nil {
			s.Open = make(map[string]model.ToolCall)
		}
		if s.Causes == nil {
			s.Causes = make(map[string]event.ID)
		}
		s.Open[call.ID] = call
		s.Causes[call.ID] = e.ID
	case Rebuilt:
		rebuilt, err := event.Decode[Rebuild](e)
		if err != nil {
			return err
		}
		if rebuilt.From != 0 || rebuilt.To <= 0 || rebuilt.To > len(s.Messages) {
			return fmt.Errorf("invalid rebuild range")
		}
		s.Messages = append([]model.Message{rebuilt.Summary}, WithoutReasoning(s.Messages[rebuilt.To:])...)
		s.SummaryID = rebuilt.SummaryID
		s.Usage = s.Usage.Add(rebuilt.Usage)
	case Created:
		created, err := event.Decode[State](e)
		if err != nil {
			return err
		}
		*s = created
		if s.Status == "" {
			s.Status = Idle
		}
	case MessageSent, MessageCompleted:
		message, err := event.Decode[Completion](e)
		if err != nil {
			return err
		}
		s.Messages = append(s.Messages, message.Message)
		s.Usage = s.Usage.Add(message.Usage)
		for _, part := range message.Parts {
			if part.ToolCall == nil {
				continue
			}
			if s.Open == nil {
				s.Open = make(map[string]model.ToolCall)
			}
			s.Open[part.ToolCall.ID] = *part.ToolCall
		}
	case tool.Completed:
		result, err := event.Decode[tool.Completion](e)
		if err != nil {
			return err
		}
		delete(s.Open, result.CallID)
		delete(s.Causes, result.CallID)
		if result.Name == "load_tools" && !result.IsError {
			for _, part := range result.Parts {
				var specs []tool.Spec
				if part.Text == "" {
					continue
				}
				if err := json.Unmarshal([]byte(part.Text), &specs); err != nil {
					return err
				}
				for _, spec := range specs {
					if !slices.Contains(s.Loaded, spec.Name) {
						s.Loaded = append(s.Loaded, spec.Name)
					}
				}
			}
		}
		part := model.Part{ToolResult: &model.ToolResult{
			CallID: result.CallID, Parts: result.Parts, IsError: result.IsError,
		}}
		if len(s.Messages) > 0 && s.Messages[len(s.Messages)-1].Role == model.Tool {
			s.Messages[len(s.Messages)-1].Parts = append(s.Messages[len(s.Messages)-1].Parts, part)
			break
		}
		s.Messages = append(s.Messages, model.Message{Role: model.Tool, Parts: []model.Part{part}})
	}
	if s.ID == "" {
		s.ID = e.Scope.Session
	}
	s.Scope.Session = s.ID
	s.LastSeq = e.Seq
	return nil
}

// WithoutReasoning builds a new message slice without changing the stored history.
func WithoutReasoning(messages []model.Message) []model.Message {
	result := make([]model.Message, 0, len(messages))
	for _, message := range messages {
		parts := make([]model.Part, 0, len(message.Parts))
		for _, part := range message.Parts {
			if part.Reasoning == nil {
				parts = append(parts, part)
			}
		}
		if len(parts) > 0 {
			result = append(result, model.Message{Role: message.Role, Parts: parts})
		}
	}
	return result
}
