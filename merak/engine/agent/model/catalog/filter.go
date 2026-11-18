package catalog

import "regexp"

// notChat names, for each provider, the models in its list that cannot hold a conversation: embeddings, rerankers,
// speech, image, video and moderation models. Providers that are not listed use the "" entry.
var notChat = map[string]*regexp.Regexp{
	"":          regexp.MustCompile(`(?i)embed|rerank|(^|[-_/.])(tts|asr|whisper|moderation|dall-e|flux|sora|veo)([-_/.]|$)|speech|voice|text-to-image|image-gen`),
	"openai":    regexp.MustCompile(`(?i)embedding|whisper|tts|dall-e|gpt-image|moderation|sora|davinci|babbage|transcribe`),
	"anthropic": regexp.MustCompile(`^$`),
	"deepseek":  regexp.MustCompile(`(?i)embed`),
	"moonshot":  regexp.MustCompile(`(?i)embed`),
	"zhipu":     regexp.MustCompile(`(?i)embedding|cogview|cogvideo|(^|-)tts|(^|-)asr`),
	"dashscope": regexp.MustCompile(`(?i)embedding|rerank|tts|asr|wanx|paraformer|cosyvoice|sensevoice|image|video`),
	"gemini":    regexp.MustCompile(`(?i)embedding|imagen|veo|aqa|tts|native-audio`),
}

// chatModel reports whether a model of a provider's list is kept.
func chatModel(provider, id string) bool {
	rule, ok := notChat[provider]
	if !ok {
		rule = notChat[""]
	}
	return !rule.MatchString(id)
}
