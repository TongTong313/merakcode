package event

import (
	"crypto/rand"
	"sync"
	"time"
)

var ids struct {
	sync.Mutex
	millis uint64
	random [10]byte
}

// NewID encodes a millisecond timestamp and 80 random bits as a ULID. Identifiers made by one process grow strictly,
// also within one millisecond and when the clock goes back: then the random part of the last one is counted up.
func NewID() ID {
	var data [16]byte
	ids.Lock()
	millis := uint64(time.Now().UnixMilli())
	if millis > ids.millis {
		ids.millis = millis
		_, _ = rand.Read(ids.random[:])
		// Keep the top bit clear so that counting up within a millisecond cannot run out of room.
		ids.random[0] &= 0x7f
	} else {
		for i := len(ids.random) - 1; i >= 0; i-- {
			ids.random[i]++
			if ids.random[i] != 0 {
				break
			}
			if i == 0 {
				ids.millis++
			}
		}
	}
	millis = ids.millis
	copy(data[6:], ids.random[:])
	ids.Unlock()
	for i := 5; i >= 0; i-- {
		data[i] = byte(millis)
		millis >>= 8
	}
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	var encoded [26]byte
	var value uint32
	bits, index := 2, 0
	for _, b := range data {
		value = value<<8 | uint32(b)
		bits += 8
		for bits >= 5 {
			bits -= 5
			encoded[index] = alphabet[(value>>bits)&31]
			index++
		}
	}
	return ID(encoded[:])
}
