package event

import (
	"crypto/rand"
	"time"
)

// NewID encodes a millisecond timestamp and 80 random bits as a ULID.
func NewID() ID {
	var data [16]byte
	_, _ = rand.Read(data[6:])
	millis := uint64(time.Now().UnixMilli())
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
