package cli

import (
	"context"
	"encoding/json"
	"io"
	"os"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func readCode(input io.Reader, output io.Writer) int {
	decoder := json.NewDecoder(io.LimitReader(input, 1<<20))
	decoder.DisallowUnknownFields()
	var call tool.Call
	if decoder.Decode(&call) != nil || decoder.Decode(new(any)) != io.EOF {
		return 2
	}
	directory, err := os.Getwd()
	if err != nil {
		return 1
	}
	result, err := tool.ReadCode(context.Background(), directory, call)
	if err != nil {
		return 1
	}
	if json.NewEncoder(output).Encode(result) != nil {
		return 1
	}
	return 0
}
