package model

// Error carries a registered diagnostic code without exposing response bodies or credentials.
type Error struct {
	Code   string
	Status int
	Cause  error
}

func (e *Error) Error() string { return e.Code }
func (e *Error) Unwrap() error { return e.Cause }
