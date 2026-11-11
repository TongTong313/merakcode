package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

const (
	maxFetchBody      = 5 << 20
	maxFetchRedirects = 5
)

// Fetch reads a web page: it makes a GET request and returns the page as plain text with its links.
type Fetch struct {
	// Client carries the request; nil uses a client with a timeout.
	Client *http.Client
}

func (Fetch) Spec() tool.Spec {
	return tool.Spec{Name: "web_fetch", Description: "Fetch an http or https page and return it as plain text (headings as #, lists as -, links as text (address)). Follows 5 redirects, reads 5 MB. Needs network permission.", Effect: tool.EffectNetwork,
		Input: json.RawMessage(`{"type":"object","properties":{"url":{"type":"string","minLength":1}},"required":["url"],"additionalProperties":false}`)}
}

func (w Fetch) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	if err := ctx.Err(); err != nil {
		return tool.Result{}, err
	}
	var input struct {
		URL string `json:"url"`
	}
	if err := tool.Decode(call.Input, &input); err != nil {
		return tool.Fail(err), nil
	}
	address, err := url.Parse(strings.TrimSpace(input.URL))
	if err != nil || address.Host == "" || address.Scheme != "http" && address.Scheme != "https" {
		return tool.Fail(errors.New("only http and https addresses can be fetched")), nil
	}
	client := w.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	limited := *client
	limited.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) > maxFetchRedirects {
			return errors.New("too many redirects")
		}
		if request.URL.Scheme != "http" && request.URL.Scheme != "https" {
			return errors.New("a redirect left http and https")
		}
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address.String(), nil)
	if err != nil {
		return tool.Fail(err), nil
	}
	request.Header.Set("Accept", "text/html, text/plain;q=0.9, */*;q=0.5")
	request.Header.Set("User-Agent", "MerakCode")
	response, err := limited.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return tool.Result{}, ctx.Err()
		}
		return tool.Fail(fmt.Errorf("the request failed: %w", unwrapURLError(err))), nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return tool.Fail(fmt.Errorf("the server answered %d %s", response.StatusCode, http.StatusText(response.StatusCode))), nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxFetchBody+1))
	if err != nil {
		return tool.Fail(fmt.Errorf("reading the page failed: %w", err)), nil
	}
	cut := len(body) > maxFetchBody
	if cut {
		body = body[:maxFetchBody]
	}
	text := string(body)
	kind := strings.ToLower(response.Header.Get("Content-Type"))
	if strings.Contains(kind, "html") || kind == "" && strings.Contains(strings.ToLower(text[:min(len(text), 512)]), "<html") {
		text = htmlText(text, response.Request.URL)
	}
	if cut {
		text += "\n[truncated: the page is longer than 5 MB]"
	}
	return tool.Result{Parts: []model.Part{{Text: text}}}, nil
}

func unwrapURLError(err error) error {
	var failure *url.Error
	if errors.As(err, &failure) {
		return failure.Err
	}
	return err
}

// htmlText turns an HTML page into text with the standard library only: it drops scripts, styles and comments, keeps
// headings as # lines, list items as - lines and links as "text (address)".
func htmlText(source string, base *url.URL) string {
	var out strings.Builder
	var link strings.Builder
	var address string
	inLink, skip, pre := false, 0, false
	write := func(text string) {
		if inLink {
			link.WriteString(text)
			return
		}
		out.WriteString(text)
	}
	newline := func() {
		current := out.String()
		if len(current) > 0 && !strings.HasSuffix(current, "\n") {
			out.WriteByte('\n')
		}
	}
	for i := 0; i < len(source); {
		if source[i] != '<' {
			end := strings.IndexByte(source[i:], '<')
			if end < 0 {
				end = len(source) - i
			}
			chunk := html.UnescapeString(source[i : i+end])
			i += end
			if skip > 0 {
				continue
			}
			if pre {
				write(chunk)
			} else {
				write(collapse(chunk, out.String(), inLink, link.String()))
			}
			continue
		}
		if strings.HasPrefix(source[i:], "<!--") {
			end := strings.Index(source[i:], "-->")
			if end < 0 {
				break
			}
			i += end + 3
			continue
		}
		end := strings.IndexByte(source[i:], '>')
		if end < 0 {
			break
		}
		tag := source[i+1 : i+end]
		i += end + 1
		name, attributes, closing := parseTag(tag)
		switch name {
		case "script", "style", "noscript", "template", "head":
			if closing {
				skip = max(0, skip-1)
			} else if !strings.HasSuffix(strings.TrimSpace(tag), "/") {
				skip++
			}
			continue
		case "title":
			if closing {
				skip = max(0, skip-1)
			} else {
				skip++
			}
			continue
		}
		if skip > 0 {
			continue
		}
		switch name {
		case "h1", "h2", "h3", "h4", "h5", "h6":
			newline()
			if !closing {
				out.WriteString(strings.Repeat("#", int(name[1]-'0')) + " ")
			} else {
				out.WriteByte('\n')
			}
		case "p", "div", "section", "article", "header", "footer", "table", "tr", "br", "ul", "ol", "blockquote":
			newline()
		case "li":
			newline()
			if !closing {
				out.WriteString("- ")
			}
		case "pre":
			newline()
			pre = !closing
		case "a":
			if closing {
				if inLink {
					inLink = false
					label := strings.TrimSpace(link.String())
					link.Reset()
					switch {
					case address == "" || strings.HasPrefix(address, "#") || strings.HasPrefix(strings.ToLower(address), "javascript:"):
						out.WriteString(label)
					case label == "":
						out.WriteString(address)
					default:
						out.WriteString(label + " (" + address + ")")
					}
				}
			} else {
				inLink, address = true, ""
				if target := strings.TrimSpace(attributes["href"]); target != "" {
					address = target
					if base != nil {
						if resolved, err := base.Parse(target); err == nil {
							address = resolved.String()
						}
					}
				}
			}
		case "td", "th":
			if closing {
				write(" ")
			}
		}
	}
	lines := strings.Split(out.String(), "\n")
	cleaned := make([]string, 0, len(lines))
	blank := false
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		if strings.TrimSpace(line) == "" {
			if blank {
				continue
			}
			blank = true
		} else {
			blank = false
		}
		cleaned = append(cleaned, line)
	}
	return strings.TrimSpace(strings.Join(cleaned, "\n"))
}

// collapse folds runs of white space in a stretch of text into one space, and drops the leading one when the text
// continues a line that already ends in white space.
func collapse(chunk, written string, inLink bool, link string) string {
	var out strings.Builder
	space := false
	for _, r := range chunk {
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if space {
			out.WriteByte(' ')
			space = false
		}
		out.WriteRune(r)
	}
	if space {
		out.WriteByte(' ')
	}
	text := out.String()
	previous := written
	if inLink {
		previous = link
	}
	if strings.HasPrefix(text, " ") && (previous == "" || strings.HasSuffix(previous, " ") || strings.HasSuffix(previous, "\n") || strings.HasSuffix(previous, "- ") || strings.HasSuffix(previous, "# ")) {
		text = strings.TrimLeft(text, " ")
	}
	return text
}

// parseTag splits the inside of a tag into its lower-case name, its attributes and whether it closes an element.
func parseTag(tag string) (name string, attributes map[string]string, closing bool) {
	tag = strings.TrimSpace(tag)
	if strings.HasPrefix(tag, "/") {
		closing, tag = true, strings.TrimSpace(tag[1:])
	}
	tag = strings.TrimSuffix(tag, "/")
	end := strings.IndexAny(tag, " \t\r\n")
	if end < 0 {
		return strings.ToLower(tag), nil, closing
	}
	name = strings.ToLower(tag[:end])
	attributes = map[string]string{}
	rest := tag[end:]
	for {
		rest = strings.TrimLeft(rest, " \t\r\n")
		equals := strings.IndexByte(rest, '=')
		if equals < 0 {
			break
		}
		key := strings.ToLower(strings.TrimSpace(rest[:equals]))
		rest = strings.TrimLeft(rest[equals+1:], " \t\r\n")
		var value string
		if rest != "" && (rest[0] == '"' || rest[0] == '\'') {
			quote := rest[0]
			stop := strings.IndexByte(rest[1:], quote)
			if stop < 0 {
				value, rest = rest[1:], ""
			} else {
				value, rest = rest[1:1+stop], rest[stop+2:]
			}
		} else {
			stop := strings.IndexAny(rest, " \t\r\n")
			if stop < 0 {
				value, rest = rest, ""
			} else {
				value, rest = rest[:stop], rest[stop:]
			}
		}
		attributes[key] = html.UnescapeString(value)
	}
	return name, attributes, closing
}
