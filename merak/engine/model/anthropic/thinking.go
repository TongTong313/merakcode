package anthropic

import (
	"regexp"
	"strconv"

	"github.com/TongTong313/merakcode/merak/engine/model"
	sdk "github.com/anthropics/anthropic-sdk-go/v2"
)

var claudeVersion = regexp.MustCompile(`claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?`)

func applyThinking(params *sdk.MessageNewParams, request model.Request) {
	if request.Thinking == "" {
		return
	}
	var major, minor int
	if match := claudeVersion.FindStringSubmatch(request.Model); len(match) > 0 {
		major, _ = strconv.Atoi(match[1])
		minor, _ = strconv.Atoi(match[2])
	}
	effort := request.Thinking
	if effort == model.ThinkingOff {
		if major < 5 {
			params.Thinking = sdk.ThinkingConfigParamUnion{OfDisabled: &sdk.ThinkingConfigDisabledParam{}}
			return
		}
		effort = model.ThinkingLow
	}
	if major >= 5 || major == 4 && minor >= 6 {
		if major == 4 && minor == 6 && effort == model.ThinkingXHigh {
			effort = model.ThinkingHigh
		}
		params.Thinking = sdk.ThinkingConfigParamUnion{OfAdaptive: &sdk.ThinkingConfigAdaptiveParam{}}
		params.OutputConfig.Effort = sdk.OutputConfigEffort(effort)
		return
	}
	budget := map[model.Thinking]int64{model.ThinkingLow: 1024, model.ThinkingMedium: 4096, model.ThinkingHigh: 8192, model.ThinkingXHigh: 16384, model.ThinkingMax: 32768}[effort]
	if budget == 0 || params.MaxTokens <= 1024 {
		return
	}
	params.Thinking = sdk.ThinkingConfigParamOfEnabled(min(budget, params.MaxTokens-1))
}
