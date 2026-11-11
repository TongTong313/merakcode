package skill

import (
	"slices"
	"strings"
	"sync"
	"unicode"
)

const (
	// threshold is the score a skill needs to be recommended: one weak match is not enough.
	threshold = 3
	// MaxRecommended is how many skills one message can bring up.
	MaxRecommended = 3
)

var stopWords = map[string]bool{}

func init() {
	for _, word := range strings.Fields(`a an and are as at be but by can could do does for from had has have how i if in into is it its
		me my not of on or our please should so that the their then there these this those to up us was we were what when
		where which who why will with would you your help need want make get use using about also just some any all one
		的 了 是 在 和 与 或 把 被 请 帮 我 你 他 她 它 们 这 那 个 一 不 有 要 能 可 以 吗 呢 吧 啊 对 为 从 到 给 让 用 做 将`) {
		stopWords[word] = true
	}
}

// tokens splits text into lower-case words: runs of letters and digits, and for Chinese (and other unspaced
// scripts) every character and every pair of neighbours, minus the stop words.
func tokens(text string) map[string]int {
	counts := make(map[string]int)
	var word []rune
	flush := func() {
		if len(word) > 1 {
			if token := string(word); !stopWords[token] {
				counts[stem(token)]++
			}
		}
		word = word[:0]
	}
	var han []rune
	flushHan := func() {
		for i, r := range han {
			if single := string(r); !stopWords[single] && len(han) == 1 {
				counts[single]++
			}
			if i+1 < len(han) {
				counts[string(han[i:i+2])]++
			}
		}
		han = han[:0]
	}
	for _, r := range strings.ToLower(text) {
		switch {
		case unicode.Is(unicode.Han, r):
			flush()
			if !stopWords[string(r)] {
				han = append(han, r)
			} else {
				flushHan()
			}
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushHan()
			word = append(word, r)
		default:
			flush()
			flushHan()
		}
	}
	flush()
	flushHan()
	return counts
}

// Recommend returns the skills that fit a message, best first, at most three. A skill fits when the message shares
// enough words with its name and description; a word of the name counts for more.
func (s Set) Recommend(message string) []Skill {
	words := tokens(message)
	if len(words) == 0 {
		return nil
	}
	type scored struct {
		skill Skill
		score int
	}
	var found []scored
	for _, candidate := range s.Skills {
		score := 0
		for word := range tokens(candidate.Name) {
			if words[word] > 0 {
				score += 3
			}
		}
		for word := range tokens(candidate.Description) {
			if words[word] > 0 {
				score++
			}
		}
		if score >= threshold {
			found = append(found, scored{candidate, score})
		}
	}
	slices.SortStableFunc(found, func(a, b scored) int {
		if a.score != b.score {
			return b.score - a.score
		}
		return strings.Compare(a.skill.Name, b.skill.Name)
	})
	var result []Skill
	for _, entry := range found[:min(MaxRecommended, len(found))] {
		result = append(result, entry.skill)
	}
	return result
}

// Recommender recommends skills for the messages of one session and never shows the same group twice.
type Recommender struct {
	set  Set
	mu   sync.Mutex
	seen map[string]bool
}

// Recommender starts the recommendations of a session.
func (s Set) Recommender() *Recommender { return &Recommender{set: s, seen: make(map[string]bool)} }

// For returns the text to put after a user message, or "" when nothing fits or the group was shown already.
func (r *Recommender) For(message string) string {
	found := r.set.Recommend(message)
	if len(found) == 0 {
		return ""
	}
	names := make([]string, len(found))
	for i, skill := range found {
		names[i] = skill.Name
	}
	slices.Sort(names)
	key := strings.Join(names, "\x00")
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.seen[key] {
		return ""
	}
	r.seen[key] = true
	lines := []string{"[Skills that may help with this message. Load one with the skill tool if it fits:]"}
	for _, skill := range found {
		lines = append(lines, "- "+skill.Name+": "+skill.Description)
	}
	return strings.Join(lines, "\n")
}

// stem folds a plural into its singular, so "migrations" and "migration" are the same word.
func stem(word string) string {
	switch {
	case len(word) > 4 && strings.HasSuffix(word, "ies"):
		return word[:len(word)-3] + "y"
	case len(word) > 4 && strings.HasSuffix(word, "s") && !strings.HasSuffix(word, "ss"):
		return word[:len(word)-1]
	}
	return word
}
