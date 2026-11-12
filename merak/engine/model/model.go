// Package model defines the provider interface and the engine's message format.
package model

import (
	"context"
	"encoding/json"
)

type Provider interface {
	Name() string
	Stream(context.Context, Request) (Stream, error)
}

type Request struct {
	Model     string
	System    string
	Messages  []Message
	Tools     []ToolSpec
	Thinking  Thinking
	MaxTokens int
	// Temperature, TopP and TopK are sent to the provider when set; nil leaves the provider default.
	Temperature *float64
	TopP        *float64
	TopK        *int
	Cache       CacheHint
}

// CacheHint controls the lifetime of the frozen system prefix and conversation cache.
type CacheHint struct{ TTL string }

type Thinking string

const (
	ThinkingOff    Thinking = "off"
	ThinkingLow    Thinking = "low"
	ThinkingMedium Thinking = "medium"
	ThinkingHigh   Thinking = "high"
	ThinkingXHigh  Thinking = "xhigh"
	ThinkingMax    Thinking = "max"
)

type ToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Input       json.RawMessage `json:"input"`
}

type Role string

const (
	User      Role = "user"
	Assistant Role = "assistant"
	Tool      Role = "tool"
)

type Message struct {
	Role  Role   `json:"role"`
	Parts []Part `json:"parts"`
}

type Part struct {
	Text string `json:"text,omitempty"`
	// Synthetic marks text the engine added for the model, such as the date and recalled notes; a client does not show it.
	Synthetic  bool        `json:"synthetic,omitempty"`
	Reasoning  *Reasoning  `json:"reasoning,omitempty"`
	ToolCall   *ToolCall   `json:"toolCall,omitempty"`
	ToolResult *ToolResult `json:"toolResult,omitempty"`
	Image      *Image      `json:"image,omitempty"`
	Document   *Document   `json:"document,omitempty"`
}

type Document struct {
	MIME string `json:"mime"`
	Name string `json:"name"`
	Data []byte `json:"data"`
}

type Image struct {
	MIME string `json:"mime"`
	Data []byte `json:"data,omitempty"`
	URL  string `json:"url,omitempty"`
}

type Reasoning struct {
	Text     string          `json:"text,omitempty"`
	Opaque   json.RawMessage `json:"opaque,omitempty"`
	Provider string          `json:"provider"`
}

type ToolCall struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// MarshalJSON preserves malformed argument text as a JSON string so a rejected call can still be recorded.
func (c ToolCall) MarshalJSON() ([]byte, error) {
	type wireCall ToolCall
	wire := wireCall(c)
	if len(wire.Input) > 0 && !json.Valid(wire.Input) {
		wire.Input, _ = json.Marshal(string(wire.Input))
	}
	return json.Marshal(wire)
}

type ToolResult struct {
	CallID  string `json:"callId"`
	Parts   []Part `json:"parts"`
	IsError bool   `json:"isError,omitempty"`
}

type Stream interface {
	Recv() (Chunk, error)
	Close() error
}

type ChunkKind string
type StopReason string

const (
	Text           ChunkKind  = "text"
	ReasoningChunk ChunkKind  = "reasoning"
	Stop           ChunkKind  = "stop"
	EndTurn        StopReason = "endTurn"
	ToolUse        StopReason = "toolUse"
	ToolCallStart  ChunkKind  = "toolCallStart"
	ToolCallDelta  ChunkKind  = "toolCallDelta"
	ToolCallEnd    ChunkKind  = "toolCallEnd"
	UsageChunk     ChunkKind  = "usage"
	DroppedChunk   ChunkKind  = "dropped"
	MaxTokens      StopReason = "maxTokens"
	Refusal        StopReason = "refusal"
)

type Chunk struct {
	Kind      ChunkKind  `json:"kind"`
	Text      string     `json:"text,omitempty"`
	Stop      StopReason `json:"stop,omitempty"`
	ToolCall  *ToolCall  `json:"toolCall,omitempty"`
	Usage     *Usage     `json:"usage,omitempty"`
	Reasoning *Reasoning `json:"reasoning,omitempty"`
	Dropped   string     `json:"dropped,omitempty"`
}

type Usage struct {
	Input      int     `json:"input"`
	Output     int     `json:"output"`
	CacheRead  int     `json:"cacheRead"`
	CacheWrite int     `json:"cacheWrite"`
	Cost       float64 `json:"cost"`
	CostKnown  bool    `json:"costKnown"`
	Currency   string  `json:"currency,omitempty"`
}
