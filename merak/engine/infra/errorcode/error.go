package errorcode

// Error is a failure a user can see, with the MRK code that names its cause.
type Error struct {
	Code string
	Err  error
}

func (e *Error) Error() string { return e.Err.Error() }
func (e *Error) Unwrap() error { return e.Err }

func Coded(code string, err error) error { return &Error{Code: code, Err: err} }
