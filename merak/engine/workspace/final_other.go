//go:build !windows

package workspace

// resolveJunctions has nothing to add: filepath.EvalSymlinks already follows every kind of link here.
func resolveJunctions(path string) string { return path }
