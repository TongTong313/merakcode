package web_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/web"
)

const page = `<!doctype html><html><head><title>Guide</title>
<style>.hidden { display: none }</style><script>alert("secret script")</script></head>
<body><h1>Welcome</h1><p>Read the <a href="/docs/start">start page</a> and <a href="https://example.org/x">the site</a>.</p>
<h2>Steps</h2><ul><li>First</li><li>Second &amp; third</li></ul><noscript>no js</noscript>
<pre>code   line</pre><script type="text/javascript">var hidden = 1</script></body></html>`

func fetch(t *testing.T, address string, extra string) tool.Result {
	t.Helper()
	input := fmt.Sprintf(`{"url":%q%s}`, address, extra)
	result, err := (web.Fetch{}).Run(context.Background(), tool.Call{Input: json.RawMessage(input)})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestWebFetchTurnsHTMLIntoTextWithHeadingsListsAndLinksAndNoScripts(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, page)
	}))
	defer host.Close()
	result := fetch(t, host.URL+"/guide", "")
	if result.IsError {
		t.Fatalf("result=%+v", result)
	}
	got := text(result)
	for _, want := range []string{"# Welcome", "start page (" + host.URL + "/docs/start)", "the site (https://example.org/x)", "## Steps", "- First", "- Second & third", "code   line"} {
		if !strings.Contains(got, want) {
			t.Errorf("the text lacks %q:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"secret script", "display: none", "var hidden", "no js", "<h1>", "&amp;"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("the text still has %q:\n%s", unwanted, got)
		}
	}
	if (web.Fetch{}).Spec().Effect != tool.EffectNetwork {
		t.Error("fetching a page asks for network permission")
	}
}

func TestWebFetchFollowsAtMostFiveRedirectsAndReturnsPlainTextAsItIs(t *testing.T) {
	var host *httptest.Server
	host = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var hop int
		if _, err := fmt.Sscanf(r.URL.Path, "/hop/%d", &hop); err == nil {
			if hop < 5 {
				http.Redirect(w, r, fmt.Sprintf("/hop/%d", hop+1), http.StatusFound)
				return
			}
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprint(w, "arrived after five redirects")
			return
		}
		if r.URL.Path == "/loop/a" {
			http.Redirect(w, r, "/loop/b", http.StatusFound)
			return
		}
		if r.URL.Path == "/loop/b" {
			http.Redirect(w, r, "/loop/a", http.StatusFound)
			return
		}
		http.NotFound(w, r)
	}))
	defer host.Close()
	if got := text(fetch(t, host.URL+"/hop/0", "")); got != "arrived after five redirects" {
		t.Fatalf("five redirects: %q", got)
	}
	if result := fetch(t, host.URL+"/hop/-1", ""); !result.IsError {
		t.Fatal("six redirects were followed")
	}
	if result := fetch(t, host.URL+"/loop/a", ""); !result.IsError {
		t.Fatal("a redirect loop was followed")
	}
	if result := fetch(t, host.URL+"/missing", ""); !result.IsError || !strings.Contains(text(result), "404") {
		t.Fatalf("a missing page: %+v", result)
	}
}

func TestWebFetchRefusesOtherSchemesAndStopsAtFiveMegabytes(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, strings.Repeat("x", 6<<20))
	}))
	defer host.Close()
	for _, address := range []string{"file:///etc/passwd", "ftp://example.org/a", "javascript:alert(1)", "not a url", ""} {
		if result := fetch(t, address, ""); !result.IsError {
			t.Errorf("%q was fetched", address)
		}
	}
	result := fetch(t, host.URL, "")
	if result.IsError {
		t.Fatalf("a large page: %+v", result)
	}
	if got := text(result); len(got) > 6<<20 || !result.Truncated && !strings.Contains(got, "truncated") {
		t.Fatalf("the page was not cut: %d bytes truncated=%v", len(got), result.Truncated)
	}
}
