package main

import (
	"io"
	"os"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		_, _ = io.WriteString(os.Stdout, "fixture 1.0.0\n")
		return
	}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Exit(2)
	}
	if os.Getenv("MERAKCODE_FIXTURE_MODE") == "hold" {
		_, _ = io.WriteString(os.Stdout, "Waiting")
		for {
			time.Sleep(time.Second)
		}
	}
	if err := os.WriteFile("input.txt", input, 0600); err != nil {
		os.Exit(3)
	}
	_, _ = io.WriteString(os.Stdout, `{"verdict":"done","summary":"Inspected"}`)
}
