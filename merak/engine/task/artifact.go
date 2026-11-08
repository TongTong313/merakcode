package task

type Artifact struct {
	Path      string `json:"path"`
	Title     string `json:"title,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
}
