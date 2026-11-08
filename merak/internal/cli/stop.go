package cli

import (
	"context"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
)

func stopEngine() int {
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := connectEngine(ctx, home)
	if err != nil {
		return 1
	}
	defer client.Close()
	if err := client.Call(ctx, "engine.stop", struct{}{}, nil); err != nil {
		return 1
	}
	for {
		select {
		case fact, ok := <-client.Events:
			if !ok {
				return 1
			}
			if fact.Type == engine.Shutdown {
				return 0
			}
		case <-ctx.Done():
			return 1
		}
	}
}
