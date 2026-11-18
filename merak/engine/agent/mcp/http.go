package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// HTTPOptions says how to reach a remote MCP server.
type HTTPOptions struct {
	URL     string
	Headers map[string]string
	// Token returns the access token to send as a bearer credential; nil sends none.
	Token func(context.Context) (string, error)
	// Client carries the requests; nil uses a client without an overall timeout (event streams stay open).
	Client *http.Client
}

// AuthRequired says the server wants a login. It carries what the server announced about how to log in.
type AuthRequired struct {
	// ResourceMetadata is the address of the protected-resource metadata (RFC 9728), when the server gave one.
	ResourceMetadata string
	// Scope is the scope the server asked for.
	Scope string
}

func (e *AuthRequired) Error() string { return "the MCP server needs a login" }

// transportError is a failure of the HTTP exchange that is not a login demand.
type transportError struct {
	status int
	body   string
}

func (e *transportError) Error() string {
	return fmt.Sprintf("MCP server answered %d %s", e.status, strings.TrimSpace(e.body))
}

var challengeParameter = regexp.MustCompile(`([A-Za-z_]+)="([^"]*)"`)

func authChallenge(response *http.Response) *AuthRequired {
	auth := &AuthRequired{}
	for _, value := range response.Header.Values("WWW-Authenticate") {
		for _, match := range challengeParameter.FindAllStringSubmatch(value, -1) {
			switch match[1] {
			case "resource_metadata":
				auth.ResourceMetadata = match[2]
			case "scope":
				auth.Scope = match[2]
			}
		}
	}
	return auth
}

// ConnectHTTP connects to a remote server over Streamable HTTP; a server that does not speak it is reached over the
// older HTTP+SSE transport. A server that demands a login gives an *AuthRequired error.
func ConnectHTTP(ctx context.Context, name string, options HTTPOptions) (*Client, error) {
	if options.Client == nil {
		options.Client = &http.Client{}
	}
	pipe := newStreamablePipe(options)
	client, err := Connect(ctx, name, pipe, pipe)
	if err == nil {
		return client, nil
	}
	if failure := pipe.failure(); failure != nil {
		var status *transportError
		if errors.As(failure, &status) && (status.status == http.StatusNotFound || status.status == http.StatusMethodNotAllowed || status.status == http.StatusBadRequest) {
			return connectLegacy(ctx, name, options)
		}
		return nil, failure
	}
	return nil, err
}

func (o HTTPOptions) request(ctx context.Context, method, address string, body []byte) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range o.Headers {
		request.Header.Set(key, value)
	}
	if o.Token != nil {
		token, err := o.Token(ctx)
		if err != nil {
			return nil, err
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
	}
	return request, nil
}

// streamablePipe adapts Streamable HTTP to the line-per-message streams a Client reads and writes: every message
// written is posted, and every message of a reply is written back as a line.
type streamablePipe struct {
	options HTTPOptions
	reader  *io.PipeReader
	writer  *io.PipeWriter
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	session string
	err     error
	posts   sync.WaitGroup
}

func newStreamablePipe(options HTTPOptions) *streamablePipe {
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	return &streamablePipe{options: options, reader: reader, writer: writer, ctx: ctx, cancel: cancel}
}

func (p *streamablePipe) Read(buffer []byte) (int, error) { return p.reader.Read(buffer) }

func (p *streamablePipe) failure() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

func (p *streamablePipe) fail(err error) {
	p.mu.Lock()
	if p.err == nil {
		p.err = err
	}
	p.mu.Unlock()
	_ = p.writer.CloseWithError(err)
}

func (p *streamablePipe) Write(data []byte) (int, error) {
	message := bytes.TrimSpace(data)
	if len(message) == 0 {
		return len(data), nil
	}
	if p.failure() != nil {
		return 0, io.ErrClosedPipe
	}
	copied := append([]byte(nil), message...)
	p.posts.Add(1)
	go func() {
		defer p.posts.Done()
		p.post(copied)
	}()
	return len(data), nil
}

func (p *streamablePipe) post(message []byte) {
	request, err := p.options.request(p.ctx, http.MethodPost, p.options.URL, message)
	if err != nil {
		p.fail(err)
		return
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", Version)
	p.mu.Lock()
	if p.session != "" {
		request.Header.Set("Mcp-Session-Id", p.session)
	}
	p.mu.Unlock()
	response, err := p.options.Client.Do(request)
	if err != nil {
		if p.ctx.Err() == nil {
			p.fail(err)
		}
		return
	}
	defer response.Body.Close()
	if id := response.Header.Get("Mcp-Session-Id"); id != "" {
		p.mu.Lock()
		p.session = id
		p.mu.Unlock()
	}
	switch {
	case response.StatusCode == http.StatusUnauthorized:
		p.fail(authChallenge(response))
	case response.StatusCode == http.StatusAccepted:
	case response.StatusCode >= 400:
		text, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		p.fail(&transportError{status: response.StatusCode, body: string(text)})
	case strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream"):
		p.readEvents(response.Body)
	default:
		body, err := io.ReadAll(io.LimitReader(response.Body, messageLimit))
		if err != nil {
			p.fail(err)
			return
		}
		p.emit(body)
	}
}

// readEvents writes the data of every message event of a stream as one line.
func (p *streamablePipe) readEvents(body io.Reader) {
	readEventStream(body, func(kind, data string) {
		if kind == "" || kind == "message" {
			p.emit([]byte(data))
		}
	})
}

func (p *streamablePipe) emit(body []byte) {
	var compact bytes.Buffer
	if json.Compact(&compact, bytes.TrimSpace(body)) != nil || compact.Len() == 0 {
		return
	}
	compact.WriteByte('\n')
	_, _ = p.writer.Write(compact.Bytes())
}

func (p *streamablePipe) Close() error {
	p.mu.Lock()
	session := p.session
	p.mu.Unlock()
	p.cancel()
	_ = p.writer.Close()
	_ = p.reader.Close()
	if session != "" {
		ending, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		if request, err := p.options.request(ending, http.MethodDelete, p.options.URL, nil); err == nil {
			request.Header.Set("Mcp-Session-Id", session)
			if response, err := p.options.Client.Do(request); err == nil {
				response.Body.Close()
			}
		}
	}
	return nil
}

// readEventStream calls handle for each event of a server-sent event stream, with its kind and joined data lines.
func readEventStream(body io.Reader, handle func(kind, data string)) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), messageLimit)
	var kind string
	var data []string
	flush := func() {
		if len(data) > 0 {
			handle(kind, strings.Join(data, "\n"))
		}
		kind, data = "", nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, ":"):
		case strings.HasPrefix(line, "event:"):
			kind = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
}

// legacyPipe is the older HTTP+SSE transport: a long-lived GET announces the address to post to, and every answer
// comes back as an event on that stream.
type legacyPipe struct {
	options  HTTPOptions
	reader   *io.PipeReader
	writer   *io.PipeWriter
	ctx      context.Context
	cancel   context.CancelFunc
	endpoint chan string
	// target is the address to post messages to, once the server has announced it.
	target string
}

func connectLegacy(ctx context.Context, name string, options HTTPOptions) (*Client, error) {
	reader, writer := io.Pipe()
	streamCtx, cancel := context.WithCancel(context.Background())
	pipe := &legacyPipe{options: options, reader: reader, writer: writer, ctx: streamCtx, cancel: cancel, endpoint: make(chan string, 1)}
	request, err := options.request(streamCtx, http.MethodGet, options.URL, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	request.Header.Set("Accept", "text/event-stream")
	response, err := options.Client.Do(request)
	if err != nil {
		cancel()
		return nil, err
	}
	if response.StatusCode == http.StatusUnauthorized {
		response.Body.Close()
		cancel()
		return nil, authChallenge(response)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		cancel()
		return nil, &transportError{status: response.StatusCode}
	}
	go func() {
		defer response.Body.Close()
		defer writer.Close()
		readEventStream(response.Body, func(kind, data string) {
			switch kind {
			case "endpoint":
				select {
				case pipe.endpoint <- data:
				default:
				}
			case "", "message":
				var compact bytes.Buffer
				if json.Compact(&compact, []byte(data)) == nil {
					compact.WriteByte('\n')
					_, _ = writer.Write(compact.Bytes())
				}
			}
		})
	}()
	select {
	case address := <-pipe.endpoint:
		target, err := resolve(options.URL, address)
		if err != nil {
			pipe.Close()
			return nil, err
		}
		pipe.target = target
	case <-ctx.Done():
		pipe.Close()
		return nil, ctx.Err()
	case <-time.After(10 * time.Second):
		pipe.Close()
		return nil, errors.New("the MCP server did not announce where to post")
	}
	return Connect(ctx, name, pipe, pipe)
}

func (p *legacyPipe) Read(buffer []byte) (int, error) { return p.reader.Read(buffer) }

func (p *legacyPipe) Write(data []byte) (int, error) {
	message := bytes.TrimSpace(data)
	if len(message) == 0 {
		return len(data), nil
	}
	copied := append([]byte(nil), message...)
	go func() {
		request, err := p.options.request(p.ctx, http.MethodPost, p.target, copied)
		if err != nil {
			return
		}
		request.Header.Set("Content-Type", "application/json")
		if response, err := p.options.Client.Do(request); err == nil {
			response.Body.Close()
		}
	}()
	return len(data), nil
}

func (p *legacyPipe) Close() error {
	p.cancel()
	_ = p.writer.Close()
	_ = p.reader.Close()
	return nil
}

func resolve(base, reference string) (string, error) {
	root, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	next, err := root.Parse(reference)
	if err != nil {
		return "", err
	}
	return next.String(), nil
}
