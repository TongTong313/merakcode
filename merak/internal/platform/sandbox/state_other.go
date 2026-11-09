//go:build !windows

package sandbox

func privateStatePath(string, bool) error { return nil }
