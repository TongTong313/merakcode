package config

type LaunchDecision struct {
	Member   string `json:"member"`
	Project  string `json:"project"`
	Decision string `json:"decision"`
}

func (s *Store) UnconfinedDecision(member, project string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, saved := range s.value.Unconfined {
		if saved.Member == member && saved.Project == project {
			return saved.Decision
		}
	}
	return ""
}

func (s *Store) RememberUnconfinedDecision(member, project, decision string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := make([]LaunchDecision, 0, len(s.value.Unconfined)+1)
	for _, saved := range s.value.Unconfined {
		if saved.Member != member || saved.Project != project {
			values = append(values, saved)
		}
	}
	values = append(values, LaunchDecision{Member: member, Project: project, Decision: decision})
	_, err := s.update(Patch{Unconfined: &values})
	return err
}
