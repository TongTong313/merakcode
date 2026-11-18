// Package credential defines the credential vault used by the engine.
package credential

import "context"

// Vault keeps secrets. Values never go into a database, an event or a configuration file.
type Vault interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, value []byte) error
	Delete(ctx context.Context, key string) error
}
