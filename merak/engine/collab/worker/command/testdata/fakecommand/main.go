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
	if os.Getenv("MERAKCODE_FIXTURE_MODE") == "hold-once" {
		// The first run in a directory holds; a restarted run in the same directory finishes.
		if _, err := os.Stat("started.flag"); err != nil {
			if err := os.WriteFile("started.flag", input, 0600); err != nil {
				os.Exit(3)
			}
			_, _ = io.WriteString(os.Stdout, "Waiting")
			for {
				time.Sleep(time.Second)
			}
		}
	}
	if os.Getenv("MERAKCODE_FIXTURE_MODE") == "env" {
		if err := os.WriteFile("env.txt", []byte(os.Getenv(os.Getenv("MERAKCODE_FIXTURE_ECHO"))), 0600); err != nil {
			os.Exit(3)
		}
	}
	if err := os.WriteFile("input.txt", input, 0600); err != nil {
		os.Exit(3)
	}
	_, _ = io.WriteString(os.Stdout, `{"verdict":"done","summary":"Inspected"}`)
}
