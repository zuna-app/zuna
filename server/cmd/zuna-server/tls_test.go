package main

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/acme/autocert"
)

// The server's own TLS agrees on keys with ML-KEM-768 and X25519 together, with any client that
// offers them, and still with X25519 alone with one that doesn't.
func TestTLSAgreesOnKeysWithMLKEM(t *testing.T) {
	certificate, _, err := ownCertificate(filepath.Join(t.TempDir(), "key"), net.ParseIP("127.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.TLS = serverTLS(certificate)
	server.StartTLS()
	defer server.Close()
	agreed := func(curves []tls.CurveID) tls.CurveID {
		t.Helper()
		conn, err := tls.Dial("tcp", server.Listener.Addr().String(), &tls.Config{InsecureSkipVerify: true, CurvePreferences: curves})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		return conn.ConnectionState().CurveID
	}
	if curve := agreed(nil); curve != tls.X25519MLKEM768 {
		t.Errorf("a client with Go's defaults agreed on %v", curve)
	}
	if curve := agreed([]tls.CurveID{tls.X25519MLKEM768}); curve != tls.X25519MLKEM768 {
		t.Errorf("a client offering only X25519MLKEM768 agreed on %v", curve)
	}
	if curve := agreed([]tls.CurveID{tls.X25519}); curve != tls.X25519 {
		t.Errorf("a client that doesn't know ML-KEM agreed on %v", curve)
	}
	// What a domain's certificate comes with leaves Go's choice of keys as it is too.
	if (&autocert.Manager{}).TLSConfig().CurvePreferences != nil || serverTLS(nil).CurvePreferences != nil {
		t.Error("a TLS configuration narrows the keys agreed on")
	}
}
