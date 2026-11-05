package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"time"
)

// certificateKeyFile holds the key of the certificate a server reached by its IP
// address makes for itself. The pin in its links is a hash of that key, so losing
// the file locks every app out until it gets a new link.
const certificateKeyFile = "certificate.key"

// ownCertificate is the certificate of a server reached by its IP address, which no
// authority will vouch for, so the server makes it itself. The apps trust it because
// its key matches the pin in the server's links: the SHA-256 of the key's
// SubjectPublicKeyInfo, in base64url. The key is made once and kept, and the
// certificate is made again from it at each start, so the pin never changes.
func ownCertificate(keyPath string, ip net.IP) (tls.Certificate, string, error) {
	key, err := certificateKey(keyPath)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, "", err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: ip.String()},
		IPAddresses:  []net.IP{ip},
		NotBefore:    now.Add(-time.Hour),
		// The apps go by the pin, not the dates, but Apple's own rules for a
		// certificate allow no more than 825 days.
		NotAfter:    now.Add(397 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, "", fmt.Errorf("making the certificate: %w", err)
	}
	pin, err := keyPin(&key.PublicKey)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pin, nil
}

// keyPin is what the apps check a server's certificate against.
func keyPin(key *ecdsa.PublicKey) (string, error) {
	spki, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(spki)
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// certificateKey reads the key, or makes it the first time. A key that's there but
// can't be read stops the server, since a new one would lock everyone out.
func certificateKey(path string) (*ecdsa.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		// P-256, which every app checks the same way.
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		der, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			return nil, err
		}
		if err := writeKeys(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})); err != nil {
			return nil, fmt.Errorf("saving the certificate's key: %w", err)
		}
		return key, nil
	} else if err != nil {
		return nil, fmt.Errorf("reading the certificate's key: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "EC PRIVATE KEY" {
		return nil, fmt.Errorf("%s isn't this server's certificate key. Restore it from a backup: a new one would need a new link for every app", path)
	}
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil || key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("%s isn't this server's certificate key. Restore it from a backup: a new one would need a new link for every app", path)
	}
	return key, nil
}

// urlHost writes an address as it goes in a link, with an IPv6 one in brackets.
func urlHost(ip net.IP) string {
	if ip.To4() == nil {
		return "[" + ip.String() + "]"
	}
	return ip.String()
}
