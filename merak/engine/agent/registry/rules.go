package registry

// ConfigureRules sets the personal rules of the user; they come before the project's rules in the prompt of
// every conversation started afterwards.
func (e *Registry) ConfigureRules(personal []string) {
	copied := append([]string(nil), personal...)
	e.personal.Store(&copied)
}

func (e *Registry) PersonalRules() []string {
	if rules := e.personal.Load(); rules != nil {
		return *rules
	}
	return nil
}
