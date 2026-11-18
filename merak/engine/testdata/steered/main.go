// Command steered keeps a real external turn open until its caller releases it.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
	"time"
)

func main() {
	reader := bufio.NewScanner(os.Stdin)
	var started sync.Once
	for reader.Scan() {
		var input struct {
			Type      string                   `json:"type"`
			RequestID string                   `json:"request_id"`
			Request   struct{ Subtype string } `json:"request"`
		}
		if json.Unmarshal(reader.Bytes(), &input) != nil {
			os.Exit(2)
		}
		if input.Type == "control_request" && input.Request.Subtype == "initialize" {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": input.RequestID, "response": map[string]any{}}})
			continue
		}
		if input.Type != "user" {
			os.Exit(3)
		}
		started.Do(func() {
			if os.WriteFile("ready", []byte("ready"), 0o600) != nil {
				os.Exit(4)
			}
			go finishWhenReleased()
		})
	}
}

func finishWhenReleased() {
	for {
		if _, err := os.Stat("release"); err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "assistant", "message": map[string]any{"content": []map[string]string{{"type": "text", "text": "External turn finished."}}}})
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "subtype": "success", "result": "External turn finished."})
	os.Exit(0)
}
