package anthropic

type Config struct{ Name, BaseURL string }

func Builtin(name string) (Config, bool) {
	configs := map[string]Config{
		"anthropic": {Name: "anthropic", BaseURL: "https://api.anthropic.com"},
		"deepseek":  {Name: "deepseek", BaseURL: "https://api.deepseek.com/anthropic"},
		"moonshot":  {Name: "moonshot", BaseURL: "https://api.moonshot.ai/anthropic"},
		"zhipu":     {Name: "zhipu", BaseURL: "https://open.bigmodel.cn/api/anthropic"},
	}
	config, ok := configs[name]
	return config, ok
}
