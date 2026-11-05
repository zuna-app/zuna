package main

import (
	"crypto/ecdsa"
	"crypto/x509"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestOwnCertificateKeepsItsPin(t *testing.T) {
	path := filepath.Join(t.TempDir(), certificateKeyFile)
	ip := net.ParseIP("192.168.1.10")
	certificate, pin, err := ownCertificate(path, ip)
	if err != nil {
		t.Fatal(err)
	}
	first, err := certificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(pin) != 43 {
		t.Fatalf("the pin is %q, want SHA-256 in base64url without padding", pin)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("the key file is %v, want only its owner to read it", info.Mode().Perm())
	}

	leaf, err := x509.ParseCertificate(first.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(leaf.IPAddresses) != 1 || !leaf.IPAddresses[0].Equal(ip) {
		t.Fatalf("the certificate names %v, want %v", leaf.IPAddresses, ip)
	}
	// What the apps hash: the key as the certificate carries it.
	own, err := keyPin(leaf.PublicKey.(*ecdsa.PublicKey))
	if err != nil || own != pin {
		t.Fatalf("the certificate's key hashes to %q, but its links carry %q", own, pin)
	}

	// A refusal Chromium remembers is for one certificate, so each connection gets another.
	second, err := certificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(second.Certificate[0]) == string(first.Certificate[0]) {
		t.Fatal("two connections got the same certificate")
	}
	_, again, err := ownCertificate(path, ip)
	if err != nil {
		t.Fatal(err)
	}
	if again != pin {
		t.Fatal("the next start changed the pin, which would lock every app out")
	}
}

func TestOwnCertificateRefusesADamagedKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), certificateKeyFile)
	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ownCertificate(path, net.ParseIP("2001:db8::1")); err == nil {
		t.Fatal("made a new key in place of one it couldn't read, which would lock every app out")
	}
	if data, _ := os.ReadFile(path); string(data) != "not a key" {
		t.Fatal("overwrote the damaged key, which a backup could still replace")
	}
}

func TestURLHostBracketsIPv6(t *testing.T) {
	if got := urlHost(net.ParseIP("2001:db8::1")); got != "[2001:db8::1]" {
		t.Fatalf("got %q", got)
	}
	if got := urlHost(net.ParseIP("10.0.0.2")); got != "10.0.0.2" {
		t.Fatalf("got %q", got)
	}
}
