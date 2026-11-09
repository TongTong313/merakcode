package sandbox

import (
	"io"
	"os"
	"sync"

	"golang.org/x/sys/windows"
)

type windowsStreams struct {
	child  [3]*os.File
	parent [3]*os.File
	out    sync.WaitGroup
}

func newWindowsStreams() (*windowsStreams, error) {
	s := new(windowsStreams)
	for i := range s.child {
		read, write, err := os.Pipe()
		if err != nil {
			s.close()
			return nil, err
		}
		if i == 0 {
			s.child[i], s.parent[i] = read, write
		} else {
			s.child[i], s.parent[i] = write, read
		}
	}
	return s, nil
}

func (s *windowsStreams) forward() {
	for _, file := range s.child {
		file.Close()
	}
	go func() { io.Copy(s.parent[0], os.Stdin); s.parent[0].Close() }()
	s.out.Add(2)
	go func() { defer s.out.Done(); io.Copy(os.Stdout, s.parent[1]) }()
	go func() { defer s.out.Done(); io.Copy(os.Stderr, s.parent[2]) }()
}

func (s *windowsStreams) close() {
	for i := range s.child {
		if s.child[i] != nil {
			s.child[i].Close()
		}
		if s.parent[i] != nil {
			s.parent[i].Close()
		}
	}
}

func windowsConsoleInput() (bool, func()) {
	handle := windows.Handle(os.Stdin.Fd())
	var mode uint32
	if windows.GetConsoleMode(handle, &mode) != nil {
		return false, func() {}
	}
	if windows.SetConsoleMode(handle, (mode & ^uint32(windows.ENABLE_LINE_INPUT|windows.ENABLE_ECHO_INPUT|windows.ENABLE_PROCESSED_INPUT))|windows.ENABLE_VIRTUAL_TERMINAL_INPUT) != nil {
		return false, func() {}
	}
	return true, func() { windows.SetConsoleMode(handle, mode) }
}

func windowsMemberConsole() (windows.Handle, func(), error) {
	inputRead, inputWrite, err := os.Pipe()
	if err != nil {
		return 0, nil, err
	}
	defer inputRead.Close()
	outputRead, outputWrite, err := os.Pipe()
	if err != nil {
		inputWrite.Close()
		return 0, nil, err
	}
	defer outputWrite.Close()
	var console windows.Handle
	if err := windows.CreatePseudoConsole(windows.Coord{X: 80, Y: 24}, windows.Handle(inputRead.Fd()), windows.Handle(outputWrite.Fd()), 0, &console); err != nil {
		inputWrite.Close()
		outputRead.Close()
		return 0, nil, err
	}
	go func() { io.Copy(inputWrite, os.Stdin); inputWrite.Close() }()
	drained := make(chan struct{})
	go func() { io.Copy(os.Stdout, outputRead); close(drained) }()
	return console, func() {
		inputWrite.Close()
		windows.ClosePseudoConsole(console)
		outputRead.Close()
		<-drained
	}, nil
}
