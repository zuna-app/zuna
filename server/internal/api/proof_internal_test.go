package api

import (
	"encoding/binary"
	"testing"
	"time"
)

// Z-81: the memory of signatures seen is never a reason to refuse everyone. Full, it lets
// its oldest go, and one owner over its share is refused alone.
func TestTheMemoryOfSignaturesNeverRefusesForBeingFull(t *testing.T) {
	now := time.Now()
	signature := func(n int) []byte { return binary.BigEndian.AppendUint64(nil, uint64(n)) }

	seals := seenProofs{most: 100}
	for n := range 1000 {
		if fresh, flooded := seals.first("", signature(n), now); !fresh || flooded {
			t.Fatalf("seal %d of a flood was refused", n)
		}
	}
	if len(seals.seen) != 100 || len(seals.order) != 100 || seals.held[""] != 100 {
		t.Fatalf("it holds %d, %d in order and %d of the owner", len(seals.seen), len(seals.order), seals.held[""])
	}
	// One of the newest is still known, and one that was let go isn't.
	if fresh, _ := seals.first("", signature(999), now); fresh {
		t.Fatal("a seal sent again was taken")
	}
	if fresh, _ := seals.first("", signature(0), now); !fresh {
		t.Fatal("the oldest wasn't let go")
	}

	proofs := seenProofs{most: 100, mostOfOne: 10}
	for n := range 10 {
		if fresh, flooded := proofs.first("flooding", signature(n), now); !fresh || flooded {
			t.Fatalf("proof %d was refused", n)
		}
	}
	if fresh, flooded := proofs.first("flooding", signature(10), now); fresh || !flooded {
		t.Fatal("a device over its share was taken")
	}
	// Nobody else is refused for it, and one sent again still is.
	if fresh, flooded := proofs.first("another", signature(11), now); !fresh || flooded {
		t.Fatal("another device was refused for the first one's flood")
	}
	if fresh, flooded := proofs.first("another", signature(11), now); fresh || flooded {
		t.Fatal("a proof sent again was taken")
	}
	// Once they're too old to be accepted anyway, they're forgotten, and the device has its share again.
	later := now.Add(2*proofWindow + time.Second)
	if fresh, flooded := proofs.first("flooding", signature(12), later); !fresh || flooded {
		t.Fatal("a device was still held to proofs that had grown old")
	}
	if len(proofs.seen) != 1 || len(proofs.held) != 1 {
		t.Fatalf("it still holds %d of %d owners", len(proofs.seen), len(proofs.held))
	}
}
