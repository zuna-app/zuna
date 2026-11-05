package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLiveKitKeysAreMadeOnceAndKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.yaml")
	key, secret, err := liveKitKeys(path)
	if err != nil {
		t.Fatal(err)
	}
	if key != "zuna" || len(secret) != 64 {
		t.Fatalf("made %q with a secret of %d characters, want zuna and 64", key, len(secret))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// LiveKit won't start with a key file others may read.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("the key file is %v, want only its owner to read it", info.Mode().Perm())
	}
	again, secretAgain, err := liveKitKeys(path)
	if err != nil {
		t.Fatal(err)
	}
	if again != key || secretAgain != secret {
		t.Fatal("the next start made a new secret, which LiveKit wouldn't know")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("left %d files behind, want only the key file", len(entries))
	}
}

func TestLiveKitKeysAreReadFromLiveKitsOwnFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.yaml")
	if err := os.WriteFile(path, []byte("# Made by hand.\n\napi-key:  a-secret-of-at-least-thirty-two-characters\nother: ignored\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	key, secret, err := liveKitKeys(path)
	if err != nil {
		t.Fatal(err)
	}
	if key != "api-key" || secret != "a-secret-of-at-least-thirty-two-characters" {
		t.Fatalf("read %q and %q", key, secret)
	}

	for _, broken := range []string{"", "# Nothing but a comment.\n", "no colon here\n", "key:\n"} {
		if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := liveKitKeys(path); err == nil {
			t.Fatalf("took %q as a key file", broken)
		}
	}
}
