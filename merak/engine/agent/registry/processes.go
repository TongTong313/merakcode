package registry

import (
	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (e *Registry) RegisterMCPProcess(session event.ID, process *mcp.Process) {
	e.sandboxMu.Lock()
	defer e.sandboxMu.Unlock()
	if e.mcpProcesses == nil {
		e.mcpProcesses = make(map[event.ID][]*mcp.Process)
	}
	e.mcpProcesses[session] = append(e.mcpProcesses[session], process)
}

// TakeMCPProcesses removes the processes of one session, or every session when the id is empty.
func (e *Registry) TakeMCPProcesses(session event.ID) []*mcp.Process {
	e.sandboxMu.Lock()
	defer e.sandboxMu.Unlock()
	var processes []*mcp.Process
	for id, live := range e.mcpProcesses {
		if session == "" || id == session {
			processes = append(processes, live...)
			delete(e.mcpProcesses, id)
		}
	}
	return processes
}
