package session

import (
	"errors"
	"math"
	"time"
)

type Budget struct {
	MaxSteps     int           `json:"maxSteps,omitempty"`
	MaxTokens    int           `json:"maxTokens,omitempty"`
	MaxCost      float64       `json:"maxCost,omitempty"`
	MaxWallClock time.Duration `json:"maxWallClock,omitempty"`
}

func (b Budget) Validate() error {
	if b.MaxSteps < 0 || b.MaxTokens < 0 || b.MaxCost < 0 || math.IsNaN(b.MaxCost) || math.IsInf(b.MaxCost, 0) || b.MaxWallClock < 0 {
		return errors.New("budget limits must be finite and nonnegative")
	}
	return nil
}
