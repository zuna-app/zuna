package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// liveKitKeys reads the API key and secret this server shares with LiveKit from
// LiveKit's own key file, of lines like "key: secret". The first time, there's no
// file, so it makes one with a new secret, and the two agree on it without anybody
// choosing one. LiveKit refuses a key file others may read, so only this account may.
func liveKitKeys(path string) (key, secret string, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		random := make([]byte, 32)
		rand.Read(random)
		data = []byte("zuna: " + hex.EncodeToString(random) + "\n")
		if err := writeKeys(path, data); err != nil {
			return "", "", fmt.Errorf("making LiveKit's key file: %w", err)
		}
	} else if err != nil {
		return "", "", fmt.Errorf("reading LiveKit's key file: %w", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, secret, found := strings.Cut(line, ":")
		key, secret = strings.TrimSpace(key), strings.TrimSpace(secret)
		if !found || key == "" || secret == "" {
			return "", "", fmt.Errorf("%s isn't LiveKit's key file, of lines like \"key: secret\"", path)
		}
		return key, secret, nil
	}
	return "", "", fmt.Errorf("%s has no key in it", path)
}

// writeKeys puts the file in place whole, so a start cut short leaves none rather
// than half of one.
func writeKeys(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".keys-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
