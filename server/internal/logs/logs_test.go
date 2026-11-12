package logs

import (
	"bytes"
	"crypto/tls"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScrubTakesOutAddressesAndIDs(t *testing.T) {
	id := "6f1c2a9e0b7d4c3e8a5f1b2c3d4e5f60"
	cases := map[string]string{
		"http: TLS handshake error from 203.0.113.7:51234: EOF":         "http: TLS handshake error from <address>: EOF",
		"from [2001:db8::7]:443, then 192.168.1.20.":                    "from [<address>]:443, then <address>.",
		"panic serving 10.0.0.3:9000: runtime error":                    "panic serving <address>: runtime error",
		"reading preface from client [::1]:5000: EOF":                   "reading preface from client [<address>]:5000: EOF",
		"net 2001:db8::, and error:203.0.113.9:80:":                     "net <address>, and error:<address>:",
		"/api/channels/" + id + "/voice":                                "/api/channels/<id>/voice",
		"device " + id + "." + id:                                       "device <id>.<id>",
		"at 12:34:56.789, in 1.27.4, code 0xc000123456, server.go:1964": "at 12:34:56.789, in 1.27.4, code 0xc000123456, server.go:1964",
		"a short id 6f1c2a9e0b7d":                                       "a short id 6f1c2a9e0b7d",
	}
	for in, want := range cases {
		if got := Scrub(in); got != want {
			t.Errorf("Scrub(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

// An http.Server with HTTPErrors writes net/http's own errors without who caused them.
func TestHTTPErrorsSaysNothingOfTheCaller(t *testing.T) {
	var out bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&out, nil)))
	defer slog.SetDefault(previous)

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	server.Config.ErrorLog = HTTPErrors()
	server.StartTLS()
	// Plain text where a TLS handshake should be.
	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	conn.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	conn.Read(make([]byte, 512))
	conn.Close()
	// One the client gives up on.
	client, err := tls.Dial("tcp", server.Listener.Addr().String(), &tls.Config{})
	if err == nil {
		client.Close()
	}
	server.Close()

	logged := out.String()
	if !strings.Contains(logged, "TLS handshake error") {
		t.Fatalf("nothing was logged, so nothing was checked: %q", logged)
	}
	if strings.Contains(logged, "127.0.0.1") {
		t.Fatalf("the caller's address was logged: %q", logged)
	}
}

// Every http.Server in the programs logs through HTTPErrors.
func TestEveryServerLogsThroughHTTPErrors(t *testing.T) {
	found := 0
	err := filepath.WalkDir("../..", func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && (entry.Name() == "node_modules" || strings.HasPrefix(entry.Name(), ".")) && path != "../.." {
			return filepath.SkipDir
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			literal, ok := node.(*ast.CompositeLit)
			if !ok {
				return true
			}
			name, ok := literal.Type.(*ast.SelectorExpr)
			if !ok || name.Sel.Name != "Server" {
				return true
			}
			if pkg, ok := name.X.(*ast.Ident); !ok || pkg.Name != "http" {
				return true
			}
			found++
			for _, element := range literal.Elts {
				if field, ok := element.(*ast.KeyValueExpr); ok {
					if key, ok := field.Key.(*ast.Ident); ok && key.Name == "ErrorLog" && isHTTPErrors(field.Value) {
						return true
					}
				}
			}
			t.Errorf("%s: an http.Server without ErrorLog: logs.HTTPErrors()", path)
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if found < 5 {
		t.Fatalf("found %d servers, so the search looked in the wrong place", found)
	}
}

func isHTTPErrors(value ast.Expr) bool {
	call, ok := value.(*ast.CallExpr)
	if !ok {
		return false
	}
	name, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || name.Sel.Name != "HTTPErrors" {
		return false
	}
	pkg, ok := name.X.(*ast.Ident)
	return ok && pkg.Name == "logs"
}
