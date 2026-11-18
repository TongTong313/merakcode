//go:build !windows

package folder

// resolveJunctions has nothing to add: filepath.EvalSymlinks already follows every kind of link here.
func resolveJunctions(path string) string { return path }
